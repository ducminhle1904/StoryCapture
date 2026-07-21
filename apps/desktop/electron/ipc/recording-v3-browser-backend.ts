import type { RecordingFailureCodeV3 } from "@storycapture/shared-types/recording-v2";

export const RECORDING_V3_BROWSER_BACKEND_ID = "electron_offscreen_shared_texture_v3" as const;
export const RECORDING_V3_BROWSER_BACKEND_VERSION = "3.0.0" as const;

export interface ElectronOffscreenSharedTextureV3 {
  textureInfo: {
    widgetType: string;
    codedSize: { width: number; height: number };
    pixelFormat: string;
    timestamp: number;
    metadata: { frameCount?: number };
    handle: { ioSurface?: Buffer };
  };
  release(): void;
}

export interface RecordingV3BrowserFrame {
  ioSurface: Buffer;
  frameCount: number;
  timestampUs: number;
}

export interface RecordingV3BrowserFrameSink {
  submitSourceFrame(frame: RecordingV3BrowserFrame): void;
  fail(code: RecordingFailureCodeV3, message: string): never;
}

export class BrowserCaptureBackendV3 {
  readonly backendId = RECORDING_V3_BROWSER_BACKEND_ID;
  readonly backendVersion = RECORDING_V3_BROWSER_BACKEND_VERSION;
  readonly guaranteeBoundary = "electron_offscreen_delivery" as const;
  readonly jsFrameBytes = 0;
  private releasedTextures = 0;
  private receivedTextures = 0;

  constructor(private readonly sink: RecordingV3BrowserFrameSink) {}

  get textureCounts(): { received: number; released: number } {
    return { received: this.receivedTextures, released: this.releasedTextures };
  }

  submitTexture(texture: ElectronOffscreenSharedTextureV3): void {
    this.receivedTextures += 1;
    try {
      const info = texture.textureInfo;
      if (info.widgetType !== "frame") {
        this.sink.fail("source_metadata_invalid", "Electron texture was not a frame widget");
      }
      if (
        info.pixelFormat !== "bgra" ||
        info.codedSize.width !== 1920 ||
        info.codedSize.height !== 1080
      ) {
        this.sink.fail(
          "source_metadata_invalid",
          `Electron texture violated 1920x1080 BGRA: ${info.codedSize.width}x${info.codedSize.height}/${info.pixelFormat}`,
        );
      }
      if (!Buffer.isBuffer(info.handle.ioSurface) || info.handle.ioSurface.byteLength === 0) {
        this.sink.fail("native_texture_lost", "Electron texture omitted the IOSurface handle");
      }
      const frameCount = info.metadata.frameCount;
      if (!Number.isSafeInteger(frameCount) || Number(frameCount) < 0) {
        this.sink.fail("source_metadata_missing", "Electron texture omitted metadata.frameCount");
      }
      if (!Number.isSafeInteger(info.timestamp) || info.timestamp < 0) {
        this.sink.fail("source_metadata_invalid", "Electron texture timestamp was invalid");
      }
      this.sink.submitSourceFrame({
        ioSurface: info.handle.ioSurface,
        frameCount: Number(frameCount),
        timestampUs: info.timestamp,
      });
    } finally {
      texture.release();
      this.releasedTextures += 1;
    }
  }
}
