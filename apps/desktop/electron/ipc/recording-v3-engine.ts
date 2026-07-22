import type {
  RecordingCadenceEvidenceV3,
  RecordingFailureCodeV3,
  RecordingFrameLedgerEntryV3,
  RecordingQualityEvidenceV3,
} from "@storycapture/shared-types/recording-v3";
import { readRecordingFrameLedgerV3 } from "@storycapture/shared-types/recording-v3";
import { verifyMasterAndCreateProxy } from "./recording-master";
import type {
  RecordingV3BrowserFrame,
  RecordingV3BrowserFrameSink,
} from "./recording-v3-browser-backend";
import type {
  RecordingV3NativeReceipt,
  RecordingV3NativeSession,
  RecordingV3NativeStats,
  RecordingV3NativeTerminalResult,
} from "./recording-v3-native-addon";
import { RecordingV3NativeError } from "./recording-v3-native-addon";

const FPS_NUMERATOR = 60;
const FPS_DENOMINATOR = 1;

export interface RecordingV3MonotonicClock {
  nowUs(): number;
}

export interface RecordingV3EngineResult {
  stats: RecordingV3NativeStats;
  receipts: readonly RecordingV3NativeReceipt[];
  activeDurationUs: number;
  expectedSlots: number;
}

export interface RecordingV3VerifiedArtifact {
  ledger: RecordingFrameLedgerEntryV3[];
  cadenceEvidence: RecordingCadenceEvidenceV3;
  runtimeQualityEvidence: RecordingQualityEvidenceV3;
}

export class RecordingV3EngineError extends Error {
  constructor(
    readonly code: RecordingFailureCodeV3,
    message: string,
  ) {
    super(message);
    this.name = "RecordingV3EngineError";
  }
}

function scheduledPtsUs(ordinal: number): number {
  return Math.round((ordinal * 1_000_000 * FPS_DENOMINATOR) / FPS_NUMERATOR);
}

function expectedSlotsAt(activeDurationUs: number): number {
  return Math.round(activeDurationUs / scheduledPtsUs(1)) + 1;
}

function safeSourceInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class RecordingV3Engine implements RecordingV3BrowserFrameSink {
  private sourceEpoch = 0;
  private activeSegment = 0;
  private deliveryOrdinal = 0;
  private previousSourceFrameCount: number | null = null;
  private previousSourceTimestampUs: number | null = null;
  private allowForwardGapOnNextFrame = false;
  private paused = false;
  private terminal = false;
  private aborted = false;
  private stickyFailure: RecordingV3EngineError | null = null;
  private readonly receipts: RecordingV3NativeReceipt[] = [];
  private activeStartedAtUs: number;
  private accumulatedActiveUs = 0;
  private schedulerOriginActiveUs: number | null = null;
  private stopActiveDurationUs: number | null = null;
  private pauseActiveElapsedUs: number | null = null;

  constructor(
    private readonly native: RecordingV3NativeSession,
    private readonly clock: RecordingV3MonotonicClock = {
      nowUs: () => Number(process.hrtime.bigint() / 1_000n),
    },
  ) {
    this.activeStartedAtUs = this.clock.nowUs();
  }

  submitSourceFrame(frame: RecordingV3BrowserFrame): void {
    this.requireOperational();
    if (this.stopActiveDurationUs !== null) {
      this.fail("contract_mismatch", "source frame arrived after the stop clock was frozen");
    }
    if (this.paused) this.fail("active_segment_violation", "source frame arrived while paused");
    if (!safeSourceInteger(frame.frameCount) || !safeSourceInteger(frame.timestampUs)) {
      this.fail("source_metadata_invalid", "Electron frame metadata was not a safe integer");
    }
    const activeElapsedUs = this.schedulerActiveElapsedUs();
    if (this.schedulerOriginActiveUs === null) this.schedulerOriginActiveUs = activeElapsedUs;
    const schedulerElapsedUs = activeElapsedUs - this.schedulerOriginActiveUs;
    const expectedNow = expectedSlotsAt(schedulerElapsedUs);
    const currentDelivery = this.deliveryOrdinal + 1;
    if (Math.abs(expectedNow - currentDelivery) > 1) {
      this.fail(
        "native_deadline_missed",
        `60 Hz scheduler expected slot ${expectedNow}; received delivery ${currentDelivery}`,
      );
    }
    if (
      this.previousSourceFrameCount !== null &&
      (this.allowForwardGapOnNextFrame
        ? frame.frameCount <= this.previousSourceFrameCount
        : frame.frameCount !== this.previousSourceFrameCount + 1)
    ) {
      this.fail(
        "source_ordinal_gap",
        "Electron frameCount was not contiguous in the active segment",
      );
    }
    if (
      this.previousSourceTimestampUs !== null &&
      frame.timestampUs <= this.previousSourceTimestampUs
    ) {
      this.fail("source_timestamp_regression", "Electron frame timestamp did not increase");
    }

    try {
      const accepted = this.native.submit({
        ioSurface: frame.ioSurface,
        sourceEpoch: this.sourceEpoch,
        activeSegment: this.activeSegment,
        sourceFrameCount: frame.frameCount,
        sourceTimestampUs: frame.timestampUs,
        activeTimePtsUs: scheduledPtsUs(this.deliveryOrdinal),
        deliveryOrdinal: this.deliveryOrdinal,
        nativeLeaseOrdinal: this.deliveryOrdinal,
      });
      if (accepted.nativeLeaseOrdinal !== this.deliveryOrdinal) {
        this.fail("contract_mismatch", "native lease ordinal did not match delivery ordinal");
      }
      this.appendReceipts(accepted.completedReceipts);
    } catch (error) {
      this.handleNativeError(error);
    }
    this.previousSourceFrameCount = frame.frameCount;
    this.previousSourceTimestampUs = frame.timestampUs;
    this.allowForwardGapOnNextFrame = false;
    this.deliveryOrdinal += 1;
  }

  pause(): void {
    this.requireOperational();
    if (this.paused) return;
    try {
      this.native.pause();
    } catch (error) {
      this.handleNativeError(error);
    }
    this.accumulatedActiveUs = this.pauseActiveElapsedUs ?? this.schedulerActiveElapsedUs();
    this.pauseActiveElapsedUs = null;
    this.paused = true;
  }

  resume(): void {
    this.requireOperational();
    if (!this.paused) this.fail("active_segment_violation", "only a paused session can resume");
    this.activeSegment += 1;
    try {
      this.native.resume({ sourceEpoch: this.sourceEpoch, activeSegment: this.activeSegment });
    } catch (error) {
      this.handleNativeError(error);
    }
    this.activeStartedAtUs = this.clock.nowUs();
    this.allowForwardGapOnNextFrame = true;
    this.paused = false;
  }

  closeEpoch(): void {
    this.requireOperational();
    this.sourceEpoch += 1;
    this.activeSegment += 1;
    try {
      this.native.closeEpoch({
        sourceEpoch: this.sourceEpoch,
        activeSegment: this.activeSegment,
      });
    } catch (error) {
      this.handleNativeError(error);
    }
    this.previousSourceFrameCount = null;
    this.previousSourceTimestampUs = null;
    this.allowForwardGapOnNextFrame = false;
  }

  stop(): RecordingV3EngineResult {
    this.requireOperational();
    if (this.schedulerOriginActiveUs === null) {
      this.fail("runtime_integrity_failed", "Recording V3 stopped without a source presentation");
    }
    const activeDurationUs =
      this.stopActiveDurationUs ?? this.schedulerActiveElapsedUs() - this.schedulerOriginActiveUs;
    const expectedSlots = expectedSlotsAt(activeDurationUs);
    if (expectedSlots !== this.deliveryOrdinal) {
      this.fail(
        "native_deadline_missed",
        `60 Hz scheduler expected ${expectedSlots} slots; received ${this.deliveryOrdinal}`,
      );
    }
    let terminal: RecordingV3NativeTerminalResult;
    try {
      terminal = this.native.stop();
    } catch (error) {
      if (error instanceof RecordingV3NativeError && error.terminalResult) {
        this.appendReceipts(error.terminalResult.receipts);
      }
      this.handleNativeError(error);
    }
    this.appendReceipts(terminal.receipts);
    this.terminal = true;
    this.assertTerminalInvariants(terminal.stats);
    return {
      stats: terminal.stats,
      receipts: [...this.receipts],
      activeDurationUs,
      expectedSlots,
    };
  }

  abort(): RecordingV3NativeTerminalResult {
    if (this.aborted) return this.native.abort();
    this.aborted = true;
    this.terminal = true;
    return this.native.abort();
  }

  recordingClockMs(): number {
    const activeUs =
      this.schedulerOriginActiveUs === null
        ? 0
        : this.schedulerActiveElapsedUs() - this.schedulerOriginActiveUs;
    return Math.max(0, activeUs / 1_000);
  }

  prepareStop(): "ready" | "frame_required" | "clock_pending" {
    this.requireOperational();
    if (this.stopActiveDurationUs !== null) return "ready";
    if (this.schedulerOriginActiveUs === null) {
      this.fail("runtime_integrity_failed", "Recording V3 stopped without a source presentation");
    }
    const activeDurationUs = this.schedulerActiveElapsedUs() - this.schedulerOriginActiveUs;
    const deficit = expectedSlotsAt(activeDurationUs) - this.deliveryOrdinal;
    if (deficit === 0) {
      this.stopActiveDurationUs = activeDurationUs;
      return "ready";
    }
    if (deficit === 1) return "frame_required";
    if (deficit === -1) return "clock_pending";
    this.fail(
      "native_deadline_missed",
      `60 Hz scheduler stop reconciliation drifted by ${deficit} slots`,
    );
  }

  preparePause(): "ready" | "frame_required" | "clock_pending" {
    this.requireOperational();
    if (this.pauseActiveElapsedUs !== null) return "ready";
    if (this.paused) return "ready";
    if (this.schedulerOriginActiveUs === null) {
      this.fail("runtime_integrity_failed", "Recording V3 paused without a source presentation");
    }
    const activeElapsedUs = this.schedulerActiveElapsedUs();
    const activeDurationUs = activeElapsedUs - this.schedulerOriginActiveUs;
    const deficit = expectedSlotsAt(activeDurationUs) - this.deliveryOrdinal;
    if (deficit === 0) {
      this.pauseActiveElapsedUs = activeElapsedUs;
      return "ready";
    }
    if (deficit === 1) return "frame_required";
    if (deficit === -1) return "clock_pending";
    this.fail(
      "native_deadline_missed",
      `60 Hz scheduler pause reconciliation drifted by ${deficit} slots`,
    );
  }

  fail(code: RecordingFailureCodeV3, message: string): never {
    if (!this.stickyFailure) this.stickyFailure = new RecordingV3EngineError(code, message);
    if (!this.aborted) {
      this.aborted = true;
      this.terminal = true;
      try {
        this.native.abort();
      } catch {
        // Preserve the first strict failure; abort remains best-effort and idempotent.
      }
    }
    throw this.stickyFailure;
  }

  private appendReceipts(receipts: readonly RecordingV3NativeReceipt[]): void {
    for (const receipt of receipts) {
      const ordinal = this.receipts.length;
      if (
        receipt.deliveryOrdinal !== ordinal ||
        receipt.nativeLeaseOrdinal !== ordinal ||
        receipt.nativeCommitOrdinal !== ordinal ||
        receipt.encodedOrdinal !== ordinal ||
        receipt.activeTimePtsUs !== scheduledPtsUs(ordinal)
      ) {
        this.fail("contract_mismatch", `native receipt ${ordinal} was not a 1:1 commit`);
      }
      this.receipts.push(receipt);
    }
  }

  private assertTerminalInvariants(stats: RecordingV3NativeStats): void {
    const expected = this.receipts.length;
    if (
      stats.failed ||
      stats.handlesImported !== stats.handlesReleased ||
      stats.activeLeases !== 0 ||
      stats.deliveryFrames !== expected ||
      stats.nativeLeasesAccepted !== expected ||
      stats.nativeCommits !== expected ||
      stats.encodedFrames !== expected ||
      stats.leaseOverflows !== 0 ||
      stats.backpressureEvents !== 0 ||
      stats.deadlineMisses !== 0 ||
      stats.sourceOrdinalGaps !== 0 ||
      stats.sourceTimestampRegressions !== 0 ||
      stats.maxQueueDepth > 1 ||
      stats.maxReadyQueueDepth > 1 ||
      stats.ffmpegExitCode !== 0
    ) {
      this.fail("runtime_integrity_failed", "native terminal counters violated Strict V3");
    }
  }

  private handleNativeError(error: unknown): never {
    if (error instanceof RecordingV3NativeError) this.fail(error.code, error.message);
    this.fail("native_addon_crashed", error instanceof Error ? error.message : String(error));
  }

  private requireOperational(): void {
    if (this.stickyFailure) throw this.stickyFailure;
    if (this.terminal) {
      throw new RecordingV3EngineError("contract_mismatch", "Recording V3 engine is terminal");
    }
  }

  private schedulerActiveElapsedUs(): number {
    if (this.paused) return this.accumulatedActiveUs;
    return this.accumulatedActiveUs + (this.clock.nowUs() - this.activeStartedAtUs);
  }
}

