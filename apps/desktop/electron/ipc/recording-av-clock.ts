import { recordEngineLog } from "./recording-observability";

export const RECORDING_AV_DRIFT_LIMIT_US = 80_000;
export const RECORDING_AV_MAX_MUX_DURATION_US = 24 * 60 * 60 * 1_000_000;

export type RecordingAvMode = "legacy" | "shadow" | "unified";

export function recordingAvMode(
  value = process.env.STORYCAPTURE_RECORDING_AV_MODE,
): RecordingAvMode {
  return value === "shadow" || value === "unified" ? value : "legacy";
}

export function recordingUsesLiveVideoSink(input: {
  mode: RecordingAvMode;
  targetKind: string;
  audioRequested: boolean;
  readinessEnforced: boolean;
}): boolean {
  if (input.readinessEnforced) return true;
  return (
    input.targetKind === "author_preview" && (!input.audioRequested || input.mode === "unified")
  );
}

export type RecordingAudioContainer = "webm" | "ogg" | "mp4";
export type RecordingAudioStreamState =
  | "idle"
  | "streaming"
  | "paused"
  | "ended"
  | "aborted"
  | "failed";
export type RecordingAvVerdict = "pass" | "degraded" | "fail";
export type RecordingAvFailureCode =
  | "audio_backpressure_overflow"
  | "audio_chunk_not_durable"
  | "audio_drain_incomplete"
  | "audio_missing"
  | "audio_sequence_conflict"
  | "audio_sequence_gap"
  | "audio_stream_aborted"
  | "audio_stream_incomplete"
  | "audio_unreadable"
  | "av_clock_transition_invalid"
  | "av_end_drift_exceeded"
  | "av_start_drift_exceeded"
  | "mux_duration_unbounded"
  | "mux_failed"
  | "mux_validation_failed"
  | "video_duration_invalid"
  | "video_pts_invalid";

export class RecordingAvClockError extends Error {
  readonly code: RecordingAvFailureCode;

  constructor(code: RecordingAvFailureCode, message: string) {
    super(message);
    this.name = "RecordingAvClockError";
    this.code = code;
  }
}

export interface RecordingAudioBeginMetadata {
  sequence: number;
  sessionId: string;
  audioCaptureId: string;
  monotonicEpochMs: number;
  mimeType: string;
  container?: RecordingAudioContainer;
}

export interface RecordingAudioChunkMetadata {
  sequence: number;
  monotonicEpochMs: number;
  byteLength: number;
  durationUs?: number;
}

export interface RecordingAudioControlMetadata {
  sequence: number;
  monotonicEpochMs: number;
}

export interface RecordingAudioEndMetadata extends RecordingAudioControlMetadata {
  totalBytes: number;
  totalChunks: number;
}

export interface RecordingAudioAbortMetadata extends RecordingAudioControlMetadata {
  reason: "audio_backpressure_overflow" | "audio_stream_aborted";
}

export interface RecordingAudioOperationAck {
  status: "accepted" | "duplicate";
  sequence: number;
  durable: boolean;
  nextSequence: number;
}

export interface RecordingAudioPauseSpan {
  started_monotonic_epoch_ms: number;
  ended_monotonic_epoch_ms: number;
}

export interface RecordingAudioStreamSnapshot {
  version: 1;
  state: RecordingAudioStreamState;
  session_id: string | null;
  audio_capture_id: string | null;
  mime_type: string | null;
  container: RecordingAudioContainer | null;
  next_sequence: number;
  chunks_durable: number;
  bytes_durable: number;
  pending_sequence: number | null;
  started_monotonic_epoch_ms: number | null;
  ended_monotonic_epoch_ms: number | null;
  pause_spans: readonly RecordingAudioPauseSpan[];
  final_drain_complete: boolean;
  failure_reason: RecordingAvFailureCode | null;
}

type CanonicalAudioOperation =
  | {
      kind: "begin";
      sequence: number;
      monotonicEpochMs: number;
      sessionId: string;
      audioCaptureId: string;
      mimeType: string;
      container: RecordingAudioContainer;
    }
  | ({ kind: "chunk" } & Required<RecordingAudioChunkMetadata>)
  | ({ kind: "pause" | "resume" } & RecordingAudioControlMetadata)
  | ({ kind: "end" } & RecordingAudioEndMetadata)
  | ({ kind: "abort" } & RecordingAudioAbortMetadata);

interface StoredAudioOperation {
  fingerprint: string;
  operation: CanonicalAudioOperation;
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.includes("\0")) throw new Error(`${label} must not contain NUL bytes`);
  return normalized;
}

function monotonicMs(value: number, label = "monotonicEpochMs"): number {
  const result = finiteNumber(value, label);
  if (result < 0) throw new Error(`${label} must be non-negative`);
  return result;
}

function microsecondsFromMilliseconds(value: number): number {
  const result = Math.round(value * 1_000);
  if (!Number.isSafeInteger(result))
    throw new Error("microsecond value exceeds safe integer range");
  return result;
}

function operationFingerprint(operation: CanonicalAudioOperation): string {
  return JSON.stringify(operation);
}

function frozen<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) frozen(child as object);
  }
  return Object.freeze(value);
}

export function monotonicEpochMilliseconds(timeOriginMs: number, performanceNowMs: number): number {
  const result =
    finiteNumber(timeOriginMs, "timeOriginMs") + finiteNumber(performanceNowMs, "performanceNowMs");
  return monotonicMs(result);
}

export function recordingAudioContainerForMimeType(mimeType: string): RecordingAudioContainer {
  const essence = nonEmpty(mimeType, "mimeType").split(";", 1)[0]?.trim().toLowerCase();
  if (essence === "audio/webm") return "webm";
  if (essence === "audio/ogg") return "ogg";
  if (essence === "audio/mp4") return "mp4";
  throw new Error(`unsupported recording audio MIME type: ${mimeType}`);
}

