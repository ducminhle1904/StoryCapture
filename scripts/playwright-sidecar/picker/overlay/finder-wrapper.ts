// CSS selector builder with shadow-DOM piercing. Uses `@medv/finder` per
// shadow root and joins the segments with Playwright's ` >> ` piercing
// combinator, which `page.locator(...)` understands natively.
//
// Closed shadow roots cannot be traversed (documented limitation per
// 07-CONTEXT §Tier 2 deferred).

import { finder } from "@medv/finder";

export function buildCss(el: Element): string {
  const segments: string[] = [];
  let current: Element | null = el;
  while (current) {
    const root = current.getRootNode();
    if (root instanceof ShadowRoot) {
      // Per-shadow-root finder; rooted at the shadow root so the selector
      // is unique within it.
      segments.unshift(finder(current, { root: root as unknown as Element }));
      current = root.host;
    } else {
      segments.unshift(finder(current));
      current = null;
    }
  }
  return segments.join(" >> ");
}

export function shadowDepth(el: Element): number {
  let depth = 0;
  let current: Element | null = el;
  while (current) {
    const root = current.getRootNode();
    if (root instanceof ShadowRoot) {
      depth++;
      current = root.host;
    } else {
      current = null;
    }
  }
  return depth;
}
