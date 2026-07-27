import { afterEach, describe, expect, it } from "vitest";

import {
  bucketDiagnosticPath,
  getDiagnosticRoute,
  resetDiagnosticContext,
  setDiagnosticRoute,
} from "./diagnostic-context";

afterEach(() => {
  resetDiagnosticContext();
});

describe("diagnostic route", () => {
  it("holds the published route", () => {
    setDiagnosticRoute("/:slug/issues");
    expect(getDiagnosticRoute()).toBe("/:slug/issues");
  });

  it("treats empty and whitespace values as absent", () => {
    setDiagnosticRoute("   ");
    expect(getDiagnosticRoute()).toBeNull();
  });

  it("clears on null, so a window that leaves a route stops claiming it", () => {
    setDiagnosticRoute("/:slug/issues");
    setDiagnosticRoute(null);
    expect(getDiagnosticRoute()).toBeNull();
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