/**
 * Validates the ordered host-side audio protocol. A chunk sequence becomes
 * acknowledgeable only after acknowledgeChunk confirms its bytes are durable.
 */
export class RecordingAudioStreamValidator {
  #state: RecordingAudioStreamState = "idle";
  #sessionId: string | null = null;
  #audioCaptureId: string | null = null;
  #mimeType: string | null = null;
  #container: RecordingAudioContainer | null = null;
  #nextSequence = 0;
  #chunksDurable = 0;
  #bytesDurable = 0;
  #startedAtMs: number | null = null;
  #endedAtMs: number | null = null;
  #lastOperationAtMs: number | null = null;
  #lastControl: "pause" | "resume" | null = null;
  #openPauseAtMs: number | null = null;
  #pauseSpans: RecordingAudioPauseSpan[] = [];
  #pending: (CanonicalAudioOperation & { kind: "chunk" }) | null = null;
  #history = new Map<number, StoredAudioOperation>();
  #failureReason: RecordingAvFailureCode | null = null;

  begin(input: RecordingAudioBeginMetadata): RecordingAudioOperationAck {
    const mimeType = nonEmpty(input.mimeType, "mimeType");
    const inferredContainer = recordingAudioContainerForMimeType(mimeType);
    if (input.container && input.container !== inferredContainer) {
      throw new Error(`audio container ${input.container} does not match MIME type ${mimeType}`);
    }
    const operation: CanonicalAudioOperation = {
      kind: "begin",
      sequence: nonNegativeSafeInteger(input.sequence, "sequence"),
      monotonicEpochMs: monotonicMs(input.monotonicEpochMs),
      sessionId: nonEmpty(input.sessionId, "sessionId"),
      audioCaptureId: nonEmpty(input.audioCaptureId, "audioCaptureId"),
      mimeType,
      container: inferredContainer,
    };
    if (this.#state !== "idle") {
      const duplicate = this.#duplicate(operation);
      if (duplicate) return duplicate;
      return this.#fail("av_clock_transition_invalid", "audio stream has already begun");
    }
    if (operation.sequence !== 0) {
      return this.#fail("audio_sequence_gap", "audio begin sequence must be zero");
    }
    this.#sessionId = operation.sessionId;
    this.#audioCaptureId = operation.audioCaptureId;
    this.#mimeType = operation.mimeType;
    this.#container = operation.container;
    this.#startedAtMs = operation.monotonicEpochMs;
    this.#state = "streaming";
    return this.#commit(operation);
  }

