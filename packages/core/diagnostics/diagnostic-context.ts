// Where the app thinks it is — the one field a freeze report is useless
// without.
//
// Desktop runs a memory router, so `location.pathname` in the renderer is the
// packaged `index.html` file path and can never identify the visible page. The
// desktop shell publishes its bucketed route here; the freeze watchdog reads it
// so an in-thread freeze event carries a real route. Web sets nothing and keeps
// using `location.pathname`.

let route: string | null = null;

/** Longest route we keep; these are our own short templates. */
const MAX_ROUTE_LENGTH = 256;

/**
 * Publish the current app route, already bucketed to a template — see
 * `bucketDiagnosticPath`. Pass null when leaving a known route.
 */
export function setDiagnosticRoute(next: string | null): void {
  if (typeof next !== "string") {
    route = null;
    return;
  }
  const trimmed = next.trim();
  route = trimmed ? trimmed.slice(0, MAX_ROUTE_LENGTH) : null;
}

export function getDiagnosticRoute(): string | null {
  return route;
}

/** Test seam: drop state so cases don't leak into each other. */
export function resetDiagnosticContext(): void {
  route = null;
}

/**
 * Collapse a concrete path to a route template: `/acme/issues/MUL-12` becomes
 * `/:slug/issues/:id`. Diagnostics only need to know which screen the user was
 * on, and a template keeps resource identifiers out of telemetry while making
 * the field groupable in one query.
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
