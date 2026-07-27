// Where the app thinks it is, and what it was about to do — the two fields a
// freeze report is useless without.
//
// Desktop runs a memory router, so `location.pathname` in the renderer is the
// packaged `index.html` file path and can never identify the visible page. The
// desktop shell pushes its bucketed route here; the freeze watchdog reads it so
// an in-thread freeze event carries a real route. Web sets nothing and keeps
// using `location.pathname`.
//
// The operation marker is the cheap counterpart to a profiler: code about to
// run a known-heavy synchronous block names itself first, so a report can say
// "froze while parsing a large markdown document" even when no stack was
// captured. Only the last mark is kept — this is a "what was in flight", not a
// trace.

export type DiagnosticContextListener = (context: DiagnosticContext) => void;

export interface DiagnosticContext {
  route: string | null;
  operation: string | null;
}

let route: string | null = null;
let operation: string | null = null;
let operationMarkedAt: number | null = null;
let listener: DiagnosticContextListener | null = null;

/** Longest value we keep for either field; both are our own short labels. */
const MAX_VALUE_LENGTH = 256;

/**
 * Publish the current app route (already bucketed to a template — see
 * `bucketDiagnosticPath`). Pass null when leaving a known route.
 */
export function setDiagnosticRoute(next: string | null): void {
  const sanitized = sanitize(next);
  if (sanitized === route) return;
  route = sanitized;
  notify();
}

/**
 * Name the heavy synchronous operation about to run. Call it immediately
 * before the work, not after — the point is for the label to be in place while
 * the thread is blocked.
 */
export function markDiagnosticOperation(next: string | null): void {
  const sanitized = sanitize(next);
  // Re-stamp even when the label repeats: the age is what tells a reader
  // whether the freeze happened during this operation or long after it.
  operationMarkedAt = sanitized === null ? null : Date.now();
  if (sanitized === operation) return;
  operation = sanitized;
  notify();
}

/**
 * How long ago the current operation was marked, in ms. A large value means
 * the label is stale — the operation finished and nothing has been marked
 * since — so a freeze report can be read without assuming causation.
 */
export function getDiagnosticOperationAgeMs(now = Date.now()): number | null {
  if (operationMarkedAt === null) return null;
  return Math.max(0, now - operationMarkedAt);
}

export function getDiagnosticRoute(): string | null {
  return route;
}

export function getDiagnosticOperation(): string | null {
  return operation;
}

export function getDiagnosticContext(): DiagnosticContext {
  return { route, operation };
}

/**
 * Register the single consumer that mirrors this context out of the renderer
 * (desktop pushes it to the main process, which is the only party still alive
 * during a true hang). Passing null unregisters. Replacing an existing
 * listener is intentional — there is exactly one mirror per renderer.
 */
export function setDiagnosticContextListener(
  next: DiagnosticContextListener | null,
): void {
  listener = next;
}

/** Test seam: drop all state so cases don't leak into each other. */
export function resetDiagnosticContext(): void {
  route = null;
  operation = null;
  operationMarkedAt = null;
  listener = null;
}

function notify(): void {
  if (!listener) return;
  try {
    listener({ route, operation });
  } catch {
    // A broken mirror must never take down the code that was just about to do
    // the heavy work.
  }
}

function sanitize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_VALUE_LENGTH);
}

/**
 * Collapse a concrete path to a route template: `/acme/issues/MUL-12` becomes
 * `/:slug/issues/:id`. Diagnostics only ever need to know which screen the user
 * was on, and a template keeps resource identifiers out of telemetry while
 * making the field groupable in one query.
 */
export function bucketDiagnosticPath(path: string): string {
  const [pathname = ""] = path.split(/[?#]/);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  const bucketed = segments.map((segment, index) => {
    // The first segment of a workspace-scoped route is always the slug.
    if (index === 0 && !isGlobalRootSegment(segment)) return ":slug";
    return isResourceIdentifier(segment) ? ":id" : segment;
  });
  return `/${bucketed.join("/")}`;
}

// Pre-workspace routes are a closed set (see CLAUDE.md: single word or
// /{noun}/{verb}); everything else at the root position is a workspace slug.
const GLOBAL_ROOT_SEGMENTS = new Set([
  "login",
  "signup",
  "inbox",
  "invite",
  "invitations",
  "onboarding",
  "workspaces",
  "settings",
]);

function isGlobalRootSegment(segment: string): boolean {
  return GLOBAL_ROOT_SEGMENTS.has(segment);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Human-readable issue keys such as MUL-5345.
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

function isResourceIdentifier(segment: string): boolean {
  if (UUID_PATTERN.test(segment)) return true;
  if (ISSUE_KEY_PATTERN.test(segment)) return true;
  return /^\d+$/.test(segment);
}
