// JS call stack capture for a hung renderer (MUL-5345).
//
// When the renderer stops responding, the main process is still alive but has
// no way to ask the renderer anything — the thread that would answer is the
// thread that is stuck. The one channel that still gets through is the Chrome
// DevTools Protocol, and only if it was already open: attaching after the hang
// starts does not get dispatched. So the channel is warmed at window creation
// and `Debugger.pause` is sent when the hang is detected.
//
// Measured on Electron 39.8.7 / Chromium 142 (spike, MUL-5345):
//   * pause during a 12s synchronous block returned the stack in 2ms, top
//     frame correctly identified as the blocking function;
//   * keeping the channel warm for the whole session showed no benchmark cost
//     beyond run-to-run noise;
//   * DevTools and this channel coexist in both open orders — opening DevTools
//     does not evict us, and pause keeps working afterwards.
//
// PRIVACY — hard constraints:
//
//   * CDP ALLOWLIST: only the four `Debugger` verbs below may ever be sent.
//     Every command goes through `sendDebuggerCommand`, which throws on
//     anything else. `Runtime.evaluate` / `Runtime.getProperties` /
//     `Runtime.callFunctionOn` (arbitrary reads), `HeapProfiler.*` (heap
//     contents), and `Debugger.setBreakpoint*` are forbidden.
//   * CODE LOCATIONS ONLY: a paused frame also carries `scopeChain` handles
//     that can be dereferenced into live user data. We copy four scalar fields
//     per frame and drop everything else, so no such handle is ever retained.
//   * URLs are reduced to their bundle-relative tail — the absolute path can
//     contain the OS username.
//   * BEST EFFORT: every failure resolves to null. A diagnostic must never be
//     the reason the app stays broken.

/** Minimal CDP debugger surface — matches Electron's `webContents.debugger`. */
export interface CdpDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  on(
    event: "message",
    listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
  ): unknown;
  off(
    event: "message",
    listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
  ): unknown;
}

/** The only CDP commands this module is permitted to send. */
export const ALLOWED_CDP_METHODS = [
  "Debugger.enable",
  "Debugger.disable",
  "Debugger.pause",
  "Debugger.resume",
] as const;

export interface HangStackFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface CaptureHangStackOptions {
  /** Give up waiting for `Debugger.paused` after this long. */
  timeoutMs?: number;
  /** Deepest frames are the least useful; keep the top of the stack. */
  maxFrames?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_FRAMES = 20;

/**
 * Send a single CDP command, enforcing the allowlist. This is the ONLY path to
 * `debugger.sendCommand` in this module — nothing here may call `sendCommand`
 * directly. Rejects for any other method so a forbidden command fails loudly
 * in tests rather than silently exfiltrating.
 */
export function sendDebuggerCommand(
  dbg: CdpDebugger,
  method: string,
): Promise<unknown> {
  if (!(ALLOWED_CDP_METHODS as readonly string[]).includes(method)) {
    return Promise.reject(
      new Error(
        `Forbidden CDP method "${method}": hang stack capture may only send ${ALLOWED_CDP_METHODS.join(" / ")}`,
      ),
    );
  }
  return dbg.sendCommand(method);
}

/**
 * Open the debugger channel for this renderer. Must run while the renderer is
 * healthy — that is the entire point. Returns whether the channel is usable.
 */
export async function warmDebuggerChannel(dbg: CdpDebugger): Promise<boolean> {
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
    await sendDebuggerCommand(dbg, "Debugger.enable");
    return true;
  } catch {
    // Another client owns the debugger, or the renderer is already gone.
    return false;
  }
}

/**
 * Interrupt the hung renderer, read the JS call stack, and let it run again.
 *
 * Resume is unconditional: a pause we requested and failed to clear would turn
 * a recoverable hang into a permanent one, which is far worse than having no
 * stack. Returns null whenever a stack could not be obtained.
 */
export async function captureHangStack(
  dbg: CdpDebugger,
  options: CaptureHangStackOptions = {},
): Promise<HangStackFrame[] | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;

  if (!dbg.isAttached()) return null;

  let onMessage:
    | ((event: unknown, method: string, params: Record<string, unknown>) => void)
    | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const paused = new Promise<HangStackFrame[] | null>((resolve) => {
      onMessage = (_event, method, params) => {
        if (method !== "Debugger.paused") return;
        resolve(sanitizeCallFrames(params.callFrames, maxFrames));
      };
      dbg.on("message", onMessage);
      timer = setTimeout(() => resolve(null), timeoutMs);
    });

    await sendDebuggerCommand(dbg, "Debugger.pause");
    return await paused;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (onMessage) {
      try {
        dbg.off("message", onMessage);
      } catch {
        // Listener cleanup is best-effort.
      }
    }
    try {
      await sendDebuggerCommand(dbg, "Debugger.resume");
    } catch {
      // The renderer may already be gone; nothing left to resume.
    }
  }
}

/**
 * Copy the four scalar fields we report and drop everything else the protocol
 * sends — notably `scopeChain`, whose object handles could be dereferenced
 * into user data.
 */
export function sanitizeCallFrames(
  rawFrames: unknown,
  maxFrames: number,
): HangStackFrame[] | null {
  if (!Array.isArray(rawFrames) || rawFrames.length === 0) return null;

  const frames: HangStackFrame[] = [];
  for (const raw of rawFrames.slice(0, maxFrames)) {
    if (!raw || typeof raw !== "object") continue;
    const frame = raw as Record<string, unknown>;
    const location = (frame.location ?? {}) as Record<string, unknown>;
    frames.push({
      functionName:
        typeof frame.functionName === "string" && frame.functionName
          ? frame.functionName
          : "(anonymous)",
      url: redactFrameUrl(frame.url),
      lineNumber: toNumber(location.lineNumber),
      columnNumber: toNumber(location.columnNumber),
    });
  }
  return frames.length > 0 ? frames : null;
}

/**
 * Keep only the bundle-relative tail of a script URL. The full value is a
 * `file://` path into the install location and can carry the OS username.
 */
export function redactFrameUrl(url: unknown): string {
  if (typeof url !== "string" || !url) return "";
  const [withoutQuery = ""] = url.split(/[?#]/);
  const segments = withoutQuery.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  return segments.slice(-2).join("/");
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
