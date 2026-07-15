import type { RecordingFrameLandmark } from "./recording-media-clock";

const SNAPSHOT_INTERVAL_MS = 1_000;
const STRICT_LOSS_RATIO = 0.001;

export type RecordingCapturePath = "raw_bgra" | "png";
export type RecordingHealthMode = "off" | "observe" | "required";
export type RecordingHealthProfile = "1080p30" | "1440p30" | "unsupported";
export type RecordingHealthVerdict = "pass" | "degraded" | "fail";
export type RecordingFirstFrameBarrierStatus =
  | "committed"
  | "degraded"
  | "failed"
  | "cancelled"
  | "observed_only"
  | "not_applicable";

export type RecordingFrameSkipReason =
  | "scheduler_late"
  | "paused"
  | "capture_busy"
  | "source_unavailable"
  | "backpressure"
  | "cancelled"
  | "unclassified";

export type RecordingFrameDropReason =
  | "capture_failed"
  | "submission_rejected"
  | "encoder_rejected"
  | "sink_not_acknowledged"
  | "target_lost"
  | "cancelled"
  | "unclassified";

export type RecordingHealthReasonCode =
  | "health_invariant_violation"
  | "encoder_failed"
  | "output_probe_missing"
  | "output_unreadable"
  | "zero_encoded_frames"
  | "first_frame_barrier_missing"
  | "first_frame_barrier_failed"
  | "first_frame_barrier_degraded"
  | "insufficient_encoded_frames"
  | "loss_gate_failed"
  | "presentation_sample_missing"
  | "presentation_latency_gate_failed"
  | "profile_not_strictly_supported";

export interface RecordingHealthV1 {
  version: 1;
  session_id: string;
  capture_path: RecordingCapturePath;
  profile: RecordingHealthProfile;
  verdict: RecordingHealthVerdict;
  reasons: readonly RecordingHealthReasonCode[];
  requested_fps: number;
  observed_fps: number | null;
  expected_frames: number;
  requested_frames: number;
  source_frames: number;
  submitted_frames: number;
  encoded_frames: number;
  dropped_frames: number;
  skipped_frames: number;
  loss_ratio: number;
  first_encoded_frame_ms: number | null;
  frame_gap_p95_ms: number | null;
  frame_gap_max_ms: number | null;
  backpressure_events: number;
  backpressure_total_ms: number;
  backpressure_high_water: number;
  action_to_presentation_p95_ms: number | null;
  output_readable: boolean | null;
  finalized: boolean;
}

export interface RecordingHealthUpdateV1 {
  event: "health-update";
  phase: "snapshot" | "final";
  health: RecordingHealthV1;
}

export interface RecordingHealthAccumulatorOptions {
  sessionId: string;
  capturePath: RecordingCapturePath;
  outputWidth: number;
  outputHeight: number;
  requestedFps: number;
  startedAtMs?: number;
  now?: () => number;
  onUpdate?: (update: RecordingHealthUpdateV1) => void;
}

export interface RecordingScheduledSlot {
  slot: number;
  ptsUs: number;
}

export interface RecordingSubmittedFrame extends RecordingScheduledSlot {}

export interface RecordingEncodedFrameAck extends RecordingFrameLandmark {
  committedAtMs?: number;
}

export interface RecordingBackpressureSpan {
  startedAtMs: number;
  endedAtMs: number;
  highWater: number;
}

export interface RecordingOutputProbe {
  readable: boolean;
  videoFrameCount: number | null;
}

export interface RecordingHealthFinalEvidence {
  activeMediaMs: number;
  encoderSucceeded: boolean;
}

const REASON_ORDER: readonly RecordingHealthReasonCode[] = [
  "health_invariant_violation",
  "encoder_failed",
  "output_probe_missing",
  "output_unreadable",
  "zero_encoded_frames",
  "first_frame_barrier_missing",
  "first_frame_barrier_failed",
  "first_frame_barrier_degraded",
  "insufficient_encoded_frames",
  "loss_gate_failed",
  "presentation_sample_missing",
  "presentation_latency_gate_failed",
  "profile_not_strictly_supported",
];

const FAIL_REASONS = new Set<RecordingHealthReasonCode>([
  "health_invariant_violation",
  "encoder_failed",
  "output_probe_missing",
  "output_unreadable",
  "zero_encoded_frames",
  "first_frame_barrier_missing",
  "first_frame_barrier_failed",
]);

