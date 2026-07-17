import type { RecordingFrameLandmark } from "./recording-media-clock";

export interface RecordedActionPoint {
  x: number;
  y: number;
}

export type RecordedInputDelivery = "browser_injected" | "virtual_only";
export type RecordedInputLandmarkKind = "action" | "down" | "up" | "text_start" | "text_end";
export type FrameSyncDegradedReason =
  | "capture_inactive"
  | "capture_paused"
  | "encoder_error"
  | "frame_capture_failed"
  | "frame_commit_timeout";
export type FrameSyncOutcome =
  | { status: "committed"; landmark: RecordingFrameLandmark }
  | { status: "degraded"; reason: FrameSyncDegradedReason }
  | { status: "cancelled" };

export interface RecordedCursorSample extends RecordingFrameLandmark, RecordedActionPoint {}

export interface RecordedActionLandmarks {
  delivery: RecordedInputDelivery;
  cursorPath: {
    interpolation: "media-frame-linear-v1";
    samples: RecordedCursorSample[];
    arrival: RecordingFrameLandmark;
  };
  input: Partial<Record<RecordedInputLandmarkKind, RecordingFrameLandmark>>;
  presentation:
    | {
        status: "presented";
        firstPostInputFrame: RecordingFrameLandmark;
        firstPostInputPaint?: RecordingFrameLandmark;
      }
    | { status: "timeout"; diagnosticReason: "post_input_frame_timeout" }
    | { status: "not_applicable" };
}

interface PendingEvent {
  delivery: RecordedInputDelivery;
  point: RecordedActionPoint;
  samples: RecordedCursorSample[];
  arrival: RecordingFrameLandmark | null;
  input: Partial<Record<RecordedInputLandmarkKind, RecordingFrameLandmark>>;
  inputFrameIndex: number | null;
  paintToken: number;
  expectsPresentation: boolean;
  presentation: RecordedActionLandmarks["presentation"] | null;
  arrivalOutcome: FrameSyncOutcome | null;
  arrivalWaiters: Array<(outcome: FrameSyncOutcome) => void>;
  presentationWaiters: Array<(result: RecordedActionLandmarks["presentation"]) => void>;
}

function samePoint(left: RecordedActionPoint, right: RecordedActionPoint): boolean {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}

function copyLandmark(landmark: RecordingFrameLandmark): RecordingFrameLandmark {
  return { frameIndex: landmark.frameIndex, ptsUs: landmark.ptsUs };
}

function settleArrival(event: PendingEvent, outcome: FrameSyncOutcome): FrameSyncOutcome {
  if (event.arrivalOutcome) return event.arrivalOutcome;
  const settled =
    outcome.status === "committed"
      ? { status: "committed" as const, landmark: copyLandmark(outcome.landmark) }
      : outcome;
  event.arrivalOutcome = settled;
  if (settled.status === "committed") event.arrival = settled.landmark;
  for (const resolve of event.arrivalWaiters.splice(0)) resolve(settled);
  return settled;
}

export class RecordingActionLandmarkRecorder {
  private readonly events = new Map<string, PendingEvent>();
  private lastCommittedFrame: RecordingFrameLandmark | null = null;
  private paintSequence = 0;

  begin(
    id: string,
    input: {
      delivery: RecordedInputDelivery;
      point: RecordedActionPoint;
      expectsPresentation: boolean;
    },
  ): void {
    this.events.set(id, {
      delivery: input.delivery,
      point: input.point,
      samples: [],
      arrival: null,
      input: {},
      inputFrameIndex: null,
      paintToken: this.paintSequence,
      expectsPresentation: input.expectsPresentation,
      presentation: input.expectsPresentation ? null : { status: "not_applicable" },
      arrivalOutcome: null,
      arrivalWaiters: [],
      presentationWaiters: [],
    });
  }

  updateCursor(id: string, point: RecordedActionPoint): void {
    const event = this.requiredEvent(id);
    if (event.inputFrameIndex != null) return;
    event.point = point;
  }

  notePaint(): void {
    this.paintSequence += 1;
  }

  latestCommittedFrame(): RecordingFrameLandmark | null {
    return this.lastCommittedFrame ? copyLandmark(this.lastCommittedFrame) : null;
  }