  prepareChunk(input: RecordingAudioChunkMetadata): RecordingAudioOperationAck {
    this.#assertWritable("chunk");
    const operation: CanonicalAudioOperation & { kind: "chunk" } = {
      kind: "chunk",
      sequence: nonNegativeSafeInteger(input.sequence, "sequence"),
      monotonicEpochMs: monotonicMs(input.monotonicEpochMs),
      byteLength: nonNegativeSafeInteger(input.byteLength, "byteLength"),
      durationUs: nonNegativeSafeInteger(input.durationUs ?? 0, "durationUs"),
    };
    if (operation.byteLength === 0) throw new Error("audio chunk byteLength must be positive");
    const duplicate = this.#duplicate(operation);
    if (duplicate) return duplicate;
    if (this.#pending) {
      return this.#fail(
        "audio_chunk_not_durable",
        `audio chunk ${this.#pending.sequence} must be durable before accepting another chunk`,
      );
    }
    this.#assertExpectedSequence(operation.sequence);
    this.#assertTimestamp(operation.monotonicEpochMs);
    this.#pending = operation;
    return this.#ack("accepted", operation.sequence, false);
  }

  acknowledgeChunk(sequence: number): RecordingAudioOperationAck {
    const normalized = nonNegativeSafeInteger(sequence, "sequence");
    const committed = this.#history.get(normalized);
    if (committed?.operation.kind === "chunk") return this.#ack("duplicate", normalized, true);
    if (!this.#pending || this.#pending.sequence !== normalized) {
      return this.#fail(
        "audio_chunk_not_durable",
        `audio chunk ${normalized} is not awaiting a durable acknowledgement`,
      );
    }
    const operation = this.#pending;
    this.#pending = null;
    this.#chunksDurable += 1;
    this.#bytesDurable += operation.byteLength;
    return this.#commit(operation);
  }

  pause(input: RecordingAudioControlMetadata): RecordingAudioOperationAck {
    const operation = this.#controlOperation("pause", input);
    const duplicate = this.#duplicate(operation);
    if (duplicate) return duplicate;
    this.#assertControlReady(operation);
    if (this.#state === "paused") {
      if (this.#lastControl !== "pause") {
        return this.#fail("av_clock_transition_invalid", "audio pause ordering is invalid");
      }
    } else {
      this.#state = "paused";
      this.#openPauseAtMs = operation.monotonicEpochMs;
    }
    this.#lastControl = "pause";
    return this.#commit(operation);
  }

  resume(input: RecordingAudioControlMetadata): RecordingAudioOperationAck {
    const operation = this.#controlOperation("resume", input);
    const duplicate = this.#duplicate(operation);
    if (duplicate) return duplicate;
    this.#assertControlReady(operation);
    if (this.#state === "streaming") {
      if (this.#lastControl !== "resume") {
        return this.#fail("av_clock_transition_invalid", "audio resume arrived before a pause");
      }
    } else {
      const startedAt = this.#openPauseAtMs;
      if (startedAt === null || operation.monotonicEpochMs < startedAt) {
        return this.#fail("av_clock_transition_invalid", "audio pause span is invalid");
      }
      this.#pauseSpans.push({
        started_monotonic_epoch_ms: startedAt,
        ended_monotonic_epoch_ms: operation.monotonicEpochMs,
      });
      this.#openPauseAtMs = null;
      this.#state = "streaming";
    }
    this.#lastControl = "resume";
    return this.#commit(operation);
  }

  end(input: RecordingAudioEndMetadata): RecordingAudioOperationAck {
    const operation: CanonicalAudioOperation = {
      kind: "end",
      sequence: nonNegativeSafeInteger(input.sequence, "sequence"),
      monotonicEpochMs: monotonicMs(input.monotonicEpochMs),
      totalBytes: nonNegativeSafeInteger(input.totalBytes, "totalBytes"),
      totalChunks: nonNegativeSafeInteger(input.totalChunks, "totalChunks"),
    };
    const duplicate = this.#duplicate(operation);
    if (duplicate) return duplicate;
    this.#assertWritable("end");
    if (this.#pending) {
      return this.#fail(
        "audio_drain_incomplete",
        `audio chunk ${this.#pending.sequence} is not durable at end`,
      );
    }
    this.#assertExpectedSequence(operation.sequence);
    this.#assertTimestamp(operation.monotonicEpochMs);
    if (
      operation.totalBytes !== this.#bytesDurable ||
      operation.totalChunks !== this.#chunksDurable
    ) {
      return this.#fail(
        "audio_drain_incomplete",
        "audio end totals do not match the durable chunk receipt",
      );
    }
    if (this.#state === "paused") this.#closePause(operation.monotonicEpochMs);
    this.#state = "ended";
    this.#endedAtMs = operation.monotonicEpochMs;
    return this.#commit(operation);
  }

  abort(input: RecordingAudioAbortMetadata): RecordingAudioOperationAck {
    const operation: CanonicalAudioOperation = {
      kind: "abort",
      sequence: nonNegativeSafeInteger(input.sequence, "sequence"),
      monotonicEpochMs: monotonicMs(input.monotonicEpochMs),
      reason: input.reason,
    };
    const duplicate = this.#duplicate(operation);
    if (duplicate) return duplicate;
    if (this.#state === "ended" || this.#state === "aborted") {
      return this.#fail("av_clock_transition_invalid", "audio stream is already terminal");
    }
    const expected = this.#pending ? this.#pending.sequence + 1 : this.#nextSequence;
    if (operation.sequence !== expected) this.#assertExpectedSequence(operation.sequence);
    this.#assertTimestamp(operation.monotonicEpochMs);
    if (this.#state === "paused") this.#closePause(operation.monotonicEpochMs);
    this.#pending = null;
    this.#state = "aborted";
    this.#failureReason = operation.reason;
    this.#endedAtMs = operation.monotonicEpochMs;
    return this.#commit(operation);
  }

  snapshot(): Readonly<RecordingAudioStreamSnapshot> {
    return frozen({
      version: 1 as const,
      state: this.#state,
      session_id: this.#sessionId,
      audio_capture_id: this.#audioCaptureId,
      mime_type: this.#mimeType,
      container: this.#container,
      next_sequence: this.#nextSequence,
      chunks_durable: this.#chunksDurable,
      bytes_durable: this.#bytesDurable,
      pending_sequence: this.#pending?.sequence ?? null,
      started_monotonic_epoch_ms: this.#startedAtMs,
      ended_monotonic_epoch_ms: this.#endedAtMs,
      pause_spans: this.#pauseSpans.map((span) => ({ ...span })),
      final_drain_complete: this.#state === "ended" && this.#pending === null,
      failure_reason: this.#failureReason,
    });
  }

  #controlOperation(
    kind: "pause" | "resume",
    input: RecordingAudioControlMetadata,
  ): CanonicalAudioOperation & { kind: "pause" | "resume" } {
    return {
      kind,
      sequence: nonNegativeSafeInteger(input.sequence, "sequence"),
      monotonicEpochMs: monotonicMs(input.monotonicEpochMs),
    };
  }

  #assertWritable(operation: string): void {
    if (this.#state === "failed") {
      throw new RecordingAvClockError(
        this.#failureReason ?? "audio_stream_incomplete",
        `cannot accept ${operation} after audio stream failure`,
      );
    }
    if (this.#state === "idle" || this.#state === "ended" || this.#state === "aborted") {
      this.#fail(
        "av_clock_transition_invalid",
        `cannot accept ${operation} while audio stream is ${this.#state}`,
      );
    }
  }

  #assertControlReady(operation: CanonicalAudioOperation): void {
    this.#assertWritable(operation.kind);
    if (this.#pending) {
      this.#fail(
        "audio_chunk_not_durable",
        `audio chunk ${this.#pending.sequence} must be durable before ${operation.kind}`,
      );
    }
    this.#assertExpectedSequence(operation.sequence);
    this.#assertTimestamp(operation.monotonicEpochMs);
  }

  #assertExpectedSequence(sequence: number): void {
    if (sequence > this.#nextSequence) {
      this.#fail(
        "audio_sequence_gap",
        `expected audio sequence ${this.#nextSequence}, received ${sequence}`,
      );
    }
    if (sequence < this.#nextSequence) {
      this.#fail(
        "audio_sequence_conflict",
        `audio sequence ${sequence} conflicts with its receipt`,
      );
    }
  }

  #assertTimestamp(value: number): void {
    if (this.#lastOperationAtMs !== null && value < this.#lastOperationAtMs) {
      this.#fail("av_clock_transition_invalid", "audio operation monotonic time moved backwards");
    }
  }

  #duplicate(operation: CanonicalAudioOperation): RecordingAudioOperationAck | null {
    if (this.#pending?.sequence === operation.sequence) {
      if (operationFingerprint(this.#pending) !== operationFingerprint(operation)) {
        return this.#fail(
          "audio_sequence_conflict",
          `pending audio sequence ${operation.sequence} has different metadata`,
        );
      }
      return this.#ack("duplicate", operation.sequence, false);
    }
    const stored = this.#history.get(operation.sequence);
    if (!stored) return null;
    if (stored.fingerprint !== operationFingerprint(operation)) {
      return this.#fail(
        "audio_sequence_conflict",
        `audio sequence ${operation.sequence} has different metadata`,
      );
    }
    return this.#ack("duplicate", operation.sequence, true);
  }

  #commit(operation: CanonicalAudioOperation): RecordingAudioOperationAck {
    this.#history.set(operation.sequence, {
      operation,
      fingerprint: operationFingerprint(operation),
    });
    this.#lastOperationAtMs = operation.monotonicEpochMs;
    this.#nextSequence = operation.sequence + 1;
    return this.#ack("accepted", operation.sequence, true);
  }

  #ack(
    status: RecordingAudioOperationAck["status"],
    sequence: number,
    durable: boolean,
  ): RecordingAudioOperationAck {
    return { status, sequence, durable, nextSequence: this.#nextSequence };
  }

  #closePause(endedAtMs: number): void {
    if (this.#openPauseAtMs === null || endedAtMs < this.#openPauseAtMs) {
      this.#fail("av_clock_transition_invalid", "audio pause span is invalid");
    }
    this.#pauseSpans.push({
      started_monotonic_epoch_ms: this.#openPauseAtMs,
      ended_monotonic_epoch_ms: endedAtMs,
    });
    this.#openPauseAtMs = null;
  }

  #fail(code: RecordingAvFailureCode, message: string): never {
    this.#state = "failed";
    this.#failureReason = code;
    throw new RecordingAvClockError(code, message);
  }
}

