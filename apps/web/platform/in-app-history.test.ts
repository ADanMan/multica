import { describe, expect, it } from "vitest";
import { createInAppHistoryTracker, probeNavigationApi } from "./in-app-history";

describe("createInAppHistoryTracker", () => {
  it("trusts the Navigation API when the browser exposes it", () => {
    expect(createInAppHistoryTracker(() => true).canGoBack()).toBe(true);
    // False even though nothing was pushed is the point: arriving from an
    // external site leaves same-origin history empty.
    expect(createInAppHistoryTracker(() => false).canGoBack()).toBe(false);
  });

  it("ignores its own depth once the Navigation API answers", () => {
    const tracker = createInAppHistoryTracker(() => false);
    tracker.recordPush();

    expect(tracker.canGoBack()).toBe(false);
  });

  describe("without the Navigation API", () => {
    const makeTracker = () => createInAppHistoryTracker(() => undefined);

    it("reports nothing to go back to before any in-app push", () => {
      expect(makeTracker().canGoBack()).toBe(false);
    });

    it("reports history once the adapter has pushed in this document", () => {
      const tracker = makeTracker();
      tracker.recordPush();

      expect(tracker.canGoBack()).toBe(true);
    });

    // Regression: the depth used to only ever grow, so this sequence left the
    // user on the document's first entry still claiming a page behind it —
    // and `back()` would then step off Multica entirely.
    it("reports no history after a push is undone by a browser Back", () => {
      const tracker = makeTracker();
      tracker.recordPush();
      tracker.recordTraversal();

      expect(tracker.canGoBack()).toBe(false);
    });

    it("stays negative-proof across more traversals than pushes", () => {
      const tracker = makeTracker();
      tracker.recordPush();
      tracker.recordTraversal();
      tracker.recordTraversal();
      tracker.recordTraversal();

      expect(tracker.canGoBack()).toBe(false);

      // One push must be enough to make it answer again — a clamped-out
      // counter that had gone deeply negative would swallow it.
      tracker.recordPush();
      expect(tracker.canGoBack()).toBe(true);
    });

    it("keeps reporting history while pushes outnumber traversals", () => {
      const tracker = makeTracker();
      tracker.recordPush();
      tracker.recordPush();
      tracker.recordTraversal();

      expect(tracker.canGoBack()).toBe(true);
    });

    // Forward re-enters an entry that does have a page behind it, but we
    // cannot tell forward from back without the Navigation API. Reporting
    // "no history" here costs a legitimate back() and is the safe direction.
    it("is conservative after a browser Forward", () => {
      const tracker = makeTracker();
      tracker.recordPush();
      tracker.recordTraversal(); // back
      tracker.recordTraversal(); // forward

      expect(tracker.canGoBack()).toBe(false);
    });
  });
});

describe("probeNavigationApi", () => {
  it("returns undefined when the browser has no Navigation API", () => {
    // jsdom ships no `window.navigation`, which is the fallback path itself.
    expect(probeNavigationApi()).toBeUndefined();
  });

  it("reads canGoBack when the Navigation API is present", () => {
    const win = window as unknown as { navigation?: unknown };
    win.navigation = { canGoBack: true };
    try {
      expect(probeNavigationApi()).toBe(true);
    } finally {
      delete win.navigation;
    }
  });

  it("ignores a `navigation` global that is not the Navigation API", () => {
    const win = window as unknown as { navigation?: unknown };
    win.navigation = { somethingElse: true };
    try {
      expect(probeNavigationApi()).toBeUndefined();
    } finally {
      delete win.navigation;
    }
  });
});