const SKIP_REASONS = new Set<RecordingFrameSkipReason>([
  "scheduler_late",
  "paused",
  "capture_busy",
  "source_unavailable",
  "backpressure",
  "cancelled",
  "unclassified",
]);

const DROP_REASONS = new Set<RecordingFrameDropReason>([
  "capture_failed",
  "submission_rejected",
  "encoder_rejected",
  "sink_not_acknowledged",
  "target_lost",
  "cancelled",
  "unclassified",
]);

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function strictPositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function safeSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("sessionId must be an opaque, non-sensitive identifier");
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? null;
}

function profileFor(width: number, height: number, fps: number): RecordingHealthProfile {
  if (fps !== 30) return "unsupported";
  if (width === 1_920 && height === 1_080) return "1080p30";
  if (width === 2_560 && height === 1_440) return "1440p30";
  return "unsupported";
}

function frameIntervalGateMs(fps: number): number {
  return Math.ceil(100_000 / fps) / 100;
}

function freezeHealth(
  health: Omit<RecordingHealthV1, "reasons"> & {
    reasons: RecordingHealthReasonCode[];
  },
): RecordingHealthV1 {
  const reasons = Object.freeze([...health.reasons]);
  return Object.freeze({ ...health, reasons });
}

function freezeUpdate(
  phase: RecordingHealthUpdateV1["phase"],
  health: RecordingHealthV1,
): RecordingHealthUpdateV1 {
  return Object.freeze({ event: "health-update", phase, health });
}

export function recordingHealthMode(
  value = process.env.STORYCAPTURE_RECORDING_HEALTH_MODE,
): RecordingHealthMode {
  if (value === "observe" || value === "required") return value;
  return "off";
}

export class RecordingHealthAccumulator {
  readonly #sessionId: string;
  readonly #capturePath: RecordingCapturePath;
  readonly #profile: RecordingHealthProfile;
  readonly #requestedFps: number;
  readonly #startedAtMs: number;
  readonly #now: () => number;
  readonly #onUpdate: ((update: RecordingHealthUpdateV1) => void) | undefined;
  readonly #scheduled = new Map<number, number>();
  readonly #sourceSlots = new Set<number>();
  readonly #submitted = new Map<number, number>();
  readonly #skipped = new Map<number, RecordingFrameSkipReason>();
  readonly #dropped = new Map<number, RecordingFrameDropReason>();
  readonly #encodedPtsUs: number[] = [];
  readonly #actionPresentationMs: number[] = [];
  #visibleActions = 0;
  #activeMediaMs = 0;
  #firstEncodedFrameMs: number | null = null;
  #firstFrameBarrier: RecordingFirstFrameBarrierStatus | null = null;
  #backpressureEvents = 0;
  #backpressureTotalMs = 0;
  #backpressureHighWater = 0;
  #outputProbe: RecordingOutputProbe | null = null;
  #encoderSucceeded: boolean | null = null;
  #invariantViolation = false;
  #lastSnapshotAtMs: number | null = null;
  #latestUpdate: RecordingHealthUpdateV1 | null = null;
  #sealedHealth: RecordingHealthV1 | null = null;

