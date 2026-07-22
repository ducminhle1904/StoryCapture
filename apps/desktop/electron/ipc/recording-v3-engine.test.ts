import { readRecordingFrameLedgerV3 } from "@storycapture/shared-types/recording-v3";
import { describe, expect, it, vi } from "vitest";
import {
  RecordingV3Engine,
  type RecordingV3EngineError,
  verifyRecordingV3Artifact,
} from "./recording-v3-engine";
import {
  RecordingV3NativeError,
  type RecordingV3NativeReceipt,
  type RecordingV3NativeStats,
} from "./recording-v3-native-addon";

vi.mock("./recording-master", () => ({ verifyMasterAndCreateProxy: vi.fn() }));

const hash = "b".repeat(64);

class FakeNativeSession {
  readonly submitted: Array<Record<string, unknown>> = [];
  readonly resumes: Array<Record<string, number>> = [];
  readonly epochs: Array<Record<string, number>> = [];
  pauseCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  failure: RecordingV3NativeError | Error | null = null;

  submit(input: Record<string, unknown>) {
    if (this.failure) throw this.failure;
    const ordinal = Number(input.deliveryOrdinal);
    this.submitted.push(input);
    const completed: RecordingV3NativeReceipt = {
      sourceEpoch: Number(input.sourceEpoch),
      activeSegment: Number(input.activeSegment),
      sourceFrameCount: Number(input.sourceFrameCount),
      sourceTimestampUs: Number(input.sourceTimestampUs),
      activeTimePtsUs: Number(input.activeTimePtsUs),
      deliveryOrdinal: ordinal,
      nativeLeaseOrdinal: ordinal,
      nativeCommitOrdinal: ordinal,
      encodedOrdinal: ordinal,
      bgraSha256: hash,
      serviceTimeMs: 1,
    };
    return { nativeLeaseOrdinal: ordinal, completedReceipts: [completed] };
  }

  pause() {
    this.pauseCalls += 1;
    return this.stats();
  }

  resume(input: Record<string, number>) {
    this.resumes.push(input);
    return this.stats();
  }

  closeEpoch(input: Record<string, number>) {
    this.epochs.push(input);
    return this.stats();
  }

  stop() {
    this.stopCalls += 1;
    return { stats: this.stats(), receipts: [] };
  }

  abort() {
    this.abortCalls += 1;
    return { stats: this.stats(), receipts: [] };
  }

