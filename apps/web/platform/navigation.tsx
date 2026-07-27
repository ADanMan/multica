"use client";

import { Suspense, useCallback, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "@multica/views/navigation";
import { createInAppHistoryTracker } from "./in-app-history";

// Document-scoped, like the browser history it shadows: a remount must not
// convince us there is somewhere to go back to.
const inAppHistory = createInAppHistoryTracker();

/**
 * Web half of the `multica:navigate` bridge — the event shared content
 * (comments, chat, issue descriptions) fires when a link resolves to an in-app
 * destination. Desktop's shell answers it by opening a tab; on the web the
 * equivalent is a router push in place. Without this the event has no listener
 * and such links do nothing at all.
 */
function useInternalLinkHandler(push: (path: string) => void) {
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      push(path);
    };
    window.addEventListener("multica:navigate", handler);
    return () => window.removeEventListener("multica:navigate", handler);
  }, [push]);
}

/**
 * Keep the in-app depth honest about history traversals — the browser's own
 * Back/Forward buttons and `router.back()` both land here. Without it a push
 * followed by a browser Back would still look like "there is a page behind
 * us" while sitting on the entry the document opened at.
 */
function useHistoryTraversalTracking() {
  useEffect(() => {
    const onPopState = () => inAppHistory.recordTraversal();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
}

function NavigationProviderInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const push = useCallback(
    (path: string) => {
      inAppHistory.recordPush();
      router.push(path);
    },
    [router],
  );
  useInternalLinkHandler(push);
  useHistoryTraversalTracking();

  const adapter: NavigationAdapter = {
    push,
    replace: router.replace,
    back: router.back,
    canGoBack: inAppHistory.canGoBack,
    pathname,
    searchParams: new URLSearchParams(searchParams.toString()),
    getShareableUrl: (path: string) =>
      typeof window === "undefined" ? path : window.location.origin + path,
    // router.prefetch is a no-op in dev mode by Next.js design; in production
    // it warms the RSC payload + route chunk so the next push() commits with
    // no network round-trip. Safe to call repeatedly — Next dedupes internally.
    prefetch: (path: string) => {
      router.prefetch(path);
    },
  };

  return <NavigationProvider value={adapter}>{children}</NavigationProvider>;
}

export function WebNavigationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense>
      <NavigationProviderInner>{children}</NavigationProviderInner>
    </Suspense>
  );
}
