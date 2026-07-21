import { createRequire } from "node:module";
import path from "node:path";

const PROTOCOL_VERSION = 1;
const ADDON_FILENAME = "storycapture_shared_texture_probe.node";

export interface NativeSharedTextureProbeStats {
  handlesImported: number;
  handlesReleased: number;
  activeLeases: number;
  peakActiveLeases: number;
  nativeAcceptedFrames: number;
  ffmpegEnqueuedFrames: number;
  queueOverflows: number;
  maxReadyQueueDepth: number;
  lastFrameCount: number;
  lastTimestampUs: number;
  serviceTimeP95Ms: number;
  serviceTimeP99Ms: number;
  serviceTimeMaxMs: number;
  boundedPoolBytes: number;
  baselineResidentBytes: number;
  peakResidentBytes: number;
  finalResidentBytes: number;
  ffmpegLaunched: boolean;
  ffmpegExitCode: number;
  failed: boolean;
  failureReason: string;
}

export interface NativeSharedTextureProbeReceipt {
  frameCount: number;
  timestampUs: number;
  markerOrdinal: number;
  serviceTimeMs: number;
}

export interface NativeSharedTextureProbeSession {
  submitFrame(input: {
    ioSurface: Buffer;
    frameCount: number;
    timestampUs: number;
  }): NativeSharedTextureProbeReceipt;
  finish(): NativeSharedTextureProbeStats;
  abort(): NativeSharedTextureProbeStats;
  getStats(): NativeSharedTextureProbeStats;
}

interface NativeSharedTextureProbeAddon {
  protocolVersion: number;
  createSession(input: {
    width: number;
    height: number;
    ffmpegPath: string;
    outputPath: string;
  }): NativeSharedTextureProbeSession;
}

export function nativeSharedTextureProbeAddonPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  desktopRoot: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, "native", "macos", ADDON_FILENAME)
    : path.join(
        input.desktopRoot,
        "native",
        "macos-shared-texture-probe",
        ".build",
        ADDON_FILENAME,
      );
}

export function loadNativeSharedTextureProbe(addonPath: string): NativeSharedTextureProbeAddon {
  const require = createRequire(import.meta.url);
  const addon = require(addonPath) as Partial<NativeSharedTextureProbeAddon>;
  if (addon.protocolVersion !== PROTOCOL_VERSION || typeof addon.createSession !== "function") {
    throw new Error(`unsupported shared-texture probe addon protocol at ${addonPath}`);
  }
  return addon as NativeSharedTextureProbeAddon;
}