interface AbsolutePauseSpan {
  startedAtMs: number;
  endedAtMs: number;
}

export interface RecordingAvPauseSpan {
  started_monotonic_epoch_ms: number;
  ended_monotonic_epoch_ms: number;
  duration_us: number;
  normalized_start_pts_us: number;
  normalized_end_pts_us: number;
}

export interface RecordingAvAlignment {
  clock: "encoded_video_pts";
  unit: "us";
  video_start_pts_us: number;
  video_end_pts_us: number;
  video_duration_us: number;
  video_origin_monotonic_epoch_ms: number;
  finalized_monotonic_epoch_ms: number;
  audio_start_offset_us: number | null;
  audio_end_drift_us: number | null;
  audio_active_duration_us: number | null;
  audio_mapped_start_pts_us: number | null;
  audio_mapped_end_pts_us: number | null;
  pause_spans: readonly RecordingAvPauseSpan[];
}

export interface RecordingAvOutcome {
  verdict: RecordingAvVerdict;
  reasons: readonly RecordingAvFailureCode[];
  drift_limit_us: number;
}

export interface RecordingAvSnapshot extends RecordingAvAlignment {
  version: 1;
  session_id: string;
  audio: Readonly<RecordingAudioStreamSnapshot> | null;
  outcome: Readonly<RecordingAvOutcome>;
}

export interface RecordingAvAlignmentInput {
  videoEndPtsUs: number;
  finalizedMonotonicEpochMs: number;
  audioStream?: Readonly<RecordingAudioStreamSnapshot> | null;
}

export interface RecordingAvFinalizeInput extends RecordingAvAlignmentInput {
  audioReadable?: boolean;
  muxSucceeded?: boolean;
  muxValidated?: boolean;
  explicitVideoDurationBounded?: boolean;
}

export interface RecordingAvClassificationInput {
  audioRequested: boolean;
  audioReadable: boolean;
  audioStreamComplete: boolean;
  audioFailureReason?: RecordingAvFailureCode | null;
  muxSucceeded: boolean;
  muxValidated: boolean;
  explicitVideoDurationBounded: boolean;
  audioStartOffsetUs: number | null;
  audioEndDriftUs: number | null;
  driftLimitUs?: number;
}

export function classifyRecordingAv(input: RecordingAvClassificationInput): RecordingAvOutcome {
  const driftLimitUs = nonNegativeSafeInteger(
    input.driftLimitUs ?? RECORDING_AV_DRIFT_LIMIT_US,
    "driftLimitUs",
  );
  if (!input.audioRequested) {
    return frozen({ verdict: "pass" as const, reasons: [], drift_limit_us: driftLimitUs });
  }
  const failures: RecordingAvFailureCode[] = [];
  if (!input.audioStreamComplete)
    failures.push(input.audioFailureReason ?? "audio_stream_incomplete");
  if (!input.audioReadable) failures.push("audio_unreadable");
  if (!input.muxSucceeded) failures.push("mux_failed");
  if (!input.muxValidated) failures.push("mux_validation_failed");
  if (!input.explicitVideoDurationBounded) failures.push("mux_duration_unbounded");
  if (failures.length > 0) {
    return frozen({
      verdict: "fail" as const,
      reasons: [...new Set(failures)],
      drift_limit_us: driftLimitUs,
    });
  }
  const degraded: RecordingAvFailureCode[] = [];
  if (input.audioStartOffsetUs === null || input.audioEndDriftUs === null) {
    return frozen({
      verdict: "fail" as const,
      reasons: ["audio_missing"],
      drift_limit_us: driftLimitUs,
    });
  }
  if (Math.abs(input.audioStartOffsetUs) > driftLimitUs) degraded.push("av_start_drift_exceeded");
  if (Math.abs(input.audioEndDriftUs) > driftLimitUs) degraded.push("av_end_drift_exceeded");
  return frozen({
    verdict: degraded.length > 0 ? ("degraded" as const) : ("pass" as const),
    reasons: degraded,
    drift_limit_us: driftLimitUs,
  });
}

