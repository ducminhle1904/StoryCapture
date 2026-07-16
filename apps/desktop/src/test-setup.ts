/**
 * Global Vitest setup for apps/desktop.
 *
 * Registers `@testing-library/jest-dom` matchers and provides a
 * `matchMedia` shim because happy-dom does not implement it — shadcn/Base
 * UI components that ship with `prefers-reduced-motion` checks would
 * otherwise throw.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// react-hotkeys-hook 5.3 resolves the `mod` alias from the browser user agent:
// Meta on macOS and Control elsewhere. The editor shortcut tests use the macOS
// bindings, so make happy-dom's otherwise generic user agent deterministic.
Object.defineProperty(window.navigator, "userAgent", {
  configurable: true,
  value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
});

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