  commitFrame(landmark: RecordingFrameLandmark): void {
    this.lastCommittedFrame = copyLandmark(landmark);
    for (const event of this.events.values()) {
      if (event.inputFrameIndex == null) {
        const previous = event.samples.at(-1);
        if (!previous || !samePoint(previous, event.point)) {
          event.samples.push({ ...copyLandmark(landmark), ...event.point });
        }
        if (!event.arrivalOutcome && event.arrivalWaiters.length > 0) {
          settleArrival(event, { status: "committed", landmark });
        }
        continue;
      }
      if (event.presentation || landmark.frameIndex <= event.inputFrameIndex) continue;
      event.presentation = {
        status: "presented",
        firstPostInputFrame: copyLandmark(landmark),
        ...(this.paintSequence > event.paintToken
          ? { firstPostInputPaint: copyLandmark(landmark) }
          : {}),
      };
      for (const resolve of event.presentationWaiters.splice(0)) resolve(event.presentation);
    }
  }

  waitForArrival(id: string, timeoutMs: number): Promise<RecordingFrameLandmark> {
    return this.waitForArrivalOutcome(id, timeoutMs).then((outcome) => {
      if (outcome.status === "committed") return outcome.landmark;
      if (outcome.status === "cancelled") throw new Error("cursor arrival was cancelled");
      throw new Error(`cursor arrival degraded: ${outcome.reason}`);
    });
  }

  waitForArrivalOutcome(id: string, timeoutMs: number): Promise<FrameSyncOutcome> {
    const event = this.requiredEvent(id);
    if (event.arrivalOutcome) return Promise.resolve(event.arrivalOutcome);
    return this.waitWithTimeout(event.arrivalWaiters, timeoutMs, () => {
      return settleArrival(event, {
        status: "degraded",
        reason: "frame_commit_timeout",
      });
    });
  }

  degradeArrival(id: string, reason: FrameSyncDegradedReason): FrameSyncOutcome {
    const event = this.requiredEvent(id);
    return settleArrival(event, { status: "degraded", reason });
  }

  cancelArrival(id: string): FrameSyncOutcome {
    const event = this.requiredEvent(id);
    return settleArrival(event, { status: "cancelled" });
  }

  discard(id: string): void {
    this.events.delete(id);
  }

  cancelAll(): void {
    for (const event of this.events.values()) {
      if (!event.arrivalOutcome) {
        settleArrival(event, { status: "cancelled" });
      }
      if (!event.presentation) {
        event.presentation = {
          status: "timeout",
          diagnosticReason: "post_input_frame_timeout",
        };
        for (const resolve of event.presentationWaiters.splice(0)) resolve(event.presentation);
      }
    }
  }

  markInput(id: string, kind: RecordedInputLandmarkKind): RecordingFrameLandmark {
    const event = this.requiredEvent(id);
    const landmark = this.lastCommittedFrame;
    if (!landmark)
      throw new Error("input cannot be recorded before the first committed media frame");
    const recorded = copyLandmark(landmark);
    event.input[kind] = recorded;
    if (kind === "action") event.inputFrameIndex = recorded.frameIndex;
    return recorded;
  }

  armPresentation(id: string): void {
    const event = this.requiredEvent(id);
    event.paintToken = this.paintSequence;
  }

  async waitForPresentation(
    id: string,
    timeoutMs: number,
  ): Promise<RecordedActionLandmarks["presentation"]> {
    const event = this.requiredEvent(id);
    if (event.presentation) return event.presentation;
    return this.waitWithTimeout(event.presentationWaiters, timeoutMs, () => {
      const result = {
        status: "timeout" as const,
        diagnosticReason: "post_input_frame_timeout" as const,
      };
      event.presentation = result;
      return result;
    });
  }

  finish(id: string): RecordedActionLandmarks {
    const event = this.requiredEvent(id);
    if (!event.arrival) throw new Error("action has no committed cursor arrival landmark");
    if (!event.presentation) throw new Error("action presentation is not finalized");
    this.events.delete(id);
    return {
      delivery: event.delivery,
      cursorPath: {
        interpolation: "media-frame-linear-v1",
        samples: event.samples,
        arrival: event.arrival,
      },
      input: event.input,
      presentation: event.presentation,
    };
  }

  private requiredEvent(id: string): PendingEvent {
    const event = this.events.get(id);
    if (!event) throw new Error(`unknown action landmark event: ${id}`);
    return event;
  }

  private waitWithTimeout<T>(
    waiters: Array<(value: T) => void>,
    timeoutMs: number,
    onTimeout: () => T | Error,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      waiters.push(finish);
      const timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          const index = waiters.indexOf(finish);
          if (index >= 0) waiters.splice(index, 1);
          const result = onTimeout();
          if (result instanceof Error) reject(result);
          else resolve(result);
        },
        Math.max(0, timeoutMs),
      );
      timer.unref?.();
    });
  }
}