/** Encoded video PTS is the only duration authority; monotonic time only aligns audio. */
export class RecordingAvClock {
  readonly sessionId: string;
  #videoStartPtsUs: number | null = null;
  #lastVideoPtsUs: number | null = null;
  #videoOriginAtMs: number | null = null;
  #lastVideoAtMs: number | null = null;
  #state: "recording" | "paused" | "finalized" = "recording";
  #lastControl: "pause" | "resume" | null = null;
  #lastControlAtMs: number | null = null;
  #openPauseAtMs: number | null = null;
  #pauseSpans: AbsolutePauseSpan[] = [];
  #finalSnapshot: Readonly<RecordingAvSnapshot> | null = null;

  constructor(sessionId: string) {
    this.sessionId = nonEmpty(sessionId, "sessionId");
  }

  observeEncodedVideoFrame(input: { ptsUs: number; monotonicEpochMs: number }): void {
    if (this.#state === "finalized") {
      throw new RecordingAvClockError(
        "video_pts_invalid",
        "encoded frame arrived after finalization",
      );
    }
    if (this.#state === "paused") {
      throw new RecordingAvClockError(
        "video_pts_invalid",
        "encoded frame arrived while A/V clock is paused",
      );
    }
    const ptsUs = nonNegativeSafeInteger(input.ptsUs, "ptsUs");
    const atMs = monotonicMs(input.monotonicEpochMs);
    if (this.#lastVideoPtsUs !== null && ptsUs <= this.#lastVideoPtsUs) {
      throw new RecordingAvClockError("video_pts_invalid", "encoded video PTS must increase");
    }
    if (this.#lastVideoAtMs !== null && atMs < this.#lastVideoAtMs) {
      throw new RecordingAvClockError(
        "video_pts_invalid",
        "encoded video monotonic time moved backwards",
      );
    }
    this.#videoStartPtsUs ??= ptsUs;
    this.#videoOriginAtMs ??= atMs;
    this.#lastVideoPtsUs = ptsUs;
    this.#lastVideoAtMs = atMs;
  }

  pause(monotonicEpochMs: number): "applied" | "duplicate" {
    const atMs = monotonicMs(monotonicEpochMs);
    this.#assertTransitionTime(atMs);
    if (this.#state === "paused") {
      if (this.#lastControl === "pause") {
        this.#lastControlAtMs = atMs;
        return "duplicate";
      }
      throw new RecordingAvClockError(
        "av_clock_transition_invalid",
        "A/V pause ordering is invalid",
      );
    }
    if (this.#state === "finalized") {
      throw new RecordingAvClockError(
        "av_clock_transition_invalid",
        "cannot pause a finalized A/V clock",
      );
    }
    this.#state = "paused";
    this.#lastControl = "pause";
    this.#lastControlAtMs = atMs;
    this.#openPauseAtMs = atMs;
    return "applied";
  }

  resume(monotonicEpochMs: number): "applied" | "duplicate" {
    const atMs = monotonicMs(monotonicEpochMs);
    this.#assertTransitionTime(atMs);
    if (this.#state === "recording") {
      if (this.#lastControl === "resume") {
        this.#lastControlAtMs = atMs;
        return "duplicate";
      }
      throw new RecordingAvClockError(
        "av_clock_transition_invalid",
        "A/V resume arrived before pause",
      );
    }
    if (this.#state === "finalized") {
      throw new RecordingAvClockError(
        "av_clock_transition_invalid",
        "cannot resume a finalized A/V clock",
      );
    }
    if (this.#openPauseAtMs === null || atMs < this.#openPauseAtMs) {
      throw new RecordingAvClockError("av_clock_transition_invalid", "A/V pause span is invalid");
    }
    this.#pauseSpans.push({ startedAtMs: this.#openPauseAtMs, endedAtMs: atMs });
    this.#openPauseAtMs = null;
    this.#state = "recording";
    this.#lastControl = "resume";
    this.#lastControlAtMs = atMs;
    return "applied";
  }

