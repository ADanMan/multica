import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../analytics", () => ({ captureEvent: vi.fn() }));

// A controllable PerformanceObserver stand-in: records the callback so a test
// can fire synthetic long-task entries, and counts constructions so we can
// assert idempotent install.
type FakeEntry = Record<string, unknown> & { duration: number };

let lastCallback: ((list: { getEntries: () => FakeEntry[] }) => void) | null;
let constructed: number;
let observedTypes: string[];

class FakePerformanceObserver {
  static supportedEntryTypes: string[] = [];
  constructor(cb: (list: { getEntries: () => FakeEntry[] }) => void) {
    constructed += 1;
    lastCallback = cb;
  }
  observe(options: { type: string }) {
    observedTypes.push(options.type);
  }
}

function fireEntry(entry: FakeEntry) {
  lastCallback?.({ getEntries: () => [entry] });
}

function fireLongTask(duration: number) {
  fireEntry({ duration });
}

async function load() {
  vi.resetModules();
  const mod = await import("./freeze-watchdog");
  const context = await import("./diagnostic-context");
  const { captureEvent } = await import("../analytics");
  return {
    installFreezeWatchdog: mod.installFreezeWatchdog,
    ...context,
    captureEvent: captureEvent as unknown as ReturnType<typeof vi.fn>,
  };
}

