import { randomUUID } from "node:crypto";
import { BrowserWindow, type NativeImage, type WebContents } from "electron";

import identity from "../identity.json";
import type {
  MacRecordingV4SurfaceTarget,
  WindowsRecordingV4Target,
} from "./recording-v4-native-target";

export interface RecordingV4BrowserSurfaceOptions {
  url: string;
  dimensions: RecordingV4SurfaceDimensions;
  contentViewport?: { width: number; height: number };
  partition?: string;
  env?: NodeJS.ProcessEnv;
  windowFactory?: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

export interface RecordingV4SurfaceDimensions {
  logical_width: number;
  logical_height: number;
  capture_dpr: number;
  physical_width: number;
  physical_height: number;
  requested_output_width: number;
  requested_output_height: number;
}

export interface RecordingV4QualityReferenceSample {
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

export class RecordingV4BrowserSurface {
  readonly window: BrowserWindow;
  readonly contents: WebContents;
  private readonly zoomFactor: number;

  inputCoordinateScale(): number {
    return this.zoomFactor;
  }

  outputCoordinateScale(): { x: number; y: number } {
    const viewport = this.options.contentViewport ?? {
      width: this.options.dimensions.logical_width / this.zoomFactor,
      height: this.options.dimensions.logical_height / this.zoomFactor,
    };
    return {
      x: this.options.dimensions.requested_output_width / viewport.width,
      y: this.options.dimensions.requested_output_height / viewport.height,
    };
  }

  constructor(private readonly options: RecordingV4BrowserSurfaceOptions) {
    const dimensions = options.dimensions;
    const partition = options.partition ?? `recording-v4-${randomUUID()}`;
    if (partition.startsWith("persist:")) {
      throw new Error("Recording V4 requires an isolated browser partition");
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
    const contentViewport = options.contentViewport ?? {
      width: dimensions.logical_width,
      height: dimensions.logical_height,
    };
    const horizontalZoom = dimensions.logical_width / contentViewport.width;
    const verticalZoom = dimensions.logical_height / contentViewport.height;
    if (
      !Number.isFinite(horizontalZoom) ||
      horizontalZoom <= 0 ||
      Math.abs(horizontalZoom - verticalZoom) > 0.001
    ) {
      this.window.destroy();
      throw new Error("recording content viewport must match the native surface aspect ratio");
    }
    this.zoomFactor = horizontalZoom;
  }

  async load(): Promise<void> {
    await this.window.loadURL(this.options.url);
    this.contents.setZoomFactor(this.zoomFactor);
    await this.contents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
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

  macTarget(): MacRecordingV4SurfaceTarget {
    const mediaSourceID = this.window.getMediaSourceId();
    const env = this.options.env ?? process.env;
    return {
      kind: "window",
      windowID: macWindowId(mediaSourceID),
      ownerPID: process.pid,
      ownerBundleID: env[identity.devAppEnv] === "1" ? identity.devBundleId : identity.prodBundleId,
      mediaSourceID,
    };
  }

  windowsTarget(): WindowsRecordingV4Target {
    return {
      kind: "window",
      hwnd: windowsHandle(this.window.getNativeWindowHandle()),
      process_id: process.pid,
      executable_path: process.execPath,
      class_name: "Chrome_WidgetWin_1",
    };
  }

  async captureReference(frameIndex: number): Promise<RecordingV4QualityReferenceSample> {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
      throw new Error("recording quality reference frame index must be non-negative");
    }
    const captured: NativeImage = await this.contents.capturePage();
    const width = this.options.dimensions.requested_output_width;
    const height = this.options.dimensions.requested_output_height;
    const capturedSize = captured.getSize();
    const image =
      capturedSize.width === width && capturedSize.height === height
        ? captured
        : captured.resize({ width, height, quality: "best" });
    const size = image.getSize();
    const pixels = image.toBitmap();
    if (size.width !== width || size.height !== height) {
      throw new Error("recording quality reference resize did not reach output dimensions");
    }
    if (pixels.byteLength !== size.width * size.height * 4) {
      throw new Error("recording quality reference bitmap has an invalid byte length");
    }
    return { frame_index: frameIndex, pixels, width: size.width, height: size.height };
  }

  destroy(): void {
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
