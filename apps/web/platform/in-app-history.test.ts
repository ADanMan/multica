import { describe, expect, it } from "vitest";
import { createInAppHistoryTracker, probeNavigationApi } from "./in-app-history";

describe("createInAppHistoryTracker", () => {
  it("trusts the Navigation API when the browser exposes it", () => {
    expect(createInAppHistoryTracker(() => true).canGoBack()).toBe(true);
    // False even though nothing was pushed is the point: arriving from an
    // external site leaves same-origin history empty.
    expect(createInAppHistoryTracker(() => false).canGoBack()).toBe(false);
  });

  it("ignores its own push count once the Navigation API answers", () => {
    const tracker = createInAppHistoryTracker(() => false);
    tracker.recordPush();

    expect(tracker.canGoBack()).toBe(false);
  });

  it("reports nothing to go back to before any in-app push", () => {
    expect(createInAppHistoryTracker(() => undefined).canGoBack()).toBe(false);
  });

  it("reports history once the adapter has pushed in this document", () => {
    const tracker = createInAppHistoryTracker(() => undefined);
    tracker.recordPush();

    expect(tracker.canGoBack()).toBe(true);
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
