import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bucketDiagnosticPath,
  getDiagnosticContext,
  getDiagnosticOperation,
  getDiagnosticOperationAgeMs,
  getDiagnosticRoute,
  markDiagnosticOperation,
  resetDiagnosticContext,
  setDiagnosticContextListener,
  setDiagnosticRoute,
} from "./diagnostic-context";

afterEach(() => {
  resetDiagnosticContext();
  vi.useRealTimers();
});

describe("diagnostic route + operation", () => {
  it("holds the published route", () => {
    setDiagnosticRoute("/:slug/issues");
    expect(getDiagnosticRoute()).toBe("/:slug/issues");
  });

  it("treats empty and whitespace values as absent", () => {
    setDiagnosticRoute("   ");
    expect(getDiagnosticRoute()).toBeNull();
  });

  it("notifies the mirror when either field changes", () => {
    const listener = vi.fn();
    setDiagnosticContextListener(listener);

    setDiagnosticRoute("/:slug/inbox");
    markDiagnosticOperation("parse-markdown-chunked");

    expect(listener).toHaveBeenNthCalledWith(1, {
      route: "/:slug/inbox",
      operation: null,
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      route: "/:slug/inbox",
      operation: "parse-markdown-chunked",
    });
  });

  it("does not notify when the value is unchanged", () => {
    const listener = vi.fn();
    setDiagnosticContextListener(listener);

    setDiagnosticRoute("/:slug/issues");
    setDiagnosticRoute("/:slug/issues");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("survives a listener that throws — the caller is about to do heavy work", () => {
    setDiagnosticContextListener(() => {
      throw new Error("ipc gone");
    });

    expect(() => markDiagnosticOperation("parse-markdown-chunked")).not.toThrow();
    expect(getDiagnosticOperation()).toBe("parse-markdown-chunked");
  });

  it("re-stamps the age when the same operation is marked again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    markDiagnosticOperation("parse-markdown-chunked");

    vi.advanceTimersByTime(5_000);
    expect(getDiagnosticOperationAgeMs()).toBe(5_000);

    markDiagnosticOperation("parse-markdown-chunked");
    expect(getDiagnosticOperationAgeMs()).toBe(0);
  });

  it("reports no age once the operation is cleared", () => {
    markDiagnosticOperation("parse-markdown-chunked");
    markDiagnosticOperation(null);

    expect(getDiagnosticContext()).toEqual({ route: null, operation: null });
    expect(getDiagnosticOperationAgeMs()).toBeNull();
  });
});

describe("bucketDiagnosticPath", () => {
  it("replaces the workspace slug", () => {
    expect(bucketDiagnosticPath("/acme/issues")).toBe("/:slug/issues");
  });

  it("replaces issue keys and uuids", () => {
    expect(bucketDiagnosticPath("/acme/issues/MUL-5345")).toBe(
      "/:slug/issues/:id",
    );
    expect(
      bucketDiagnosticPath("/acme/issues/8db920bc-f982-4d38-95f3-56ec43cbefa8"),
    ).toBe("/:slug/issues/:id");
  });

  it("keeps pre-workspace routes intact", () => {
    expect(bucketDiagnosticPath("/login")).toBe("/login");
    expect(bucketDiagnosticPath("/workspaces/new")).toBe("/workspaces/new");
  });

  it("still buckets the id in a pre-workspace route", () => {
    expect(bucketDiagnosticPath("/invite/8db920bc-f982-4d38-95f3-56ec43cbefa8")).toBe(
      "/invite/:id",
    );
  });

  it("drops query string and hash — they can carry resource ids", () => {
    expect(bucketDiagnosticPath("/acme/issues?issue=MUL-1#comment-3")).toBe(
      "/:slug/issues",
    );
  });

  it("normalizes the root path", () => {
    expect(bucketDiagnosticPath("/")).toBe("/");
  });
});