  constructor(options: RecordingHealthAccumulatorOptions) {
    this.#sessionId = safeSessionId(options.sessionId);
    if (options.capturePath !== "raw_bgra" && options.capturePath !== "png") {
      throw new Error("capturePath must be raw_bgra or png");
    }
    this.#capturePath = options.capturePath;
    const width = strictPositive(options.outputWidth, "outputWidth");
    const height = strictPositive(options.outputHeight, "outputHeight");
    this.#requestedFps = strictPositive(options.requestedFps, "requestedFps");
    this.#profile = profileFor(width, height, this.#requestedFps);
    this.#now = options.now ?? Date.now;
    this.#startedAtMs = options.startedAtMs ?? this.#now();
    if (!finiteNonNegative(this.#startedAtMs)) {
      throw new Error("startedAtMs must be finite and non-negative");
    }
    this.#onUpdate = options.onUpdate;
  }

  get sealed(): boolean {
    return this.#sealedHealth != null;
  }

  recordScheduledSlot(slot: RecordingScheduledSlot): void {
    if (this.sealed) return;
    if (!this.#validSlot(slot.slot, slot.ptsUs)) return;
    const previous = this.#scheduled.get(slot.slot);
    if (previous != null && previous !== slot.ptsUs) {
      this.#invariantViolation = true;
      return;
    }
    this.#scheduled.set(slot.slot, slot.ptsUs);
    this.#activeMediaMs = Math.max(this.#activeMediaMs, slot.ptsUs / 1_000);
  }

  recordSourceFrame(slot: number): void {
    if (this.sealed) return;
    if (!nonNegativeInteger(slot) || !this.#scheduled.has(slot)) {
      this.#invariantViolation = true;
      return;
    }
    this.#sourceSlots.add(slot);
  }

  recordSubmission(frame: RecordingSubmittedFrame): void {
    if (this.sealed) return;
    if (!this.#validSlot(frame.slot, frame.ptsUs)) return;
    if (this.#skipped.has(frame.slot) || this.#dropped.has(frame.slot)) {
      this.#invariantViolation = true;
      return;
    }
    const scheduledPtsUs = this.#scheduled.get(frame.slot);
    if (scheduledPtsUs == null || scheduledPtsUs !== frame.ptsUs) {
      this.#invariantViolation = true;
      return;
    }
    const previous = this.#submitted.get(frame.slot);
    if (previous != null && previous !== frame.ptsUs) {
      this.#invariantViolation = true;
      return;
    }
    this.#submitted.set(frame.slot, frame.ptsUs);
  }

  recordSinkAck(frame: RecordingEncodedFrameAck): void {
    if (this.sealed) return;
    if (!nonNegativeInteger(frame.frameIndex) || !finiteNonNegative(frame.ptsUs)) {
      this.#invariantViolation = true;
      return;
    }
    const expectedIndex = this.#encodedPtsUs.length;
    const previousPtsUs = this.#encodedPtsUs.at(-1);
    if (
      frame.frameIndex !== expectedIndex ||
      (previousPtsUs != null && frame.ptsUs <= previousPtsUs)
    ) {
      this.#invariantViolation = true;
      return;
    }
    this.#encodedPtsUs.push(frame.ptsUs);
    this.#activeMediaMs = Math.max(this.#activeMediaMs, frame.ptsUs / 1_000);
    if (this.#firstEncodedFrameMs == null) {
      const committedAtMs = frame.committedAtMs ?? this.#now();
      if (!finiteNonNegative(committedAtMs) || committedAtMs < this.#startedAtMs) {
        this.#invariantViolation = true;
      } else {
        this.#firstEncodedFrameMs = committedAtMs - this.#startedAtMs;
      }
    }
  }

  recordSkipped(slot: number, reason: RecordingFrameSkipReason): void {
    if (this.sealed) return;
    if (!nonNegativeInteger(slot) || !SKIP_REASONS.has(reason) || !this.#scheduled.has(slot)) {
      this.#invariantViolation = true;
      return;
    }
    if (this.#submitted.has(slot) || this.#dropped.has(slot)) {
      this.#invariantViolation = true;
      return;
    }
    this.#skipped.set(slot, reason);
  }

  recordDropped(slot: number, reason: RecordingFrameDropReason): void {
    if (this.sealed) return;
    if (!nonNegativeInteger(slot) || !DROP_REASONS.has(reason) || !this.#submitted.has(slot)) {
      this.#invariantViolation = true;
      return;
    }
    if (this.#skipped.has(slot)) {
      this.#invariantViolation = true;
      return;
    }
    this.#dropped.set(slot, reason);
  }

  recordBackpressureSpan(span: RecordingBackpressureSpan): void {
    if (this.sealed) return;
    if (
      !finiteNonNegative(span.startedAtMs) ||
      !finiteNonNegative(span.endedAtMs) ||
      span.endedAtMs < span.startedAtMs ||
      !nonNegativeInteger(span.highWater)
    ) {
      this.#invariantViolation = true;
      return;
    }
    this.#backpressureEvents += 1;
    this.#backpressureTotalMs += span.endedAtMs - span.startedAtMs;
    this.#backpressureHighWater = Math.max(this.#backpressureHighWater, span.highWater);
  }

  recordFirstFrameBarrier(status: RecordingFirstFrameBarrierStatus): void {
    if (this.sealed) return;
    if (this.#firstFrameBarrier != null && this.#firstFrameBarrier !== status) {
      this.#invariantViolation = true;
      return;
    }
    this.#firstFrameBarrier = status;
  }

  recordActionPresentation(
    input: RecordingFrameLandmark,
    presentation: RecordingFrameLandmark | null,
  ): void {
    if (this.sealed) return;
    this.#visibleActions += 1;
    if (presentation == null) return;
    if (
      !nonNegativeInteger(input.frameIndex) ||
      !nonNegativeInteger(presentation.frameIndex) ||
      !finiteNonNegative(input.ptsUs) ||
      !finiteNonNegative(presentation.ptsUs) ||
      presentation.frameIndex <= input.frameIndex ||
      presentation.ptsUs <= input.ptsUs
    ) {
      this.#invariantViolation = true;
      return;
    }
    this.#actionPresentationMs.push((presentation.ptsUs - input.ptsUs) / 1_000);
  }

  recordOutputProbe(probe: RecordingOutputProbe): void {
    if (this.sealed) return;
    if (
      typeof probe.readable !== "boolean" ||
      (probe.videoFrameCount != null && !nonNegativeInteger(probe.videoFrameCount))
    ) {
      this.#invariantViolation = true;
      return;
    }
    this.#outputProbe = {
      readable: probe.readable,
      videoFrameCount: probe.videoFrameCount,
    };
  }

  recordActiveMediaDuration(activeMediaMs: number): void {
    if (this.sealed) return;
    if (!finiteNonNegative(activeMediaMs) || activeMediaMs < this.#activeMediaMs) {
      this.#invariantViolation = true;
      return;
    }
    this.#activeMediaMs = activeMediaMs;
  }

  snapshot(nowMs = this.#now()): RecordingHealthUpdateV1 | null {
    if (this.sealed) return null;
    if (!finiteNonNegative(nowMs)) {
      this.#invariantViolation = true;
      return null;
    }
    if (this.#lastSnapshotAtMs != null && nowMs - this.#lastSnapshotAtMs < SNAPSHOT_INTERVAL_MS) {
      return null;
    }
    this.#lastSnapshotAtMs = nowMs;
    return this.#publish("snapshot", this.#buildHealth(false));
  }

  latestUpdate(): RecordingHealthUpdateV1 | null {
    return this.#latestUpdate;
  }

  seal(evidence: RecordingHealthFinalEvidence): RecordingHealthV1 {
    if (this.#sealedHealth) return this.#sealedHealth;
    if (
      !finiteNonNegative(evidence.activeMediaMs) ||
      evidence.activeMediaMs < this.#activeMediaMs
    ) {
      this.#invariantViolation = true;
    } else {
      this.#activeMediaMs = evidence.activeMediaMs;
    }
    if (typeof evidence.encoderSucceeded !== "boolean") this.#invariantViolation = true;
    else this.#encoderSucceeded = evidence.encoderSucceeded;

    const health = this.#buildHealth(true);
    this.#sealedHealth = health;
    this.#publish("final", health);
    return health;
  }

  #publish(
    phase: RecordingHealthUpdateV1["phase"],
    health: RecordingHealthV1,
  ): RecordingHealthUpdateV1 {
    const update = freezeUpdate(phase, health);
    this.#latestUpdate = update;
    try {
      this.#onUpdate?.(update);
    } catch {
      // Health accumulation must survive a disconnected renderer/listener.
    }
    return update;
  }

  #validSlot(slot: number, ptsUs: number): boolean {
    if (!nonNegativeInteger(slot) || !finiteNonNegative(ptsUs)) {
      this.#invariantViolation = true;
      return false;
    }
    return true;
  }

  #buildHealth(finalized: boolean): RecordingHealthV1 {
    const expectedFrames = Math.max(
      1,
      Math.floor((this.#activeMediaMs * this.#requestedFps) / 1_000) + 1,
    );
    const inferredSkipped = Math.max(0, this.#scheduled.size - this.#submitted.size);
    const inferredDropped = Math.max(0, this.#submitted.size - this.#encodedPtsUs.length);
    const skippedFrames = Math.max(this.#skipped.size, inferredSkipped);
    const droppedFrames = Math.max(this.#dropped.size, inferredDropped);
    if (
      this.#submitted.size > this.#scheduled.size ||
      this.#encodedPtsUs.length > this.#submitted.size ||
      skippedFrames + this.#submitted.size > this.#scheduled.size ||
      droppedFrames + this.#encodedPtsUs.length > this.#submitted.size
    ) {
      this.#invariantViolation = true;
    }

    const gapsMs: number[] = [];
    for (let index = 1; index < this.#encodedPtsUs.length; index += 1) {
      const currentPtsUs = this.#encodedPtsUs[index];
      const previousPtsUs = this.#encodedPtsUs[index - 1];
      if (currentPtsUs == null || previousPtsUs == null) continue;
      gapsMs.push((currentPtsUs - previousPtsUs) / 1_000);
    }
    const firstPtsUs = this.#encodedPtsUs[0];
    const lastPtsUs = this.#encodedPtsUs.at(-1);
    const observedFps =
      this.#encodedPtsUs.length > 1 && firstPtsUs != null && lastPtsUs != null
        ? ((this.#encodedPtsUs.length - 1) * 1_000_000) / (lastPtsUs - firstPtsUs)
        : null;
    const actionP95 = percentile(this.#actionPresentationMs, 0.95);
    const lossRatio = (droppedFrames + skippedFrames) / expectedFrames;
    const reasons = new Set<RecordingHealthReasonCode>();

    if (this.#invariantViolation) reasons.add("health_invariant_violation");
    if (finalized) {
      if (this.#encoderSucceeded !== true) reasons.add("encoder_failed");
      if (this.#outputProbe == null) reasons.add("output_probe_missing");
      else if (!this.#outputProbe.readable) reasons.add("output_unreadable");
      if (this.#encodedPtsUs.length === 0 || this.#outputProbe?.videoFrameCount === 0) {
        reasons.add("zero_encoded_frames");
      }
      if (this.#firstFrameBarrier == null) reasons.add("first_frame_barrier_missing");
    }
    if (this.#firstFrameBarrier === "failed") reasons.add("first_frame_barrier_failed");
    if (
      this.#firstFrameBarrier === "degraded" ||
      this.#firstFrameBarrier === "cancelled" ||
      this.#firstFrameBarrier === "observed_only" ||
      this.#firstFrameBarrier === "not_applicable"
    ) {
      reasons.add("first_frame_barrier_degraded");
    }

    if (this.#profile === "unsupported") {
      reasons.add("profile_not_strictly_supported");
    } else {
      if (finalized && this.#encodedPtsUs.length === 1) {
        reasons.add("insufficient_encoded_frames");
      }
      if (lossRatio >= STRICT_LOSS_RATIO) reasons.add("loss_gate_failed");
      if (this.#visibleActions > this.#actionPresentationMs.length) {
        reasons.add("presentation_sample_missing");
      }
      if (actionP95 != null && actionP95 > frameIntervalGateMs(this.#requestedFps)) {
        reasons.add("presentation_latency_gate_failed");
      }
    }

    const orderedReasons = REASON_ORDER.filter((reason) => reasons.has(reason));
    const verdict: RecordingHealthVerdict = orderedReasons.some((reason) =>
      FAIL_REASONS.has(reason),
    )
      ? "fail"
      : orderedReasons.length > 0
        ? "degraded"
        : "pass";

    return freezeHealth({
      version: 1,
      session_id: this.#sessionId,
      capture_path: this.#capturePath,
      profile: this.#profile,
      verdict,
      reasons: orderedReasons,
      requested_fps: this.#requestedFps,
      observed_fps: observedFps,
      expected_frames: expectedFrames,
      requested_frames: this.#scheduled.size,
      source_frames: this.#sourceSlots.size,
      submitted_frames: this.#submitted.size,
      encoded_frames: this.#encodedPtsUs.length,
      dropped_frames: droppedFrames,
      skipped_frames: skippedFrames,
      loss_ratio: lossRatio,
      first_encoded_frame_ms: this.#firstEncodedFrameMs,
      frame_gap_p95_ms: percentile(gapsMs, 0.95),
      frame_gap_max_ms: gapsMs.length > 0 ? Math.max(...gapsMs) : null,
      backpressure_events: this.#backpressureEvents,
      backpressure_total_ms: this.#backpressureTotalMs,
      backpressure_high_water: this.#backpressureHighWater,
      action_to_presentation_p95_ms: actionP95,
      output_readable: this.#outputProbe?.readable ?? null,
      finalized,
    });
  }
}

export class RecordingHealthRegistry {
  readonly #sessions = new Map<string, RecordingHealthAccumulator>();

  register(options: RecordingHealthAccumulatorOptions): RecordingHealthAccumulator {
    if (this.#sessions.has(options.sessionId)) {
      throw new Error(`recording health session ${options.sessionId} already registered`);
    }
    const accumulator = new RecordingHealthAccumulator(options);
    this.#sessions.set(options.sessionId, accumulator);
    return accumulator;
  }

  get(sessionId: string): RecordingHealthAccumulator | null {
    return this.#sessions.get(sessionId) ?? null;
  }

  remove(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}

export const recordingHealth = new RecordingHealthRegistry();
