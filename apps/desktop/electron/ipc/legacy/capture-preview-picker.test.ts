import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/storycapture-test" },
  BrowserWindow: vi.fn(),
  desktopCapturer: { getSources: vi.fn() },
  dialog: {},
  screen: {},
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater: {} },
}));

vi.mock("ffmpeg-static", () => ({ default: null }));

import { pickerScript } from "./capture-preview";

describe("picker injected lifecycle", () => {
  it("refreshes hover geometry on passive scroll and resize without resolving picker", () => {
    const script = pickerScript(5_000);
    expect(script).toContain(
      "document.addEventListener('scroll', onViewportChange, { capture: true, passive: true })",
    );
    expect(script).toContain(
      "window.addEventListener('resize', onViewportChange, { passive: true })",
    );
    expect(script).toContain("requestAnimationFrame(refreshHovered)");
    expect(script).toContain("document.elementFromPoint(lastPointerX, lastPointerY)");
    expect(script).not.toContain("const onViewportChange = (event)");
  });

  it("cleans every viewport listener and pending animation frame", () => {
    const script = pickerScript(5_000);
    expect(script).toContain("document.removeEventListener('scroll', onViewportChange, true)");
    expect(script).toContain("window.removeEventListener('resize', onViewportChange)");
    expect(script).toContain("cancelAnimationFrame(refreshFrame)");
  });

  it("reports scrollable element metadata for the deliberate scroll action", () => {
    const script = pickerScript(5_000);
    expect(script).toContain("isScrollable: scrollability.own");
    expect(script).toContain("hasScrollableAncestor: scrollability.ancestor");
  });
});
