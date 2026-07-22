import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  probeRecordingV3NativeAddon,
  RecordingV3NativeBridge,
  RecordingV3NativeError,
  RecordingV3NativeSession,
  recordingV3NativeAddonPath,
  recordingV3NativeAddonPathForRuntime,
  recordingV3NativeDimensionsSupported,
} from "./recording-v3-native-addon";

const hash = "a".repeat(64);

function stats() {
  return {
    handlesImported: 1,
    handlesReleased: 1,
    activeLeases: 0,
    peakActiveLeases: 1,
    deliveryFrames: 1,
    nativeLeasesAccepted: 1,
    nativeCommits: 1,
    encodedFrames: 1,
    leaseOverflows: 0,
    leaseAdmissionWaits: 0,
    leaseAdmissionWaitMaxMs: 0,
    backpressureEvents: 0,
    deadlineMisses: 0,
    sourceOrdinalGaps: 0,
    sourceTimestampRegressions: 0,
    maxQueueDepth: 1,
    maxReadyQueueDepth: 1,
    boundedPoolBytes: 8_294_400,
    serviceTimeP95Ms: 1,
    serviceTimeP99Ms: 1,
    serviceTimeMaxMs: 1,
    ffmpegExitCode: 0,
    failed: false,
    failureCode: "",
    failureReason: "",
  };
}

function receipt() {
  return {
    sourceEpoch: 0,
    activeSegment: 0,
    sourceFrameCount: 1,
    sourceTimestampUs: 16_667,
    activeTimePtsUs: 0,
    deliveryOrdinal: 0,
    nativeLeaseOrdinal: 0,
    nativeCommitOrdinal: 0,
    encodedOrdinal: 0,
    bgraSha256: hash,
    serviceTimeMs: 1,
  };
}

describe("Recording V3 native addon wrapper", () => {
  it("resolves development and packaged addon paths", () => {
    expect(
      recordingV3NativeAddonPath({
        isPackaged: false,
        resourcesPath: "/resources",
        desktopRoot: "/desktop",
      }),
    ).toBe(path.join("/desktop/native/macos-recording-v3/.build/storycapture_recording_v3.node"));
    expect(
      recordingV3NativeAddonPath({
        isPackaged: true,
        resourcesPath: "/resources",
        desktopRoot: "/desktop",
      }),
    ).toBe(path.join("/resources/native/macos/storycapture_recording_v3.node"));
  });

  it("uses source build output for the generated dev app and packaged resources for production", () => {
    const common = {
      app: { isPackaged: true },
      resourcesPath: "/resources",
      desktopRoot: "/desktop",
    } as const;
    expect(
      recordingV3NativeAddonPathForRuntime({
        ...common,
        env: { STORYCAPTURE_DEV_APP: "1" },
        executablePath:
          "/desktop/.electron-dev/StoryCapture Dev.app/Contents/MacOS/StoryCapture Dev",
      }),
    ).toBe(path.join("/desktop/native/macos-recording-v3/.build/storycapture_recording_v3.node"));
    expect(
      recordingV3NativeAddonPathForRuntime({
        ...common,
        env: { STORYCAPTURE_DEV_APP: "1" },
        executablePath: "/Applications/StoryCapture.app/Contents/MacOS/StoryCapture",
      }),
    ).toBe(path.join("/resources/native/macos/storycapture_recording_v3.node"));
  });

  it("requires the exact protocol hash and bounded capabilities", () => {
    const addon = {
      protocolVersion: 3,
      protocolHash: "f444d47f4f6d2cc71b709dc4677593e5047b8a61e34c76d7190fead3cf899c42",
      probe: () => ({
        protocolVersion: 3,
        protocolHash: "f444d47f4f6d2cc71b709dc4677593e5047b8a61e34c76d7190fead3cf899c42",
        ioSurface: true,
        nativeFfv1: true,
        maxQueuedLeases: 1,
        maxCompletedReceipts: 8,
      }),
      start: vi.fn(),
    } as never;
    expect(probeRecordingV3NativeAddon(addon)).toMatchObject({ maxQueuedLeases: 1 });
    expect(() =>
      probeRecordingV3NativeAddon({
        ...(addon as object),
        probe: () => ({ ...(addon as { probe(): object }).probe(), protocolHash: hash }),
      } as never),
    ).toThrowError(RecordingV3NativeError);
  });

  it("validates receipts and invokes native terminal cleanup once", () => {
    const stop = vi.fn(() => ({ stats: stats(), receipts: [receipt()] }));
    const abort = vi.fn(() => ({ stats: stats(), receipts: [] }));
    const raw = {
      submit: () => ({ nativeLeaseOrdinal: 0 }),
      pause: stats,
      resume: stats,
      closeEpoch: stats,
      drainReceipts: () => [],
      stop,
      abort,
      getStats: stats,
    };
    const session = new RecordingV3NativeSession(raw as never);

    expect(session.stop().receipts).toHaveLength(1);
    expect(session.stop().receipts).toHaveLength(1);
    expect(session.abort().receipts).toHaveLength(1);
    expect(stop).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
  });

  it("admits bounded session dimensions and rejects unsafe native starts", () => {
    expect(recordingV3NativeDimensionsSupported(1280, 800)).toBe(true);
    expect(recordingV3NativeDimensionsSupported(1920, 1080)).toBe(true);
    expect(recordingV3NativeDimensionsSupported(0, 800)).toBe(false);
    expect(recordingV3NativeDimensionsSupported(1280.5, 800)).toBe(false);
    expect(recordingV3NativeDimensionsSupported(1922, 1080)).toBe(false);
    expect(recordingV3NativeDimensionsSupported(1920, 1082)).toBe(false);

    const start = vi.fn(() => ({
      submit: () => ({ nativeLeaseOrdinal: 0 }),
      pause: stats,
      resume: stats,
      closeEpoch: stats,
      drainReceipts: () => [],
      stop: () => ({ stats: stats(), receipts: [] }),
      abort: () => ({ stats: stats(), receipts: [] }),
      getStats: stats,
    }));
    const bridge = new RecordingV3NativeBridge({
      protocolVersion: 3,
      protocolHash: "f444d47f4f6d2cc71b709dc4677593e5047b8a61e34c76d7190fead3cf899c42",
      probe: () => ({
        protocolVersion: 3,
        protocolHash: "f444d47f4f6d2cc71b709dc4677593e5047b8a61e34c76d7190fead3cf899c42",
        ioSurface: true,
        nativeFfv1: true,
        maxQueuedLeases: 1,
        maxCompletedReceipts: 8,
      }),
      start,
    } as never);
    bridge.start({ width: 1280, height: 800, ffmpegPath: "/ffmpeg", outputPath: "/out" });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1280, height: 800 }),
    );
    expect(() =>
      bridge.start({ width: 1922, height: 1080, ffmpegPath: "/ffmpeg", outputPath: "/out" }),
    ).toThrowError(expect.objectContaining({ code: "contract_mismatch" }));
    expect(start).toHaveBeenCalledOnce();
  });

  it("maps unknown native exceptions to addon crash", () => {
    const addon = {
      protocolVersion: 3,
      protocolHash: "f444d47f4f6d2cc71b709dc4677593e5047b8a61e34c76d7190fead3cf899c42",
      probe: () => {
        throw new Error("native exception");
      },
      start: vi.fn(),
    } as never;
    const bridge = new RecordingV3NativeBridge(addon);
    expect(() => bridge.probe()).toThrowError(
      expect.objectContaining({ code: "native_addon_crashed" }),
    );
  });
});
