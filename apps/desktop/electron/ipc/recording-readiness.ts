import type { RecordingFrameLandmark } from "./recording-media-clock";
import { RecordingActiveDeadline } from "./recording-media-clock";

export type RecordingReadinessMode = "off" | "observe" | "enforce";
export type RecordingReadinessBarrier =
  | "source_ready"
  | "first_frame_committed"
  | "pre_input_frame_committed"
  | "tail_frame_committed";
export type RecordingReadinessStatus =
  | "committed"
  | "degraded"
  | "failed"
  | "cancelled"
  | "observed_only"
  | "not_applicable";
export type RecordingReadinessReason =
  | "source_not_ready"
  | "encoded_sink_ack_unavailable"
  | "frame_commit_timeout"
  | "frame_capture_failed"
  | "encoder_error"
  | "recording_cancelled";

export interface RecordingReadinessResultV1 {
  version: 1;
  request_id: string;
  session_id: string;
  barrier: RecordingReadinessBarrier;
  mode: RecordingReadinessMode;
  status: RecordingReadinessStatus;
  reason: RecordingReadinessReason | null;
  attempts: number;
  requested_media_us: number | null;
  committed_landmark: RecordingFrameLandmark | null;
  active_wait_ms: number;
  submitted_frames: number;
  encoded_frames: number;
}

export interface RecordingReadinessRequest {
  barrier: RecordingReadinessBarrier;
  budgetMs: number;
  queueFrame?: () => Promise<void>;
  requestedMediaUs?: number | null;
}

interface RecordingReadinessCoordinatorOptions {
  sessionId: string;
  mode: RecordingReadinessMode;
  sinkAcknowledgements?: boolean;
  now?: () => number;
  onObservation?: (result: RecordingReadinessResultV1) => void;
}

const MAX_ATTEMPTS = 3;

function copyLandmark(landmark: RecordingFrameLandmark | null): RecordingFrameLandmark | null {
  return landmark ? { frameIndex: landmark.frameIndex, ptsUs: landmark.ptsUs } : null;
}

function validBudget(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("readiness budget must be a finite non-negative number");
  }
  return value;
}

export function recordingReadinessMode(
  value = process.env.STORYCAPTURE_RECORDING_READINESS_MODE,
): RecordingReadinessMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "observe" || normalized === "shadow") return "observe";
  if (normalized === "enforce") return "enforce";
  return "off";
}

export class RecordingReadinessError extends Error {
  readonly recordingReasonCode = "readiness_failed" as const;

  constructor(readonly result: RecordingReadinessResultV1) {
    super(
      `recording readiness ${result.barrier} failed: ${result.reason ?? result.status} ` +
        `(submitted=${result.submitted_frames}, encoded=${result.encoded_frames}, attempts=${result.attempts})`,
    );
    this.name = "RecordingReadinessError";
  }
}

/**
 * Coordinates source delivery and real encoded-sink acknowledgements for one
 * recording. No browser or media content is retained in this registry.
 */
export class RecordingReadinessCoordinator {
  readonly sessionId: string;
  readonly mode: RecordingReadinessMode;
  readonly #now: () => number;
  readonly #onObservation: (result: RecordingReadinessResultV1) => void;
  readonly #deadlines = new Set<RecordingActiveDeadline>();
  readonly #signalWaiters = new Set<() => void>();
  #serial: Promise<void> = Promise.resolve();
  #requestSequence = 0;
  #sourceReady = false;
  #sinkAcknowledgements: boolean;
  #submittedFrames = 0;
  #encodedFrames = 0;
  #lastEncodedLandmark: RecordingFrameLandmark | null = null;
  #encoderFailed = false;
  #cancelled = false;
  #paused = false;

  constructor(options: RecordingReadinessCoordinatorOptions) {
    this.sessionId = options.sessionId;
    this.mode = options.mode;
    this.#sinkAcknowledgements = options.sinkAcknowledgements ?? false;
    this.#now = options.now ?? Date.now;
    this.#onObservation = options.onObservation ?? (() => undefined);
  }

  setSinkAcknowledgementsAvailable(available: boolean): void {
    this.#sinkAcknowledgements = available;
    this.#signal();
  }