  stats(): RecordingV3NativeStats {
    const count = this.submitted.length;
    return {
      handlesImported: count,
      handlesReleased: count,
      activeLeases: 0,
      peakActiveLeases: Math.min(count, 1),
      deliveryFrames: count,
      nativeLeasesAccepted: count,
      nativeCommits: count,
      encodedFrames: count,
      leaseOverflows: 0,
      leaseAdmissionWaits: 0,
      leaseAdmissionWaitMaxMs: 0,
      backpressureEvents: 0,
      deadlineMisses: 0,
      sourceOrdinalGaps: 0,
      sourceTimestampRegressions: 0,
      maxQueueDepth: Math.min(count, 1),
      maxReadyQueueDepth: Math.min(count, 1),
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
}

function engineFor(fake: FakeNativeSession) {
  const clock = new FakeClock();
  return { engine: new RecordingV3Engine(fake as never, clock), clock };
}

class FakeClock {
  private value = 0;

  nowUs(): number {
    return this.value;
  }

  advance(us: number): void {
    this.value += us;
  }
}

describe("RecordingV3Engine", () => {
  it("reconciles 60 Hz PTS across pause segments and source epochs", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 10, timestampUs: 1_000 });
    clock.advance(16_667);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 11, timestampUs: 17_667 });
    engine.pause();
    clock.advance(5_000_000);
    engine.resume();
    clock.advance(16_666);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 20, timestampUs: 40_000 });
    engine.closeEpoch();
    clock.advance(16_667);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 1_000 });
    const result = engine.stop();

    expect(native.resumes).toEqual([{ sourceEpoch: 0, activeSegment: 1 }]);
    expect(native.epochs).toEqual([{ sourceEpoch: 1, activeSegment: 2 }]);
    expect(native.submitted.map((frame) => frame.activeTimePtsUs)).toEqual([
      0, 16_667, 33_333, 50_000,
    ]);
    expect(result.receipts.map((frame) => [frame.sourceEpoch, frame.activeSegment])).toEqual([
      [0, 0],
      [0, 0],
      [0, 1],
      [1, 2],
    ]);
    expect(result.activeDurationUs).toBe(50_000);
    expect(result.expectedSlots).toBe(4);
  });

  it.each([
    ["source_ordinal_gap", { frameCount: 12, timestampUs: 20_000 }],
    ["source_timestamp_regression", { frameCount: 11, timestampUs: 999 }],
  ] as const)("fails %s and aborts resources once", (code, second) => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 10, timestampUs: 1_000 });
    clock.advance(16_667);

    expect(() => engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), ...second })).toThrowError(
      expect.objectContaining({ code }),
    );
    expect(native.abortCalls).toBe(1);
    expect(() => engine.stop()).toThrowError(expect.objectContaining({ code }));
    expect(native.abortCalls).toBe(1);
  });

  it.each([
    ["queue full", "native_lease_overflow"],
    ["native backpressure", "native_backpressure"],
    ["slow encoder", "native_deadline_missed"],
    ["texture loss", "native_texture_lost"],
    ["disk failure", "native_encoder_exit_nonzero"],
    ["FFmpeg nonzero exit", "native_encoder_exit_nonzero"],
  ] as const)("fails closed for injected %s and releases once", (_scenario, code) => {
    const native = new FakeNativeSession();
    native.failure = new RecordingV3NativeError(code, code);
    const { engine } = engineFor(native);

    expect(() =>
      engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 }),
    ).toThrowError(expect.objectContaining({ code }));
    expect(native.abortCalls).toBe(1);
  });

  it("rejects a stale repeated Electron frame and releases once", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 10, timestampUs: 1_000 });
    clock.advance(16_667);

    expect(() =>
      engine.submitSourceFrame({
        ioSurface: Buffer.alloc(8),
        frameCount: 10,
        timestampUs: 17_667,
      }),
    ).toThrowError(expect.objectContaining({ code: "source_ordinal_gap" }));
    expect(native.abortCalls).toBe(1);
  });

  it("classifies an unexpected addon exception as a native crash", () => {
    const native = new FakeNativeSession();
    native.failure = new Error("injected crash");
    const { engine } = engineFor(native);
    expect(() =>
      engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 }),
    ).toThrowError(expect.objectContaining({ code: "native_addon_crashed" }));
    expect(native.abortCalls).toBe(1);
  });

  it("rejects a terminal counter mismatch", () => {
    const native = new FakeNativeSession();
    const { engine } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    vi.spyOn(native, "stats").mockReturnValue({ ...native.stats(), handlesReleased: 0 });

    expect(() => engine.stop()).toThrowError(
      expect.objectContaining<Partial<RecordingV3EngineError>>({
        code: "runtime_integrity_failed",
      }),
    );
  });

  it("fails closed when the monotonic 60 Hz scheduler observes missing slots", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    clock.advance(50_000);

    expect(() => engine.stop()).toThrowError(
      expect.objectContaining({ code: "native_deadline_missed" }),
    );
    expect(native.abortCalls).toBe(1);
  });

  it("allows one buffered delivery ahead but requires the clock to reconcile by stop", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 1, timestampUs: 16_667 });
    clock.advance(33_333);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 2, timestampUs: 33_333 });

    expect(engine.stop().expectedSlots).toBe(3);
  });

  it.each([
    10_000, 20_000,
  ])("quantizes stop jitter %ius to the nearest exact scheduler slot", (elapsedUs) => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    clock.advance(elapsedUs);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 1, timestampUs: 16_667 });

    expect(engine.stop().expectedSlots).toBe(2);
  });

  it("allows one late delivery while preserving exact stop reconciliation", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    clock.advance(33_333);

    expect(() =>
      engine.submitSourceFrame({
        ioSurface: Buffer.alloc(8),
        frameCount: 1,
        timestampUs: 16_667,
      }),
    ).not.toThrow();
    expect(() => engine.stop()).toThrowError(
      expect.objectContaining({ code: "native_deadline_missed" }),
    );
  });

  it("fails immediately when runtime delivery drifts by two scheduler slots", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    clock.advance(50_000);

    expect(() =>
      engine.submitSourceFrame({
        ioSurface: Buffer.alloc(8),
        frameCount: 1,
        timestampUs: 16_667,
      }),
    ).toThrowError(expect.objectContaining({ code: "native_deadline_missed" }));
  });

  it("reconciles an interactive stop with one final source frame", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    clock.advance(20_000);

    expect(engine.prepareStop()).toBe("frame_required");
    engine.submitSourceFrame({
      ioSurface: Buffer.alloc(8),
      frameCount: 1,
      timestampUs: 16_667,
    });
    expect(engine.prepareStop()).toBe("ready");
    expect(engine.stop().expectedSlots).toBe(2);
  });

  it("freezes a reconciled pause boundary before the event loop advances", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    clock.advance(20_000);
    expect(engine.preparePause()).toBe("frame_required");
    engine.submitSourceFrame({
      ioSurface: Buffer.alloc(8),
      frameCount: 1,
      timestampUs: 16_667,
    });
    expect(engine.preparePause()).toBe("ready");
    clock.advance(10_000);
    engine.pause();
    engine.resume();
    clock.advance(13_333);
    engine.submitSourceFrame({
      ioSurface: Buffer.alloc(8),
      frameCount: 2,
      timestampUs: 33_333,
    });

    expect(engine.prepareStop()).toBe("ready");
    expect(engine.stop().expectedSlots).toBe(3);
  });

  it("waits for the clock when a buffered delivery is one slot ahead", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 1, timestampUs: 16_667 });

    expect(engine.prepareStop()).toBe("clock_pending");
    clock.advance(10_000);
    expect(engine.prepareStop()).toBe("ready");
    expect(engine.stop().expectedSlots).toBe(2);
  });

  it("allows a forward frameCount gap on resume but rejects reset within the epoch", () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 10, timestampUs: 1_000 });
    engine.pause();
    engine.resume();
    clock.advance(16_667);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 20, timestampUs: 20_000 });
    engine.pause();
    engine.resume();
    clock.advance(16_666);

    expect(() =>
      engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 30_000 }),
    ).toThrowError(expect.objectContaining({ code: "source_ordinal_gap" }));
    expect(native.abortCalls).toBe(1);
  });

  it("emits a 1-based shared-contract ledger after full artifact verification", async () => {
    const native = new FakeNativeSession();
    const { engine, clock } = engineFor(native);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 0, timestampUs: 0 });
    clock.advance(16_667);
    engine.submitSourceFrame({ ioSurface: Buffer.alloc(8), frameCount: 1, timestampUs: 16_667 });
    const engineResult = engine.stop();

    const artifact = await verifyRecordingV3Artifact({
      engineResult,
      masterPath: "/master.mkv",
      proxyPath: "/proxy.mp4",
      width: 1280,
      height: 800,
    });

    expect(artifact.ledger.map((entry) => entry.delivery_ordinal)).toEqual([1, 2]);
    expect(readRecordingFrameLedgerV3(artifact.ledger)).toEqual(artifact.ledger);
    expect(artifact.cadenceEvidence.expected_slots).toBe(2);
    expect(artifact.runtimeQualityEvidence.measurement_scope).toBe("runtime_integrity");
  });
});
