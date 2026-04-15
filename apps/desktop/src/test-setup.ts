/**
 * Global Vitest setup for apps/desktop (Plan 02-12b).
 *
 * Registers `@testing-library/jest-dom` matchers and provides a
 * `matchMedia` shim because happy-dom does not implement it — shadcn/Base
 * UI components that ship with `prefers-reduced-motion` checks would
 * otherwise throw.
 */

import "@testing-library/jest-dom/vitest";

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
