/**
 * MUL-5208 — the web half of the `multica:navigate` bridge.
 *
 * Shared content (comments, chat, issue descriptions) fires this event whenever
 * a link resolves to an in-app destination, including an absolute URL on this
 * deployment's own origin. Desktop answers it by opening a tab; the web must
 * answer it with a router push, or those links silently do nothing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/acme/issues",
  useSearchParams: () => new URLSearchParams(),
}));

import { WebNavigationProvider } from "./navigation";
import { useNavigation, type NavigationAdapter } from "@multica/views/navigation";

function navigate(path: string) {
  window.dispatchEvent(
    new CustomEvent("multica:navigate", { detail: { path } }),
  );
}

function popstate() {
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function renderAdapter(): () => NavigationAdapter {
  let adapter: NavigationAdapter | null = null;
  function Probe() {
    adapter = useNavigation();
    return null;
  }
  render(
    <WebNavigationProvider>
      <Probe />
    </WebNavigationProvider>,
  );
  return () => adapter!;
}

beforeEach(() => {
  router.push.mockReset();
});

describe("WebNavigationProvider internal link bridge", () => {
  it("pushes the path a content link resolved to", () => {
    render(<WebNavigationProvider>{null}</WebNavigationProvider>);

    navigate("/acme/issues/MUL-1");

    expect(router.push).toHaveBeenCalledWith("/acme/issues/MUL-1");
  });

  it("ignores an event without a path", () => {
    render(<WebNavigationProvider>{null}</WebNavigationProvider>);

    window.dispatchEvent(new CustomEvent("multica:navigate", { detail: {} }));

    expect(router.push).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    const { unmount } = render(
      <WebNavigationProvider>{null}</WebNavigationProvider>,
    );

    unmount();
    navigate("/acme/issues/MUL-1");

    expect(router.push).not.toHaveBeenCalled();
  });
});

/**
 * `canGoBack` decides whether a page whose subject was just deleted steps back
 * or replaces with a fallback. Getting it wrong in the optimistic direction
 * walks the user out of Multica, so the wiring — not just the tracker — needs
 * covering. jsdom has no Navigation API, which is exactly the fallback path.
 */
describe("WebNavigationProvider in-app history", () => {
  // The tracker is document-scoped, so normalize it instead of assuming a
  // fresh module: traversals clamp at zero, so draining always lands on "no
  // in-app history" no matter what earlier tests pushed.
  function drainToColdOpen() {
    for (let i = 0; i < 5; i += 1) popstate();
  }

  it("reports no history for a cold open", () => {
    const adapter = renderAdapter();
    drainToColdOpen();

    expect(adapter().canGoBack!()).toBe(false);
  });

  it("reports history once the user has navigated in-app", () => {
    const adapter = renderAdapter();
    drainToColdOpen();

    act(() => adapter().push("/acme/issues/MUL-1"));

    expect(adapter().canGoBack!()).toBe(true);
  });

  // Regression (PR review): a push followed by the browser's own Back button
  // left the user on the entry the document opened at while `canGoBack` still
  // said true — `back()` from there leaves the app.
  it("reports no history after a browser Back undoes the push", () => {
    const adapter = renderAdapter();
    drainToColdOpen();

    act(() => adapter().push("/acme/issues/MUL-1"));
    popstate();

    expect(adapter().canGoBack!()).toBe(false);
  });

  it("stops tracking traversals once unmounted", () => {
    const adapter = renderAdapter();
    drainToColdOpen();
    act(() => adapter().push("/acme/issues/MUL-1"));

    const { unmount } = render(
      <WebNavigationProvider>{null}</WebNavigationProvider>,
    );
    unmount();
    // The remaining mounted provider still listens, so this must still count.
    popstate();

    expect(adapter().canGoBack!()).toBe(false);
  });
});