  alignment(input: RecordingAvAlignmentInput): Readonly<RecordingAvAlignment> {
    const videoStartPtsUs = this.#videoStartPtsUs;
    const videoOriginAtMs = this.#videoOriginAtMs;
    const lastVideoPtsUs = this.#lastVideoPtsUs;
    if (videoStartPtsUs === null || videoOriginAtMs === null || lastVideoPtsUs === null) {
      throw new RecordingAvClockError("video_pts_invalid", "no encoded video frame was committed");
    }
    const videoEndPtsUs = nonNegativeSafeInteger(input.videoEndPtsUs, "videoEndPtsUs");
    if (videoEndPtsUs <= lastVideoPtsUs || videoEndPtsUs <= videoStartPtsUs) {
      throw new RecordingAvClockError(
        "video_duration_invalid",
        "encoded video end PTS must follow the last committed frame",
      );
    }
    const finalizedAtMs = monotonicMs(input.finalizedMonotonicEpochMs, "finalizedMonotonicEpochMs");
    if (this.#lastVideoAtMs !== null && finalizedAtMs < this.#lastVideoAtMs) {
      throw new RecordingAvClockError(
        "video_duration_invalid",
        "video finalization monotonic time moved backwards",
      );
    }
    const absolutePauses = this.#effectivePauseSpans(finalizedAtMs);
    const pauseSpans = this.#normalizePauseSpans(
      absolutePauses,
      videoOriginAtMs,
      finalizedAtMs,
      videoStartPtsUs,
    );
    const audio = input.audioStream ?? null;
    const audioStartedAtMs = audio?.started_monotonic_epoch_ms ?? null;
    const audioEndedAtMs = audio?.ended_monotonic_epoch_ms ?? null;
    let audioStartOffsetUs: number | null = null;
    let audioEndDriftUs: number | null = null;
    let audioActiveDurationUs: number | null = null;
    let audioMappedStartPtsUs: number | null = null;
    let audioMappedEndPtsUs: number | null = null;
    if (audioStartedAtMs !== null && audioEndedAtMs !== null) {
      audioStartOffsetUs = this.#activeElapsedUs(audioStartedAtMs, videoOriginAtMs, absolutePauses);
      const audioEndOffsetUs = this.#activeElapsedUs(
        audioEndedAtMs,
        videoOriginAtMs,
        absolutePauses,
      );
      audioMappedStartPtsUs = videoStartPtsUs + audioStartOffsetUs;
      audioMappedEndPtsUs = videoStartPtsUs + audioEndOffsetUs;
      audioActiveDurationUs = Math.max(0, audioMappedEndPtsUs - audioMappedStartPtsUs);
      audioEndDriftUs = audioMappedEndPtsUs - videoEndPtsUs;
    }
    return frozen({
      clock: "encoded_video_pts" as const,
      unit: "us" as const,
      video_start_pts_us: videoStartPtsUs,
      video_end_pts_us: videoEndPtsUs,
      video_duration_us: videoEndPtsUs - videoStartPtsUs,
      video_origin_monotonic_epoch_ms: videoOriginAtMs,
      finalized_monotonic_epoch_ms: finalizedAtMs,
      audio_start_offset_us: audioStartOffsetUs,
      audio_end_drift_us: audioEndDriftUs,
      audio_active_duration_us: audioActiveDurationUs,
      audio_mapped_start_pts_us: audioMappedStartPtsUs,
      audio_mapped_end_pts_us: audioMappedEndPtsUs,
      pause_spans: pauseSpans,
    });
  }

  finalize(input: RecordingAvFinalizeInput): Readonly<RecordingAvSnapshot> {
    if (this.#finalSnapshot) return this.#finalSnapshot;
    const audio = input.audioStream ?? null;
    const alignment = this.alignment(input);
    const outcome = classifyRecordingAv({
      audioRequested: audio !== null,
      audioReadable: audio === null ? true : input.audioReadable === true,
      audioStreamComplete: audio === null ? true : audio.final_drain_complete,
      audioFailureReason: audio?.failure_reason,
      muxSucceeded: audio === null ? true : input.muxSucceeded === true,
      muxValidated: audio === null ? true : input.muxValidated === true,
      explicitVideoDurationBounded:
        audio === null ? true : input.explicitVideoDurationBounded === true,
      audioStartOffsetUs: alignment.audio_start_offset_us,
      audioEndDriftUs: alignment.audio_end_drift_us,
    });
    if (this.#state === "paused") {
      this.#pauseSpans.push({
        startedAtMs: this.#openPauseAtMs ?? input.finalizedMonotonicEpochMs,
        endedAtMs: input.finalizedMonotonicEpochMs,
      });
      this.#openPauseAtMs = null;
    }
    this.#state = "finalized";
    this.#finalSnapshot = frozen({
      version: 1 as const,
      session_id: this.sessionId,
      ...alignment,
      audio,
      outcome,
    });
    if (
      audio &&
      alignment.audio_end_drift_us !== null &&
      Math.abs(alignment.audio_end_drift_us) > RECORDING_AV_DRIFT_LIMIT_US
    ) {
      void recordEngineLog({
        level: "warn",
        event: "recording.audio.drift_detected",
        context: {
          session_id: this.sessionId,
          phase: "finalize",
          reason_code: "audio_end_drift",
        },
        details: {
          audio_end_drift_us: alignment.audio_end_drift_us,
          audio_start_offset_us: alignment.audio_start_offset_us,
          drift_limit_us: RECORDING_AV_DRIFT_LIMIT_US,
          av_verdict: outcome.verdict,
        },
      });
    }
    return this.#finalSnapshot;
  }

  #effectivePauseSpans(finalizedAtMs: number): AbsolutePauseSpan[] {
    const spans = this.#pauseSpans.map((span) => ({ ...span }));
    if (this.#openPauseAtMs !== null) {
      if (finalizedAtMs < this.#openPauseAtMs) {
        throw new RecordingAvClockError(
          "av_clock_transition_invalid",
          "open A/V pause ends before it starts",
        );
      }
      spans.push({ startedAtMs: this.#openPauseAtMs, endedAtMs: finalizedAtMs });
    }
    return spans;
  }

  #normalizePauseSpans(
    spans: readonly AbsolutePauseSpan[],
    videoOriginAtMs: number,
    finalizedAtMs: number,
    videoStartPtsUs: number,
  ): RecordingAvPauseSpan[] {
    let excludedUs = 0;
    const normalized: RecordingAvPauseSpan[] = [];
    for (const span of spans) {
      const startedAtMs = Math.max(videoOriginAtMs, span.startedAtMs);
      const endedAtMs = Math.min(finalizedAtMs, span.endedAtMs);
      if (endedAtMs <= startedAtMs) continue;
      const wallStartUs = microsecondsFromMilliseconds(startedAtMs - videoOriginAtMs);
      const durationUs = microsecondsFromMilliseconds(endedAtMs - startedAtMs);
      const normalizedPtsUs = videoStartPtsUs + wallStartUs - excludedUs;
      normalized.push({
        started_monotonic_epoch_ms: startedAtMs,
        ended_monotonic_epoch_ms: endedAtMs,
        duration_us: durationUs,
        normalized_start_pts_us: normalizedPtsUs,
        normalized_end_pts_us: normalizedPtsUs,
      });
      excludedUs += durationUs;
    }
    return normalized;
  }

  #activeElapsedUs(
    atMs: number,
    videoOriginAtMs: number,
    spans: readonly AbsolutePauseSpan[],
  ): number {
    const timestampMs = monotonicMs(atMs);
    let elapsedUs = microsecondsFromMilliseconds(timestampMs - videoOriginAtMs);
    if (timestampMs <= videoOriginAtMs) return elapsedUs;
    for (const span of spans) {
      const overlapStart = Math.max(videoOriginAtMs, span.startedAtMs);
      const overlapEnd = Math.min(timestampMs, span.endedAtMs);
      if (overlapEnd > overlapStart) {
        elapsedUs -= microsecondsFromMilliseconds(overlapEnd - overlapStart);
      }
    }
    return elapsedUs;
  }

  #assertTransitionTime(atMs: number): void {
    if (this.#lastVideoAtMs !== null && atMs < this.#lastVideoAtMs) {
      throw new RecordingAvClockError(
        "av_clock_transition_invalid",
        "A/V transition monotonic time moved backwards",
      );
    }
    if (this.#openPauseAtMs !== null && atMs < this.#openPauseAtMs) {
      throw new RecordingAvClockError(
        "av_clock_transition_invalid",
        "A/V transition monotonic time moved backwards",
      );
    }
    if (this.#lastControlAtMs !== null && atMs < this.#lastControlAtMs) {
      throw new RecordingAvClockError(
        "av_clock_transition_invalid",
        "A/V transition monotonic time moved backwards",
      );
    }
  }
}

