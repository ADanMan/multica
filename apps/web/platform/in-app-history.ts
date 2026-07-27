/**
 * "Is there a Multica page behind this one?" for the web navigation adapter.
 *
 * Callers that want to step back (deleting an issue returns the user to the
 * list they opened it from) must not step back off the app when the current
 * page was opened cold — a shared link, a pasted URL, a new tab. The browser
 * knows the answer; `history.length` does not, because it counts entries from
 * other origins too.
 *
 * The Navigation API answers exactly the right question: `entries()` spans
 * only the contiguous same-origin run around the current entry, so arriving
 * from an external site reports `canGoBack === false` even though the browser
 * technically has somewhere to go. Where it is unavailable we fall back to
 * counting the pushes this adapter performed in this document, which is zero
 * for every cold-open case.
 */

/** Minimal shape of the Navigation API — not in TypeScript's DOM lib yet. */
type NavigationApi = { canGoBack: boolean };

/** `undefined` when the browser can't tell us, so callers can fall back. */
export function probeNavigationApi(): boolean | undefined {
  if (typeof window === "undefined") return undefined;
  const navigation = (window as { navigation?: unknown }).navigation as
    | NavigationApi
    | undefined;
  return typeof navigation?.canGoBack === "boolean"
    ? navigation.canGoBack
    : undefined;
}

export function createInAppHistoryTracker(
  probe: () => boolean | undefined = probeNavigationApi,
) {
  let pushes = 0;
  return {
    /** Call for every in-app push; a push is what creates something to go back to. */
    recordPush(): void {
      pushes += 1;
    },
    canGoBack(): boolean {
      return probe() ?? pushes > 0;
    },
  };
}
