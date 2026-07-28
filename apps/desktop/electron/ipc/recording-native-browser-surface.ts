import { randomUUID } from "node:crypto";
import type { RecordingDimensionsV2 } from "@storycapture/shared-types/recording-v2";
import { BrowserWindow, type NativeImage, type WebContents } from "electron";

import type { MacScreenCaptureTarget } from "./macos-screen-capture-backend";
import type { WindowsCaptureTarget } from "./windows-capture-protocol";

export interface RecordingNativeBrowserSurfaceOptions {
  url: string;
  dimensions: RecordingDimensionsV2;
  partition?: string;
  windowFactory?: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

export interface RecordingQualityReferenceSample {
  frame_index: number;
  pixels: Buffer;
  width: number;
  height: number;
}

function macWindowId(mediaSourceId: string): number {
  const match = mediaSourceId.match(/^window:(\d+):\d+$/);
  const id = Number(match?.[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Electron returned an invalid macOS window media source ID");
  }
  return id;
}

function windowsHandle(handle: Buffer): string {
  if (handle.byteLength !== 4 && handle.byteLength !== 8) {
    throw new Error("Electron returned an invalid native window handle");
  }
  const value =
    handle.byteLength === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  if (value === 0n) throw new Error("Electron returned a null native window handle");
  return value.toString();
}

export class RecordingNativeBrowserSurface {
  readonly window: BrowserWindow;
  readonly contents: WebContents;

  constructor(private readonly options: RecordingNativeBrowserSurfaceOptions) {
    const dimensions = options.dimensions;
    const partition = options.partition ?? `recording-native-${randomUUID()}`;
    if (partition.startsWith("persist:")) {
      throw new Error("Strict native recording requires an isolated browser partition");
    }
    this.window = (
      options.windowFactory ?? ((browserOptions) => new BrowserWindow(browserOptions))
    )({
      show: false,
      frame: false,
      useContentSize: true,
      width: dimensions.logical_width,
      height: dimensions.logical_height,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.contents = this.window.webContents;
  }

  async load(): Promise<void> {
    await this.window.loadURL(this.options.url);
    const bounds = this.window.getContentBounds();
    if (
      bounds.width !== this.options.dimensions.logical_width ||
      bounds.height !== this.options.dimensions.logical_height
    ) {
      throw new Error(
        `recording BrowserWindow content is ${bounds.width}x${bounds.height}, expected ${this.options.dimensions.logical_width}x${this.options.dimensions.logical_height}`,
      );
    }
    this.window.show();
  }

  macTarget(): MacScreenCaptureTarget {
    const mediaSourceID = this.window.getMediaSourceId();
    return {
      kind: "window",
      windowID: macWindowId(mediaSourceID),
      ownerPID: process.pid,
      mediaSourceID,
    };
  }

  windowsTarget(): WindowsCaptureTarget {
    return {
      kind: "window",
      hwnd: windowsHandle(this.window.getNativeWindowHandle()),
      process_id: process.pid,
      executable_path: process.execPath,
      class_name: "Chrome_WidgetWin_1",
    };
  }

  async captureReference(frameIndex: number): Promise<RecordingQualityReferenceSample> {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
      throw new Error("recording quality reference frame index must be non-negative");
    }
    const image: NativeImage = await this.contents.capturePage();
    const scaleFactor = this.options.dimensions.capture_dpr;
    const size = image.getSize(scaleFactor);
    const pixels = image.toBitmap({ scaleFactor });
    if (pixels.byteLength !== size.width * size.height * 4) {
      throw new Error("recording quality reference bitmap has an invalid byte length");
    }
    return { frame_index: frameIndex, pixels, width: size.width, height: size.height };
  }

  destroy(): void {
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