beforeEach(() => {
  lastCallback = null;
  constructed = 0;
  observedTypes = [];
  FakePerformanceObserver.supportedEntryTypes = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", { pathname: "/acme/issues" });
  vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("installFreezeWatchdog", () => {
  it("reports a long task at or above the 2s threshold with duration + path", async () => {
    const { installFreezeWatchdog, captureEvent } = await load();
    installFreezeWatchdog();

    fireLongTask(2300);

    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledWith("client_unresponsive", {
      source: "longtask",
      duration_ms: 2300,
      path: "/acme/issues",
    });
  });

  it("ignores blocks below the threshold (normal render cost)", async () => {
    const { installFreezeWatchdog, captureEvent } = await load();
    installFreezeWatchdog();

    fireLongTask(600);
    fireLongTask(1999);

    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("is idempotent — a second install does not add a second observer", async () => {
    const { installFreezeWatchdog } = await load();
    installFreezeWatchdog();
    installFreezeWatchdog();

    expect(constructed).toBe(1);
    expect(observedTypes).toEqual(["longtask"]);
  });

  it("is a no-op on the server (no window)", async () => {
    vi.stubGlobal("window", undefined);
    const { installFreezeWatchdog, captureEvent } = await load();

    expect(() => installFreezeWatchdog()).not.toThrow();
    expect(constructed).toBe(0);
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("is a no-op when PerformanceObserver is unavailable", async () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    const { installFreezeWatchdog } = await load();

    expect(() => installFreezeWatchdog()).not.toThrow();
  });

  it("emits at most one client_unresponsive per 60s cooldown window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { installFreezeWatchdog, captureEvent } = await load();
    installFreezeWatchdog();

    // A sustained freeze arrives as several long-task entries back to back.
    fireLongTask(2500);
    fireLongTask(2500);
    fireLongTask(3000);

    expect(captureEvent).toHaveBeenCalledTimes(1);
  });

  it("emits again only after the cooldown window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { installFreezeWatchdog, captureEvent } = await load();
    installFreezeWatchdog();

    fireLongTask(2500);
    expect(captureEvent).toHaveBeenCalledTimes(1);

    // Still inside the window → suppressed.
    vi.advanceTimersByTime(59_999);
    fireLongTask(2500);
    expect(captureEvent).toHaveBeenCalledTimes(1);

    // Window elapsed → emits again.
    vi.advanceTimersByTime(1);
    fireLongTask(2500);
    expect(captureEvent).toHaveBeenCalledTimes(2);
  });

  it("prefers the published diagnostic route over location.pathname", async () => {
    const { installFreezeWatchdog, captureEvent, setDiagnosticRoute } = await load();
    // Desktop: location.pathname is the packaged index.html path.
    setDiagnosticRoute("/:slug/issues");
    installFreezeWatchdog();

    fireLongTask(2500);

    expect(captureEvent).toHaveBeenCalledWith(
      "client_unresponsive",
      expect.objectContaining({ path: "/:slug/issues" }),
    );
  });

  it("carries the in-flight operation and how stale the label is", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { installFreezeWatchdog, captureEvent, markDiagnosticOperation } =
      await load();
    installFreezeWatchdog();

    markDiagnosticOperation("parse-markdown-chunked");
    vi.advanceTimersByTime(1_200);
    fireLongTask(2500);

    expect(captureEvent).toHaveBeenCalledWith(
      "client_unresponsive",
      expect.objectContaining({
        last_operation: "parse-markdown-chunked",
        last_operation_age_ms: 1_200,
      }),
    );
  });

  it("omits the operation fields when nothing was marked", async () => {
    const { installFreezeWatchdog, captureEvent } = await load();
    installFreezeWatchdog();

    fireLongTask(2500);

    const props = captureEvent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(props).not.toHaveProperty("last_operation");
    expect(props).not.toHaveProperty("last_operation_age_ms");
  });
});

// LoAF is what turns "froze for 8s" into "froze in <function> at <script>".
// It supersedes longtask, so only one of the two is ever observed.
describe("long-animation-frame attribution", () => {
  function loafEntry(overrides: Record<string, unknown> = {}): FakeEntry {
    return {
      duration: 8_000,
      blockingDuration: 7_900,
      scripts: [
        {
          sourceFunctionName: "parseMarkdownChunked",
          sourceURL:
            "file:///Applications/Multica.app/Contents/Resources/app.asar/out/renderer/assets/index-abc.js",
          sourceCharPosition: 4211,
          invokerType: "user-callback",
          duration: 7_800,
        },
      ],
      ...overrides,
    };
  }

  it("observes LoAF instead of longtask when the engine supports it", async () => {
    FakePerformanceObserver.supportedEntryTypes = ["longtask", "long-animation-frame"];
    const { installFreezeWatchdog } = await load();
    installFreezeWatchdog();

    expect(observedTypes).toEqual(["long-animation-frame"]);
  });

  it("reports the blocking script's function, file and position", async () => {
    FakePerformanceObserver.supportedEntryTypes = ["long-animation-frame"];
    const { installFreezeWatchdog, captureEvent } = await load();
    installFreezeWatchdog();

    fireEntry(loafEntry());

    expect(captureEvent).toHaveBeenCalledWith("client_unresponsive", {
      source: "loaf",
      duration_ms: 8_000,
      blocking_duration_ms: 7_900,
      script_function: "parseMarkdownChunked",
      // Install path stripped: it can carry the OS username.
      script_url: "assets/index-abc.js",
      script_char_position: 4211,
      script_invoker_type: "user-callback",
      script_duration_ms: 7_800,
      path: "/acme/issues",
    });
  });

  it("attributes the longest script when a frame ran several", async () => {
    FakePerformanceObserver.supportedEntryTypes = ["long-animation-frame"];
    const { installFreezeWatchdog, captureEvent } = await load();
    installFreezeWatchdog();

    fireEntry(
      loafEntry({
        scripts: [
          { sourceFunctionName: "cheap", duration: 12 },
          { sourceFunctionName: "expensive", duration: 7_800 },
          { sourceFunctionName: "alsoCheap", duration: 40 },
        ],
      }),
    );

    expect(captureEvent).toHaveBeenCalledWith(
      "client_unresponsive",
      expect.objectContaining({ script_function: "expensive" }),
    );
  });

  it("still reports duration when the frame carries no script attribution", async () => {
    FakePerformanceObserver.supportedEntryTypes = ["long-animation-frame"];
    const { installFreezeWatchdog, captureEvent } = await load();
    installFreezeWatchdog();

    fireEntry({ duration: 4_000 });

    expect(captureEvent).toHaveBeenCalledWith("client_unresponsive", {
      source: "loaf",
      duration_ms: 4_000,
      path: "/acme/issues",
    });
  });

  it("applies the same 2s threshold to frames", async () => {
    FakePerformanceObserver.supportedEntryTypes = ["long-animation-frame"];
    const { installFreezeWatchdog, captureEvent } = await load();
    installFreezeWatchdog();

    fireEntry(loafEntry({ duration: 1_999 }));

    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("falls back to longtask when observing LoAF throws", async () => {
    FakePerformanceObserver.supportedEntryTypes = ["long-animation-frame"];
    class ThrowsOnLoaf extends FakePerformanceObserver {
      override observe(options: { type: string }) {
        if (options.type === "long-animation-frame") throw new Error("nope");
        super.observe(options);
      }
    }
    ThrowsOnLoaf.supportedEntryTypes = ["long-animation-frame"];
    vi.stubGlobal("PerformanceObserver", ThrowsOnLoaf);

    const { installFreezeWatchdog } = await load();
    installFreezeWatchdog();

    expect(observedTypes).toEqual(["longtask"]);
  });
});
