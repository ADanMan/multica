export const RENDERER_ROUTE_CONTEXT_CHANNEL = "renderer:route-context";

export type RendererRouteSurface = "login" | "overlay" | "tab";

// This context exists only to be attached to a freeze/crash report, and those
// reports leave the machine. Every field here must therefore be safe to ship:
// route TEMPLATES (`/:slug/issues/:id`) and our own operation labels, never a
// workspace slug, tab id, or any other raw identifier. Keeping the raw values
// out at the source is what makes the egress side impossible to get wrong.
export type RendererRouteContextInput = {
  surface: RendererRouteSurface;
  /** Bucketed route template. Must not contain slugs or resource ids. */
  path: string;
  /**
   * Name of the heavy synchronous operation in flight, if the renderer
   * declared one. The main process can't ask a hung renderer what it was
   * doing, so this rides along with the route and is read back from whatever
   * was last received.
   */
  operation?: string;
};

export type RendererRouteContext = RendererRouteContextInput & {
  reportedAt: string;
};

const MAX_ROUTE_CONTEXT_STRING_LENGTH = 512;

export function sanitizeRendererRouteContext(
  value: unknown,
  reportedAt = new Date(),
): RendererRouteContext | null {
  if (!value || typeof value !== "object") return null;

  const input = value as Record<string, unknown>;
  if (!isRendererRouteSurface(input.surface)) return null;

  const path = sanitizeString(input.path);
  if (!path) return null;

  const operation = sanitizeString(input.operation);

  // Explicit construction, not a spread of `input`: an unknown key sent by a
  // renderer (a stale build, a future field) must never survive into a report.
  return {
    surface: input.surface,
    path,
    ...(operation ? { operation } : {}),
    reportedAt: reportedAt.toISOString(),
  };
}

function isRendererRouteSurface(value: unknown): value is RendererRouteSurface {
  return value === "login" || value === "overlay" || value === "tab";
}

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_ROUTE_CONTEXT_STRING_LENGTH);
}
