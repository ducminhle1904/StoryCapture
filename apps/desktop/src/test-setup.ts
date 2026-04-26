/**
 * Global Vitest setup for apps/desktop.
 *
 * Registers `@testing-library/jest-dom` matchers and provides a
 * `matchMedia` shim because happy-dom does not implement it — shadcn/Base
 * UI components that ship with `prefers-reduced-motion` checks would
 * otherwise throw.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Ensure DOM is torn down between tests so queries don't see leftover nodes.
afterEach(() => {
  cleanup();
});

// happy-dom does not ship matchMedia.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
