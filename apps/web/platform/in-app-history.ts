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
 * technically has somewhere to go.
 *
 * Where it is unavailable we track our own depth: how many in-app pushes are
 * still "below" the current entry. A push adds one; any history traversal
 * (browser Back/Forward, or our own `back()`) may have moved us off that
 * entry, so it takes one away. Since reaching the document's first entry
 * requires traversing back at least as many times as we pushed, a positive
 * depth can never be claimed while sitting on it — the failure direction is
 * always "report no history and use the fallback", never "step off the app".
 * Going forward again is the cost: the depth stays spent, so we fall back
 * where a step back would in fact have been fine.
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
  let depth = 0;
  return {
    /** An in-app push: the entry it creates has this page behind it. */
    recordPush(): void {
      depth += 1;
    },
    /**
     * A history traversal — `popstate`. We can't tell forward from back
     * without the Navigation API, so assume the direction that can only cost
     * us a `back()` we were entitled to, never one we weren't.
     */
    recordTraversal(): void {
      depth = Math.max(0, depth - 1);
    },
    canGoBack(): boolean {
      return probe() ?? depth > 0;
    },
  };
}
