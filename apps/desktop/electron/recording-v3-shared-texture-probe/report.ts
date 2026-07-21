import type {
  NativeSharedTextureProbeReceipt,
  NativeSharedTextureProbeStats,
} from "./native-addon-loader";

export const SHARED_TEXTURE_PROBE_FRAME_COUNT = 600;
export const SHARED_TEXTURE_PROBE_WIDTH = 1920;
export const SHARED_TEXTURE_PROBE_HEIGHT = 1080;
export const SHARED_TEXTURE_PROBE_P95_LIMIT_MS = 11.11;
export const SHARED_TEXTURE_PROBE_P99_LIMIT_MS = 16.67;
export const SHARED_TEXTURE_PROBE_MEMORY_GROWTH_LIMIT_BYTES = 64 * 1024 * 1024;

export interface SharedTextureProbeGateInput {
  receipts: NativeSharedTextureProbeReceipt[];
  stats: NativeSharedTextureProbeStats;
  jsFrameBytes: number;
  electronTexturesReceived: number;
  electronTexturesReleased: number;
  codedSizeMatches: boolean;
  addonLoadedFromPackagedResources: boolean;
  addonSignatureVerified: boolean;
  appSignatureVerified: boolean;
  ffmpegPathWasPackaged: boolean;
}

export interface SharedTextureProbeGateResult {
  passed: boolean;
  failures: string[];
  sourceFrameCountStart: number | null;
  sourceFrameCountEnd: number | null;
  sourceTimestampStartUs: number | null;
  sourceTimestampEndUs: number | null;
  markerOrdinalStart: number | null;
  markerOrdinalEnd: number | null;
  uniqueMarkerCount: number;
  residentGrowthBytes: number;
}

export function evaluateSharedTextureProbeGate(
  input: SharedTextureProbeGateInput,
): SharedTextureProbeGateResult {
  const failures: string[] = [];
  const { receipts, stats } = input;
  if (receipts.length !== SHARED_TEXTURE_PROBE_FRAME_COUNT) {
    failures.push(`expected 600 receipts, received ${receipts.length}`);
  }
  for (let index = 1; index < receipts.length; index += 1) {
    if (receipts[index].frameCount !== receipts[index - 1].frameCount + 1) {
      failures.push(`Electron frameCount discontinuity at receipt ${index}`);
      break;
    }
  }
  for (let index = 1; index < receipts.length; index += 1) {
    if (receipts[index].timestampUs <= receipts[index - 1].timestampUs) {
      failures.push(`Electron timestamp is not monotonic at receipt ${index}`);
      break;
    }
  }
  for (let index = 1; index < receipts.length; index += 1) {
    if (receipts[index].markerOrdinal !== receipts[index - 1].markerOrdinal + 1) {
      failures.push(`fixture marker discontinuity at receipt ${index}`);
      break;
    }
  }
  const uniqueMarkerCount = new Set(receipts.map((receipt) => receipt.markerOrdinal)).size;
  if (uniqueMarkerCount !== receipts.length) failures.push("fixture markers are not unique");
  if (!input.codedSizeMatches) failures.push("Electron texture codedSize was not 1920x1080");
  if (input.jsFrameBytes !== 0) failures.push("full-frame bytes crossed the JavaScript boundary");
  if (input.electronTexturesReceived !== SHARED_TEXTURE_PROBE_FRAME_COUNT) {
    failures.push("Electron shared-texture receipt count was not 600");
  }
  if (input.electronTexturesReleased !== input.electronTexturesReceived) {
    failures.push("Electron shared-texture release count did not match receipt count");
  }
  if (stats.handlesImported !== SHARED_TEXTURE_PROBE_FRAME_COUNT) {
    failures.push("native IOSurface import count was not 600");
  }
  if (stats.handlesReleased !== stats.handlesImported || stats.activeLeases !== 0) {
    failures.push("native IOSurface lease count did not return to zero");
  }
  if (stats.nativeAcceptedFrames !== SHARED_TEXTURE_PROBE_FRAME_COUNT) {
    failures.push("native accepted-frame count was not 600");
  }
  if (stats.ffmpegEnqueuedFrames !== SHARED_TEXTURE_PROBE_FRAME_COUNT) {
    failures.push("native FFmpeg enqueue count was not 600");
  }
  if (stats.queueOverflows !== 0) failures.push("native queue overflowed");
  if (stats.maxReadyQueueDepth > 1) failures.push("native ready queue depth exceeded one");
  if (stats.serviceTimeP95Ms > SHARED_TEXTURE_PROBE_P95_LIMIT_MS) {
    failures.push("native readback/enqueue p95 exceeded 11.11 ms");
  }
  if (stats.serviceTimeP99Ms > SHARED_TEXTURE_PROBE_P99_LIMIT_MS) {
    failures.push("native readback/enqueue p99 exceeded 16.67 ms");
  }
  const residentGrowthBytes = Math.max(0, stats.finalResidentBytes - stats.baselineResidentBytes);
  if (residentGrowthBytes > SHARED_TEXTURE_PROBE_MEMORY_GROWTH_LIMIT_BYTES) {
    failures.push("resident memory growth exceeded the bounded-probe allowance");
  }
  if (!stats.ffmpegLaunched || stats.ffmpegExitCode !== 0) {
    failures.push("packaged FFmpeg did not launch and exit successfully");
  }
  if (stats.failed) failures.push(stats.failureReason || "native probe failed");
  if (!input.addonLoadedFromPackagedResources) {
    failures.push("addon was not loaded from the packaged resources path");
  }
  if (!input.addonSignatureVerified) failures.push("packaged addon signature did not verify");
  if (!input.appSignatureVerified) failures.push("packaged app signature did not verify");
  if (!input.ffmpegPathWasPackaged) failures.push("FFmpeg did not resolve from app.asar.unpacked");
  return {
    passed: failures.length === 0,
    failures,
    sourceFrameCountStart: receipts.at(0)?.frameCount ?? null,
    sourceFrameCountEnd: receipts.at(-1)?.frameCount ?? null,
    sourceTimestampStartUs: receipts.at(0)?.timestampUs ?? null,
    sourceTimestampEndUs: receipts.at(-1)?.timestampUs ?? null,
    markerOrdinalStart: receipts.at(0)?.markerOrdinal ?? null,
    markerOrdinalEnd: receipts.at(-1)?.markerOrdinal ?? null,
    uniqueMarkerCount,
    residentGrowthBytes,
  };
}
