import { describe, expect, it, vi } from "vitest";

import { RecordingNativeBrowserSurface } from "./recording-native-browser-surface";

const dimensions = {
  logical_width: 960,
  logical_height: 540,
  capture_dpr: 2,
  physical_width: 1_920,
  physical_height: 1_080,
  requested_output_width: 1_920,
  requested_output_height: 1_080,
};

function fakeWindow() {
  const contents = {
    capturePage: vi.fn(async () => ({
      getSize: () => ({ width: 2, height: 1 }),
      toBitmap: () => Buffer.alloc(8),
    })),
  };
  return {
    webContents: contents,
    loadURL: vi.fn(async () => undefined),
    getContentBounds: () => ({ x: 0, y: 0, width: 960, height: 540 }),
    show: vi.fn(),
    getMediaSourceId: () => "window:42:0",
    getNativeWindowHandle: () => {
      const handle = Buffer.alloc(8);
      handle.writeBigUInt64LE(1234n);
      return handle;
    },
    isDestroyed: () => false,
    destroy: vi.fn(),
  };
}

describe("native recording BrowserWindow surface", () => {
  it("stays hidden until load and derives exact platform identities", async () => {
    const window = fakeWindow();
    const surface = new RecordingNativeBrowserSurface({
      url: "https://example.test",
      dimensions,
      windowFactory: () => window as never,
    });

    expect(window.show).not.toHaveBeenCalled();
    await surface.load();
    expect(window.show).toHaveBeenCalledOnce();
    expect(surface.macTarget()).toMatchObject({
      kind: "window",
      windowID: 42,
      mediaSourceID: "window:42:0",
    });
    expect(surface.windowsTarget()).toMatchObject({ kind: "window", hwnd: "1234" });
    await expect(surface.captureReference(3)).resolves.toMatchObject({
      frame_index: 3,
      width: 2,
      height: 1,
    });
  });

  it("rejects persistent partitions before creating a window", () => {
    expect(
      () =>
        new RecordingNativeBrowserSurface({
          url: "https://example.test",
          dimensions,
          partition: "persist:recording",
          windowFactory: vi.fn() as never,
        }),
    ).toThrow(/isolated/);
  });
});
