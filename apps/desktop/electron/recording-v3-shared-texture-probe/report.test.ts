import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { NativeSharedTextureProbeStats } from "./native-addon-loader";
import { evaluateSharedTextureProbeGate, SHARED_TEXTURE_PROBE_FRAME_COUNT } from "./report";

function passingStats(): NativeSharedTextureProbeStats {
  return {
    handlesImported: 600,
    handlesReleased: 600,
    activeLeases: 0,
    peakActiveLeases: 1,
    nativeAcceptedFrames: 600,
    ffmpegEnqueuedFrames: 600,
    queueOverflows: 0,
    maxReadyQueueDepth: 1,
    lastFrameCount: 699,
    lastTimestampUs: 10_000_000,
    serviceTimeP95Ms: 8,
    serviceTimeP99Ms: 12,
    serviceTimeMaxMs: 15,
    boundedPoolBytes: 16_588_800,
    baselineResidentBytes: 100_000_000,
    peakResidentBytes: 120_000_000,
    finalResidentBytes: 110_000_000,
    ffmpegLaunched: true,
    ffmpegExitCode: 0,
    failed: false,
    failureReason: "",
  };
}

function passingInput() {
  return {
    receipts: Array.from({ length: SHARED_TEXTURE_PROBE_FRAME_COUNT }, (_, index) => ({
      frameCount: index + 100,
      timestampUs: (index + 1) * 16_667,
      markerOrdinal: index + 1,
      serviceTimeMs: 8,
    })),
    stats: passingStats(),
    jsFrameBytes: 0,
    electronTexturesReceived: 600,
    electronTexturesReleased: 600,
    codedSizeMatches: true,
    addonLoadedFromPackagedResources: true,
    addonSignatureVerified: true,
    appSignatureVerified: true,
    ffmpegPathWasPackaged: true,
  };
}

describe("shared-texture feasibility gate", () => {
  it("accepts only the complete packaged 600-frame evidence set", () => {
    expect(evaluateSharedTextureProbeGate(passingInput())).toMatchObject({
      passed: true,
      failures: [],
      uniqueMarkerCount: 600,
    });
  });

  it("fails closed on synthetic source facts, overflow, latency, bytes, or signing gaps", () => {
    const input = passingInput();
    input.receipts[20] = { ...input.receipts[20], frameCount: 999, markerOrdinal: 999 };
    input.stats.queueOverflows = 1;
    input.stats.serviceTimeP99Ms = 17;
    input.jsFrameBytes = 1;
    input.addonSignatureVerified = false;
    expect(evaluateSharedTextureProbeGate(input)).toMatchObject({ passed: false });
    expect(evaluateSharedTextureProbeGate(input).failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("frameCount discontinuity"),
        expect.stringContaining("marker discontinuity"),
        "native queue overflowed",
        "native readback/enqueue p99 exceeded 16.67 ms",
        "full-frame bytes crossed the JavaScript boundary",
        "packaged addon signature did not verify",
      ]),
    );
  });

  it("keeps bitmap and encoded-image fallbacks out of the packaged probe", () => {
    const mainSource = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts"),
      "utf8",
    );
    expect(mainSource).not.toMatch(/\.toBitmap\s*\(/);
    expect(mainSource).not.toMatch(/\.toPNG\s*\(/);
    expect(mainSource).not.toMatch(/\.toJPEG\s*\(/);
  });
});
