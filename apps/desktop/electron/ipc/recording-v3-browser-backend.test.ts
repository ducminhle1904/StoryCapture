import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserCaptureBackendV3,
  type ElectronOffscreenSharedTextureV3,
} from "./recording-v3-browser-backend";

function texture(overrides: Partial<ElectronOffscreenSharedTextureV3["textureInfo"]> = {}) {
  const release = vi.fn();
  const ioSurface = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const value: ElectronOffscreenSharedTextureV3 = {
    textureInfo: {
      widgetType: "frame",
      codedSize: { width: 1920, height: 1080 },
      pixelFormat: "bgra",
      timestamp: 16_667,
      metadata: { frameCount: 1 },
      handle: { ioSurface },
      ...overrides,
    },
    release,
  };
  return { value, release, ioSurface };
}

describe("BrowserCaptureBackendV3", () => {
  it("forwards only the IOSurface handle and Electron source metadata", () => {
    const submitSourceFrame = vi.fn();
    const backend = new BrowserCaptureBackendV3({
      submitSourceFrame,
      fail: (code, message) => {
        throw new Error(`${code}:${message}`);
      },
    });
    const frame = texture();

    backend.submitTexture(frame.value);

    expect(submitSourceFrame).toHaveBeenCalledWith({
      ioSurface: frame.ioSurface,
      frameCount: 1,
      timestampUs: 16_667,
    });
    expect(frame.release).toHaveBeenCalledOnce();
    expect(backend.textureCounts).toEqual({ received: 1, released: 1 });
    expect(backend.jsFrameBytes).toBe(0);
  });

  it.each([
    [{ metadata: {} }, "source_metadata_missing"],
    [{ timestamp: -1 }, "source_metadata_invalid"],
    [{ pixelFormat: "rgba" }, "source_metadata_invalid"],
    [{ handle: {} }, "native_texture_lost"],
  ] as const)("fails closed and releases invalid texture %#", (override, code) => {
    const frame = texture(override);
    const backend = new BrowserCaptureBackendV3({
      submitSourceFrame: vi.fn(),
      fail: (failureCode, message) => {
        throw new Error(`${failureCode}:${message}`);
      },
    });

    expect(() => backend.submitTexture(frame.value)).toThrow(code);
    expect(frame.release).toHaveBeenCalledOnce();
  });

  it("contains no JavaScript pixel materialization path", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "recording-v3-browser-backend.ts"),
      "utf8",
    );
    expect(source).not.toContain("to" + "Bitmap");
    expect(source).not.toContain("getBitmap");
    expect(source).not.toMatch(/Buffer\.(?:alloc|allocUnsafe|from)\s*\(/);
  });
});
