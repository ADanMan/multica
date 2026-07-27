// Client freeze watchdog — shared by web and desktop.
//
// Installs a long-frame observer in the main thread. The browser already
// tracks stretches where the thread didn't return to the event loop and
// delivers each entry once the thread unblocks, so even a multi-second freeze
// reports itself after the fact. We only emit at or above FREEZE_THRESHOLD_MS
// to keep this to genuine "almost froze" events, not normal render cost.
//
// Two entry types, in preference order:
//
//   1. `long-animation-frame` (LoAF) — carries per-script attribution:
//      function name, script URL, character position. This is what turns
//      "froze for 8s" into "froze in parseMarkdown". Preferred whenever the
//      engine supports it.
//   2. `longtask` — duration only. Fallback for engines without LoAF.
//
// Only one is observed: LoAF supersedes longtask and observing both would
// report the same freeze twice.
//
// This is the in-thread, recoverable tier: it catches freezes the thread
// survives. A true non-recoverable hang (the thread never unblocks) can only
// be caught from outside — on desktop that is the main process `unresponsive`
// handler (see apps/desktop renderer-recovery). Web has no free external
// watcher, so this observer is its only freeze signal for now.
//
// The emitted `client_unresponsive` event carries `client_type` automatically
// (an analytics super-property), so desktop vs web is queryable without any
// platform branch here.

import { captureEvent } from "../analytics";
import {
  getDiagnosticOperation,
  getDiagnosticOperationAgeMs,
  getDiagnosticRoute,
} from "./diagnostic-context";

// 2s is well above the normal switch/render cost (measured 50–600ms) and just
// under Electron's renderer-hang threshold, so an event here means "the user
// felt a real stall" without flooding on routine heavy renders.
const FREEZE_THRESHOLD_MS = 2000;

// A single sustained freeze is delivered by the browser as several separate
// entries, so emitting per entry makes client_unresponsive volume grow without
// bound with the freeze length (MUL-3331). A global cooldown caps it to at most
// one event per window. Module-level (page-lifetime) state is the right scope
// here — it matches the `installed` singleton and resets on a full reload,
// which is rare and itself a distinct signal.
const COOLDOWN_MS = 60_000;
let lastEmitMs = 0;

let installed = false;

/**
 * A LoAF script attribution entry. Not in the TS DOM lib yet, so the shape we
 * read is declared here and the entry is narrowed at the observer boundary.
 */
interface LongAnimationFrameScript {
  sourceFunctionName?: string;
  sourceURL?: string;
  sourceCharPosition?: number;
  invokerType?: string;
  duration?: number;
}

interface LongAnimationFrameEntry extends PerformanceEntry {
  blockingDuration?: number;
  scripts?: LongAnimationFrameScript[];
}

/**
 * Install the long-frame observer. Safe to call multiple times (idempotent) and
 * safe on the server (no-op when `window` / `PerformanceObserver` is absent).
 * Call once from a client-only effect.
 */
export function installFreezeWatchdog(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  if (typeof PerformanceObserver === "undefined") return;
  installed = true;

  // LoAF first: same signal, plus the attribution that makes it actionable.
  if (observeLongAnimationFrames()) return;
  observeLongTasks();
}

function observeLongAnimationFrames(): boolean {
  const supported = PerformanceObserver.supportedEntryTypes;
  if (!supported?.includes("long-animation-frame")) return false;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < FREEZE_THRESHOLD_MS) continue;
        if (!claimCooldown()) continue;
        const frame = entry as LongAnimationFrameEntry;
        emitFreeze({
          source: "loaf",
          duration_ms: Math.round(entry.duration),
          ...blockingDurationProps(frame),
          ...scriptAttributionProps(frame),
        });
      }
    });
    // No `buffered: true` — we only want freezes from now on. Replaying frames
    // buffered before install would mislabel slow startup as a runtime freeze.
    observer.observe({ type: "long-animation-frame" });
    return true;
  } catch {
    // Entry type advertised but not observable — fall back to longtask.
    return false;
  }
}

function observeLongTasks(): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < FREEZE_THRESHOLD_MS) continue;
        if (!claimCooldown()) continue;
        emitFreeze({
          source: "longtask",
          duration_ms: Math.round(entry.duration),
        });
      }
    });
    observer.observe({ type: "longtask" });
  } catch {
    // longtask entry type unsupported on this engine — nothing else to do.
  }
}

/**
 * Take the cooldown slot if it is free. Checked only against qualifying
 * freezes, so sub-threshold frames neither emit nor reset the window.
 */
function claimCooldown(): boolean {
  const now = Date.now();
  if (now - lastEmitMs < COOLDOWN_MS) return false;
  lastEmitMs = now;
  return true;
}

function emitFreeze(props: Record<string, unknown>): void {
  const operation = getDiagnosticOperation();
  const operationAgeMs = getDiagnosticOperationAgeMs();
  captureEvent("client_unresponsive", {
    ...props,
    path: resolveDiagnosticPath(),
    // The age keeps the label honest: a mark from ten minutes ago is context,
    // not the cause.
    ...(operation ? { last_operation: operation } : {}),
    ...(operation && operationAgeMs !== null
      ? { last_operation_age_ms: operationAgeMs }
      : {}),
  });
}

/**
 * The desktop shell publishes its memory-router route; web publishes nothing
 * and falls back to the real URL.
 */
function resolveDiagnosticPath(): string | undefined {
  const route = getDiagnosticRoute();
  if (route) return route;
  return typeof location !== "undefined" ? location.pathname : undefined;
}

function blockingDurationProps(
  frame: LongAnimationFrameEntry,
): Record<string, number> {
  return typeof frame.blockingDuration === "number"
    ? { blocking_duration_ms: Math.round(frame.blockingDuration) }
    : {};
}

/**
 * Fold the frame's most expensive script into flat event properties. Only the
 * longest one: a blocking frame usually has a single dominant script, and one
 * entry keeps the event shape flat and groupable.
 */
function scriptAttributionProps(
  frame: LongAnimationFrameEntry,
): Record<string, unknown> {
  const script = longestScript(frame.scripts);
  if (!script) return {};

  const url = redactScriptUrl(script.sourceURL);
  return {
    ...(script.sourceFunctionName
      ? { script_function: script.sourceFunctionName }
      : {}),
    ...(url ? { script_url: url } : {}),
    ...(typeof script.sourceCharPosition === "number" &&
    script.sourceCharPosition >= 0
      ? { script_char_position: script.sourceCharPosition }
      : {}),
    ...(script.invokerType ? { script_invoker_type: script.invokerType } : {}),
    ...(typeof script.duration === "number"
      ? { script_duration_ms: Math.round(script.duration) }
      : {}),
  };
}

function longestScript(
  scripts: LongAnimationFrameScript[] | undefined,
): LongAnimationFrameScript | null {
  if (!Array.isArray(scripts) || scripts.length === 0) return null;
  let longest: LongAnimationFrameScript | null = null;
  for (const script of scripts) {
    if (!script) continue;
    const duration = typeof script.duration === "number" ? script.duration : 0;
    const best = typeof longest?.duration === "number" ? longest.duration : -1;
    if (longest === null || duration > best) longest = script;
  }
  return longest;
}

/**
 * Keep only the tail of a script URL. On desktop the full value is a
 * `file://` path into the install location, which can carry the OS username
 * (`/Users/<name>/Applications/...`); the bundle-relative tail is what
 * identifies the code and is all we need.
 */
export function redactScriptUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const [withoutQuery = ""] = url.split(/[?#]/);
  const segments = withoutQuery.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  return segments.slice(-2).join("/");
}
