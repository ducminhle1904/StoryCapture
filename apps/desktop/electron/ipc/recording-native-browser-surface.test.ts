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

function fakeWindow(capturedSize = { width: 1920, height: 1080 }) {
  const outputSize = {
    width: dimensions.requested_output_width,
    height: dimensions.requested_output_height,
  };
  const resized = {
    getSize: vi.fn(() => outputSize),
    toBitmap: vi.fn(() => Buffer.alloc(outputSize.width * outputSize.height * 4)),
  };
  const getSize = vi.fn(() => capturedSize);
  const toBitmap = vi.fn(() => Buffer.alloc(capturedSize.width * capturedSize.height * 4));
  const resize = vi.fn(() => resized);
  const contents = {
    setZoomFactor: vi.fn(),
    executeJavaScript: vi.fn(async () => undefined),
    capturePage: vi.fn(async () => ({
      getSize,
      toBitmap,
      resize,
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
    getSize,
    toBitmap,
    resize,
    resized,
  };
}

describe("native recording BrowserWindow surface", () => {
  it("stays hidden until load and derives exact platform identities", async () => {
    const window = fakeWindow();
    const surface = new RecordingNativeBrowserSurface({
      url: "https://example.test",
      dimensions,
      env: { STORYCAPTURE_DEV_APP: "1" },
      windowFactory: () => window as never,
    });

    expect(window.show).not.toHaveBeenCalled();
    await surface.load();
    expect(window.webContents.setZoomFactor).toHaveBeenCalledWith(1);
    expect(window.show).toHaveBeenCalledOnce();
    expect(surface.macTarget()).toMatchObject({
      kind: "window",
      windowID: 42,
      ownerBundleID: "com.storycapture.desktop.dev",
      mediaSourceID: "window:42:0",
    });
    expect(surface.windowsTarget()).toMatchObject({ kind: "window", hwnd: "1234" });
    await expect(surface.captureReference(3)).resolves.toMatchObject({
      frame_index: 3,
      width: 1920,
      height: 1080,
    });
    expect(window.resize).not.toHaveBeenCalled();
    expect(window.toBitmap).toHaveBeenCalledWith();
  });

  it("keeps a desktop CSS viewport on a smaller Retina surface", async () => {
    const window = fakeWindow();

    const surface = new RecordingNativeBrowserSurface({
      url: "https://example.test",
      dimensions,
      contentViewport: { width: 1280, height: 720 },
      windowFactory: () => window as never,
    });

    await surface.load();
    expect(window.webContents.setZoomFactor).toHaveBeenCalledWith(0.75);
  });

  it("samples quality references at requested output resolution", async () => {
    const window = fakeWindow({ width: 2560, height: 1440 });
    const surface = new RecordingNativeBrowserSurface({
      url: "https://example.test",
      dimensions: {
        ...dimensions,
        logical_width: 1280,
        logical_height: 720,
        physical_width: 2560,
        physical_height: 1440,
      },
      windowFactory: () => window as never,
    });

    await surface.captureReference(1);

    expect(window.resize).toHaveBeenCalledWith({ width: 1920, height: 1080, quality: "best" });
    expect(window.resized.toBitmap).toHaveBeenCalledWith();
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