  markSourceReady(): void {
    if (this.#cancelled) return;
    this.#sourceReady = true;
    this.#signal();
  }

  markFrameSubmitted(): number {
    if (this.#cancelled) return this.#submittedFrames;
    this.#submittedFrames += 1;
    this.#signal();
    return this.#submittedFrames;
  }

  acknowledgeEncodedFrame(input: {
    sessionId: string;
    encodedFrameCount: number;
    landmark: RecordingFrameLandmark;
  }): boolean {
    if (
      this.#cancelled ||
      input.sessionId !== this.sessionId ||
      !Number.isSafeInteger(input.encodedFrameCount) ||
      input.encodedFrameCount <= this.#encodedFrames ||
      input.encodedFrameCount > this.#submittedFrames ||
      input.landmark.frameIndex !== input.encodedFrameCount - 1
    ) {
      return false;
    }
    this.#encodedFrames = input.encodedFrameCount;
    this.#lastEncodedLandmark = copyLandmark(input.landmark);
    this.#signal();
    return true;
  }

  markEncoderFailed(): void {
    this.#encoderFailed = true;
    this.#signal();
  }

  pause(): void {
    if (this.#paused || this.#cancelled) return;
    this.#paused = true;
    for (const deadline of this.#deadlines) deadline.pause();
    this.#signal();
  }

  resume(): void {
    if (!this.#paused || this.#cancelled) return;
    this.#paused = false;
    for (const deadline of this.#deadlines) deadline.resume();
    this.#signal();
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#signal();
  }

  snapshot(): {
    source_ready: boolean;
    sink_acknowledgements: boolean;
    submitted_frames: number;
    encoded_frames: number;
    paused: boolean;
    cancelled: boolean;
  } {
    return {
      source_ready: this.#sourceReady,
      sink_acknowledgements: this.#sinkAcknowledgements,
      submitted_frames: this.#submittedFrames,
      encoded_frames: this.#encodedFrames,
      paused: this.#paused,
      cancelled: this.#cancelled,
    };
  }

  request(request: RecordingReadinessRequest): Promise<RecordingReadinessResultV1> {
    const normalized = { ...request, budgetMs: validBudget(request.budgetMs) };
    const requestId = `${this.sessionId}:${++this.#requestSequence}`;
    if (this.mode === "off") {
      return Promise.resolve(
        this.#result(requestId, normalized, "not_applicable", null, 0, null, 0),
      );
    }
    if (this.mode === "observe") {
      this.#enqueue(async () => {
        const observed = await this.#run(requestId, normalized);
        this.#onObservation(observed);
      });
      return Promise.resolve(
        this.#result(requestId, normalized, "observed_only", null, 0, null, 0),
      );
    }
    return this.#enqueue(() => this.#run(requestId, normalized));
  }

  require(request: RecordingReadinessRequest): Promise<RecordingReadinessResultV1> {
    return this.request(request).then((result) => {
      if (result.status === "failed") throw new RecordingReadinessError(result);
      return result;
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#serial.then(operation);
    this.#serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #run(
    requestId: string,
    request: RecordingReadinessRequest,
  ): Promise<RecordingReadinessResultV1> {
    const deadline = new RecordingActiveDeadline(request.budgetMs, this.#now);
    if (this.#paused) deadline.pause();
    this.#deadlines.add(deadline);
    try {
      if (this.#cancelled) {
        return this.#result(
          requestId,
          request,
          "cancelled",
          "recording_cancelled",
          0,
          null,
          deadline.activeElapsedMs(),
        );
      }

      if (request.barrier === "source_ready") {
        return await this.#waitForSource(requestId, request, deadline);
      }
      if (!this.#sourceReady) {
        return this.#result(
          requestId,
          request,
          this.mode === "enforce" ? "failed" : "degraded",
          "source_not_ready",
          0,
          null,
          deadline.activeElapsedMs(),
        );
      }
      if (!this.#sinkAcknowledgements) {
        return this.#result(
          requestId,
          request,
          this.mode === "enforce" ? "failed" : "degraded",
          "encoded_sink_ack_unavailable",
          0,
          null,
          deadline.activeElapsedMs(),
        );
      }

      let attempts = 0;
      let failureReason: RecordingReadinessReason = "frame_commit_timeout";
      while (attempts < MAX_ATTEMPTS && !deadline.expired()) {
        attempts += 1;
        if (this.#cancelled) {
          return this.#result(
            requestId,
            request,
            "cancelled",
            "recording_cancelled",
            attempts,
            null,
            deadline.activeElapsedMs(),
          );
        }
        if (this.#encoderFailed) {
          failureReason = "encoder_error";
          break;
        }

        const previousEncoded = this.#encodedFrames;
        try {
          await request.queueFrame?.();
        } catch {
          failureReason = this.#encoderFailed ? "encoder_error" : "frame_capture_failed";
          continue;
        }
        if (this.#meetsRequestedMedia(request, previousEncoded)) {
          return this.#result(
            requestId,
            request,
            "committed",
            null,
            attempts,
            this.#lastEncodedLandmark,
            deadline.activeElapsedMs(),
          );
        }

        const attemptsLeft = MAX_ATTEMPTS - attempts + 1;
        const waitBudget = deadline.remainingMs() / Math.max(1, attemptsLeft);
        const acknowledged = await this.#waitUntil(
          () => this.#meetsRequestedMedia(request, previousEncoded),
          waitBudget,
          deadline,
        );
        if (acknowledged && this.#lastEncodedLandmark) {
          return this.#result(
            requestId,
            request,
            "committed",
            null,
            attempts,
            this.#lastEncodedLandmark,
            deadline.activeElapsedMs(),
          );
        }
        if (this.#encoderFailed) failureReason = "encoder_error";
      }

      if (this.#cancelled) {
        return this.#result(
          requestId,
          request,
          "cancelled",
          "recording_cancelled",
          attempts,
          null,
          deadline.activeElapsedMs(),
        );
      }
      return this.#result(
        requestId,
        request,
        this.mode === "enforce" ? "failed" : "degraded",
        failureReason,
        attempts,
        null,
        deadline.activeElapsedMs(),
      );
    } finally {
      this.#deadlines.delete(deadline);
    }
  }