export async function verifyRecordingV3Artifact(input: {
  engineResult: RecordingV3EngineResult;
  masterPath: string;
  proxyPath: string;
  width: number;
  height: number;
  ffmpegBinary?: string;
}): Promise<RecordingV3VerifiedArtifact> {
  const legacyLedger = input.engineResult.receipts.map((receipt, index) => ({
    frame_index: index,
    source_sequence: receipt.sourceFrameCount,
    native_pts_us: receipt.activeTimePtsUs,
    sha256: receipt.bgraSha256,
  }));
  try {
    await verifyMasterAndCreateProxy({
      masterPath: input.masterPath,
      proxyPath: input.proxyPath,
      width: input.width,
      height: input.height,
      ledger: legacyLedger,
      binary: input.ffmpegBinary,
    });
  } catch (error) {
    throw new RecordingV3EngineError(
      "artifact_verification_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const ledger: RecordingFrameLedgerEntryV3[] = input.engineResult.receipts.map(
    (receipt, index) => ({
      version: 3,
      source_epoch: receipt.sourceEpoch,
      active_segment: receipt.activeSegment,
      source_frame_count: receipt.sourceFrameCount,
      source_timestamp_us: receipt.sourceTimestampUs,
      active_time_pts_us: receipt.activeTimePtsUs,
      delivery_ordinal: receipt.deliveryOrdinal + 1,
      native_lease_ordinal: receipt.nativeLeaseOrdinal + 1,
      native_commit_ordinal: receipt.nativeCommitOrdinal + 1,
      encoded_ordinal: receipt.encodedOrdinal + 1,
      decoded_ordinal: index + 1,
      bgra_sha256: receipt.bgraSha256,
    }),
  );
  if (!readRecordingFrameLedgerV3(ledger)) {
    throw new RecordingV3EngineError(
      "runtime_integrity_failed",
      "Recording V3 frame ledger violated the shared contract",
    );
  }
  const count = ledger.length;
  const cadenceEvidence: RecordingCadenceEvidenceV3 = {
    version: 3,
    guarantee_boundary: "electron_offscreen_delivery",
    source_ordinal_kind: "electron_frame_count",
    requested_fps: { numerator: 60, denominator: 1 },
    source_fps: { numerator: 60, denominator: 1 },
    stream_time_base: { numerator: 1, denominator: 60 },
    active_duration_us: input.engineResult.activeDurationUs,
    expected_slots: input.engineResult.expectedSlots,
    source_presentations: count,
    delivery_frames: input.engineResult.stats.deliveryFrames,
    native_commits: input.engineResult.stats.nativeCommits,
    encoded_frames: input.engineResult.stats.encodedFrames,
    artifact_decoded_frames: count,
    source_ordinal_gaps: input.engineResult.stats.sourceOrdinalGaps,
    source_timestamp_regressions: input.engineResult.stats.sourceTimestampRegressions,
    delivery_duplicates: 0,
    native_lease_overflows: input.engineResult.stats.leaseOverflows,
    native_backpressure_events: input.engineResult.stats.backpressureEvents,
    native_deadline_misses: input.engineResult.stats.deadlineMisses,
    artifact_pts_gaps: 0,
    artifact_pts_duplicates: 0,
    full_decode_succeeded: true,
    verdict: "passed",
    failure_codes: [],
  };
  const runtimeQualityEvidence: RecordingQualityEvidenceV3 = {
    version: 3,
    measurement_scope: "runtime_integrity",
    reference_identity: null,
    evaluated_frames: count,
    full_frame_luma_ssim: null,
    text_edge_roi_ssim: null,
    p01_edge_contrast_retention: null,
    edge_spread_increase_px: null,
    overlay_geometry_delta_px: null,
    color_channel_delta: null,
    lossless_master_hashes_match: true,
    certification_verdict: null,
    verdict: "passed",
    failure_codes: [],
  };
  return { ledger, cadenceEvidence, runtimeQualityEvidence };
}