export interface RecordingAvMuxPlanInput {
  alignment: Readonly<RecordingAvAlignment>;
  audio: Pick<RecordingAudioStreamSnapshot, "mime_type" | "container">;
  videoInputPath: string;
  audioInputPath: string;
  outputPath: string;
  maxDurationUs?: number;
}

export interface RecordingAvMuxPlan {
  version: 1;
  master_clock: "encoded_video_pts";
  audio_mime_type: string;
  audio_container: RecordingAudioContainer;
  adjustment: "trim" | "delay" | "aligned";
  duration_us: number;
  filter_complex: string;
  args: readonly string[];
}

function ffmpegSeconds(valueUs: number): string {
  return (valueUs / 1_000_000).toFixed(6);
}

function ffmpegMilliseconds(valueUs: number): string {
  return (valueUs / 1_000).toFixed(3);
}

export function buildLegacyRecordingAvMuxArgs(input: {
  videoDurationUs: number;
  videoInputPath: string;
  audioInputPath: string;
  outputPath: string;
  maxDurationUs?: number;
}): readonly string[] {
  const durationUs = nonNegativeSafeInteger(input.videoDurationUs, "videoDurationUs");
  const maxDurationUs = nonNegativeSafeInteger(
    input.maxDurationUs ?? RECORDING_AV_MAX_MUX_DURATION_US,
    "maxDurationUs",
  );
  if (durationUs === 0 || durationUs > maxDurationUs) {
    throw new RecordingAvClockError(
      "mux_duration_unbounded",
      `video duration must be within 1..${maxDurationUs} microseconds`,
    );
  }
  const duration = ffmpegSeconds(durationUs);
  return [
    "-y",
    "-i",
    nonEmpty(input.videoInputPath, "videoInputPath"),
    "-i",
    nonEmpty(input.audioInputPath, "audioInputPath"),
    "-filter_complex",
    `[1:a]apad=whole_dur=${duration},atrim=start=0:end=${duration},asetpts=PTS-STARTPTS[aout]`,
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-t",
    duration,
    nonEmpty(input.outputPath, "outputPath"),
  ];
}

export function buildRecordingAvMuxPlan(
  input: RecordingAvMuxPlanInput,
): Readonly<RecordingAvMuxPlan> {
  const durationUs = nonNegativeSafeInteger(input.alignment.video_duration_us, "videoDurationUs");
  const maxDurationUs = nonNegativeSafeInteger(
    input.maxDurationUs ?? RECORDING_AV_MAX_MUX_DURATION_US,
    "maxDurationUs",
  );
  if (durationUs === 0 || durationUs > maxDurationUs) {
    throw new RecordingAvClockError(
      "mux_duration_unbounded",
      `video duration must be within 1..${maxDurationUs} microseconds`,
    );
  }
  const startOffsetUs = input.alignment.audio_start_offset_us;
  if (startOffsetUs === null || !Number.isSafeInteger(startOffsetUs)) {
    throw new RecordingAvClockError("audio_missing", "audio start offset is unavailable");
  }
  if (Math.abs(startOffsetUs) > maxDurationUs) {
    throw new RecordingAvClockError(
      "mux_duration_unbounded",
      "audio start offset exceeds mux bound",
    );
  }
  const mimeType = nonEmpty(input.audio.mime_type ?? "", "audio.mime_type");
  const container = input.audio.container;
  if (!container || recordingAudioContainerForMimeType(mimeType) !== container) {
    throw new Error("audio MIME type and container do not match");
  }
  const videoInputPath = nonEmpty(input.videoInputPath, "videoInputPath");
  const audioInputPath = nonEmpty(input.audioInputPath, "audioInputPath");
  const outputPath = nonEmpty(input.outputPath, "outputPath");
  if (outputPath === videoInputPath || outputPath === audioInputPath) {
    throw new Error("mux output must be a temporary path distinct from both inputs");
  }
  const duration = ffmpegSeconds(durationUs);
  const filters = ["[1:a]atrim=start=0", "asetpts=PTS-STARTPTS"];
  let adjustment: RecordingAvMuxPlan["adjustment"] = "aligned";
  if (startOffsetUs < 0) {
    filters[0] = `[1:a]atrim=start=${ffmpegSeconds(Math.abs(startOffsetUs))}`;
    adjustment = "trim";
  } else if (startOffsetUs > 0) {
    filters.push(`adelay=${ffmpegMilliseconds(startOffsetUs)}:all=1`);
    adjustment = "delay";
  }
  filters.push(
    "aresample=async=1:first_pts=0",
    `apad=whole_dur=${duration}`,
    `atrim=start=0:end=${duration}`,
    "asetpts=PTS-STARTPTS[aout]",
  );
  const filterComplex = filters.join(",");
  const args = [
    "-y",
    "-i",
    videoInputPath,
    "-i",
    audioInputPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-t",
    duration,
    "-movflags",
    "+faststart",
    outputPath,
  ];
  return frozen({
    version: 1 as const,
    master_clock: "encoded_video_pts" as const,
    audio_mime_type: mimeType,
    audio_container: container,
    adjustment,
    duration_us: durationUs,
    filter_complex: filterComplex,
    args,
  });
}