  async #waitForSource(
    requestId: string,
    request: RecordingReadinessRequest,
    deadline: RecordingActiveDeadline,
  ): Promise<RecordingReadinessResultV1> {
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS && !deadline.expired() && !this.#sourceReady) {
      attempts += 1;
      const attemptsLeft = MAX_ATTEMPTS - attempts + 1;
      await this.#waitUntil(
        () => this.#sourceReady,
        deadline.remainingMs() / Math.max(1, attemptsLeft),
        deadline,
      );
    }
    if (this.#sourceReady) {
      return this.#result(
        requestId,
        request,
        "committed",
        null,
        attempts,
        null,
        deadline.activeElapsedMs(),
      );
    }
    if (this.#cancelled) {
      return this.#result(
        requestId,
        request,
        "cancelled",
        "recording_cancelled",
        attempts,
        null,
        deadline.activeElapsedMs(),
      );
    }
    return this.#result(
      requestId,
      request,
      this.mode === "enforce" ? "failed" : "degraded",
      "source_not_ready",
      attempts,
      null,
      deadline.activeElapsedMs(),
    );
  }

  #meetsRequestedMedia(request: RecordingReadinessRequest, previousEncoded: number): boolean {
    if (this.#encodedFrames <= previousEncoded || !this.#lastEncodedLandmark) return false;
    return (
      request.requestedMediaUs == null ||
      this.#lastEncodedLandmark.ptsUs >= request.requestedMediaUs
    );
  }

  async #waitUntil(
    condition: () => boolean,
    activeBudgetMs: number,
    parentDeadline: RecordingActiveDeadline,
  ): Promise<boolean> {
    const attemptDeadline = new RecordingActiveDeadline(Math.max(0, activeBudgetMs), this.#now);
    if (this.#paused) attemptDeadline.pause();
    this.#deadlines.add(attemptDeadline);
    try {
      while (!condition() && !this.#cancelled && !this.#encoderFailed) {
        if (parentDeadline.expired() || attemptDeadline.expired()) break;
        if (this.#paused) {
          await this.#waitForSignal(null);
          continue;
        }
        await this.#waitForSignal(
          Math.max(0, Math.min(parentDeadline.remainingMs(), attemptDeadline.remainingMs())),
        );
      }
      return condition();
    } finally {
      this.#deadlines.delete(attemptDeadline);
    }
  }

  #waitForSignal(timeoutMs: number | null): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (!this.#signalWaiters.delete(finish)) return;
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.#signalWaiters.add(finish);
      if (timeoutMs != null) {
        timer = setTimeout(finish, Math.max(0, timeoutMs));
        timer.unref?.();
      }
    });
  }

  #signal(): void {
    for (const resolve of [...this.#signalWaiters]) resolve();
  }

  #result(
    requestId: string,
    request: RecordingReadinessRequest,
    status: RecordingReadinessStatus,
    reason: RecordingReadinessReason | null,
    attempts: number,
    landmark: RecordingFrameLandmark | null,
    activeWaitMs: number,
  ): RecordingReadinessResultV1 {
    return Object.freeze({
      version: 1,
      request_id: requestId,
      session_id: this.sessionId,
      barrier: request.barrier,
      mode: this.mode,
      status,
      reason,
      attempts,
      requested_media_us: request.requestedMediaUs ?? null,
      committed_landmark: copyLandmark(landmark),
      active_wait_ms: Math.max(0, Math.round(activeWaitMs)),
      submitted_frames: this.#submittedFrames,
      encoded_frames: this.#encodedFrames,
    });
  }
}

export class RecordingReadinessRegistry {
  readonly #sessions = new Map<string, RecordingReadinessCoordinator>();

  register(options: RecordingReadinessCoordinatorOptions): RecordingReadinessCoordinator {
    if (this.#sessions.has(options.sessionId)) {
      throw new Error(`recording readiness session ${options.sessionId} already registered`);
    }
    const coordinator = new RecordingReadinessCoordinator(options);
    this.#sessions.set(options.sessionId, coordinator);
    return coordinator;
  }

  get(sessionId: string): RecordingReadinessCoordinator | null {
    return this.#sessions.get(sessionId) ?? null;
  }

  cancel(sessionId: string): void {
    this.#sessions.get(sessionId)?.cancel();
  }

  remove(sessionId: string): void {
    this.#sessions.get(sessionId)?.cancel();
    this.#sessions.delete(sessionId);
  }
}

export const recordingReadiness = new RecordingReadinessRegistry();
