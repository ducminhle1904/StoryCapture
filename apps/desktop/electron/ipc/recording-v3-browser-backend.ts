import {
  type RecordingFailureCodeV3,
  RECORDING_V3_STRICT_DIMENSIONS,
} from "@storycapture/shared-types/recording-v3";

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

type RecordingV3TextureMetadata = Pick<
  ElectronOffscreenSharedTextureV3["textureInfo"],
  "widgetType" | "codedSize" | "pixelFormat"
>;

export function recordingV3TextureMetadataFailure(
  info: RecordingV3TextureMetadata,
  expectedCodedSize: { width: number; height: number },
): { code: "source_metadata_invalid"; message: string } | null {
  if (info.widgetType !== "frame") {
    return {
      code: "source_metadata_invalid",
      message: "Electron texture was not a frame widget",
    };
  }
  if (
    info.pixelFormat !== "bgra" ||
    info.codedSize.width !== expectedCodedSize.width ||
    info.codedSize.height !== expectedCodedSize.height
  ) {
    return {
      code: "source_metadata_invalid",
      message: `Electron texture expected ${expectedCodedSize.width}x${expectedCodedSize.height} BGRA; received ${info.codedSize.width}x${info.codedSize.height}/${info.pixelFormat}`,
    };
  }
  return null;
}

export class BrowserCaptureBackendV3 {
  readonly backendId = RECORDING_V3_BROWSER_BACKEND_ID;
  readonly backendVersion = RECORDING_V3_BROWSER_BACKEND_VERSION;
  readonly guaranteeBoundary = "electron_offscreen_delivery" as const;
  readonly jsFrameBytes = 0;
  private releasedTextures = 0;
  private receivedTextures = 0;

  constructor(
    private readonly sink: RecordingV3BrowserFrameSink,
    private readonly expectedCodedSize: { width: number; height: number } = {
      width: RECORDING_V3_STRICT_DIMENSIONS.physical_width,
      height: RECORDING_V3_STRICT_DIMENSIONS.physical_height,
    },
  ) {}

  get textureCounts(): { received: number; released: number } {
    return { received: this.receivedTextures, released: this.releasedTextures };
  }

  submitTexture(texture: ElectronOffscreenSharedTextureV3): void {
    this.receivedTextures += 1;
    try {
      const info = texture.textureInfo;
      const metadataFailure = recordingV3TextureMetadataFailure(info, this.expectedCodedSize);
      if (metadataFailure) this.sink.fail(metadataFailure.code, metadataFailure.message);
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