export function serializeRecordingAvSnapshot(snapshot: Readonly<RecordingAvSnapshot>): string {
  return JSON.stringify(snapshot, (_key, value: unknown) => {
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
      throw new Error("recording A/V snapshot contains a non-serializable value");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("recording A/V snapshot contains a non-finite number");
    }
    return value;
  });
}

export interface RecordingAvSessionRegistration {
  sessionId: string;
  audioRequested: boolean;
  audioCaptureId?: string | null;
  videoOutputPath: string;
  registeredMonotonicEpochMs: number;
}

function videoOnlyOutputPath(outputPath: string): string {
  const normalized = nonEmpty(outputPath, "videoOutputPath");
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= normalized.lastIndexOf("/")) return `${normalized}.video-only`;
  return `${normalized.slice(0, extensionIndex)}.video-only${normalized.slice(extensionIndex)}`;
}

export class RecordingAvSessionRuntime {
  readonly sessionId: string;
  readonly audioRequested: boolean;
  readonly videoOutputPath: string;
  readonly videoOnlyPath: string;
  readonly registeredMonotonicEpochMs: number;
  readonly clock: RecordingAvClock;
  readonly audio = new RecordingAudioStreamValidator();

  #audioCaptureId: string | null;
  #videoObservationPaused = false;
  #audioTerminalPromise: Promise<Readonly<RecordingAudioStreamSnapshot>>;
  #resolveAudioTerminal: ((snapshot: Readonly<RecordingAudioStreamSnapshot>) => void) | null = null;

  constructor(input: RecordingAvSessionRegistration) {
    this.sessionId = nonEmpty(input.sessionId, "sessionId");
    this.audioRequested = input.audioRequested === true;
    this.#audioCaptureId = input.audioCaptureId
      ? nonEmpty(input.audioCaptureId, "audioCaptureId")
      : null;
    this.videoOutputPath = nonEmpty(input.videoOutputPath, "videoOutputPath");
    this.videoOnlyPath = this.audioRequested
      ? videoOnlyOutputPath(this.videoOutputPath)
      : this.videoOutputPath;
    this.registeredMonotonicEpochMs = monotonicMs(
      input.registeredMonotonicEpochMs,
      "registeredMonotonicEpochMs",
    );
    this.clock = new RecordingAvClock(this.sessionId);
    this.#audioTerminalPromise = new Promise((resolve) => {
      this.#resolveAudioTerminal = resolve;
    });
  }

  assertAudioCaptureId(audioCaptureId: string): void {
    const normalized = nonEmpty(audioCaptureId, "audioCaptureId");
    if (this.#audioCaptureId === null) {
      this.#audioCaptureId = normalized;
      return;
    }
    if (normalized !== this.#audioCaptureId) {
      throw new RecordingAvClockError(
        "av_clock_transition_invalid",
        "audio capture id does not match the recording session",
      );
    }
  }

  observeEncodedVideoFrame(input: { ptsUs: number; monotonicEpochMs: number }): boolean {
    if (this.#videoObservationPaused) return false;
    this.clock.observeEncodedVideoFrame(input);
    return true;
  }

  pause(monotonicEpochMs: number): "applied" | "duplicate" {
    const result = this.clock.pause(monotonicEpochMs);
    this.#videoObservationPaused = true;
    return result;
  }

  resume(monotonicEpochMs: number): "applied" | "duplicate" {
    const result = this.clock.resume(monotonicEpochMs);
    this.#videoObservationPaused = false;
    return result;
  }

  markAudioTerminal(): Readonly<RecordingAudioStreamSnapshot> {
    const snapshot = this.audio.snapshot();
    if (snapshot.state !== "ended" && snapshot.state !== "aborted") {
      throw new RecordingAvClockError(
        "audio_drain_incomplete",
        "audio terminal acknowledgement requires an ended or aborted stream",
      );
    }
    this.#resolveAudioTerminal?.(snapshot);
    this.#resolveAudioTerminal = null;
    return snapshot;
  }

  async waitForAudioTerminal(timeoutMs: number): Promise<Readonly<RecordingAudioStreamSnapshot>> {
    const current = this.audio.snapshot();
    if (current.state === "ended" || current.state === "aborted") return current;
    const timeout = Math.max(1, Math.trunc(finiteNumber(timeoutMs, "timeoutMs")));
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.audio.snapshot()), timeout);
      timer.unref?.();
      void this.#audioTerminalPromise.then((snapshot) => {
        clearTimeout(timer);
        resolve(snapshot);
      });
    });
  }
}

export class RecordingAvSessionRegistry {
  readonly #sessions = new Map<string, RecordingAvSessionRuntime>();

  register(input: RecordingAvSessionRegistration): RecordingAvSessionRuntime {
    const sessionId = nonEmpty(input.sessionId, "sessionId");
    if (this.#sessions.has(sessionId)) {
      throw new Error(`recording A/V session ${sessionId} is already registered`);
    }
    const runtime = new RecordingAvSessionRuntime(input);
    this.#sessions.set(sessionId, runtime);
    return runtime;
  }

  get(sessionId: string): RecordingAvSessionRuntime | null {
    return this.#sessions.get(sessionId) ?? null;
  }

  require(sessionId: string): RecordingAvSessionRuntime {
    const runtime = this.get(nonEmpty(sessionId, "sessionId"));
    if (!runtime) throw new Error(`recording A/V session ${sessionId} not found`);
    return runtime;
  }

  remove(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}

export const recordingAvSessions = new RecordingAvSessionRegistry();
