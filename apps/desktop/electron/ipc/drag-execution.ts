import type { RecordedInputLandmarkKind } from "./action-landmarks";
import type { ActionCursorMotionPreset, ActionPoint, ActionTarget } from "./action-timeline";
import { sampleCursorMotionPath } from "./cursor-timing";

export type DragExecutionMode = "off" | "on";

export interface DragExecutionPlan {
  source: ActionTarget;
  destination: ActionTarget;
  samples: Array<ActionPoint & { elapsedMs: number }>;
  durationMs: number;
}

export interface DragExecutionResult {
  cursor: ActionPoint;
  source: ActionTarget;
  target: ActionTarget;
  pointer: { button: "left"; effect: "drag" };
}

export class DragExecutionError extends Error {
  readonly recordingReasonCode = "drag_execution_failed";

  constructor(
    readonly reason:
      | "disabled"
      | "cancelled_before_input"
      | "cancelled_after_input"
      | "target_missing_before_input"
      | "target_lost_after_input"
      | "frame_barrier_failed"
      | "delivery_failed",
    readonly inputStarted: boolean,
    cause?: unknown,
  ) {
    super(`drag_execution_failed:${reason}`, cause === undefined ? undefined : { cause });
    this.name = "DragExecutionError";
  }
}

export function dragExecutionMode(
  value = process.env.STORYCAPTURE_DRAG_EXECUTION_MODE,
): DragExecutionMode {
  return value === "on" || value === "1" ? "on" : "off";
}

export function dragDurationMsForDistance(
  distancePx: number,
  motionPreset: ActionCursorMotionPreset,
): number {
  const pixelsPerMs = motionPreset === "snappy" ? 2.2 : motionPreset === "cinematic" ? 1.1 : 1.6;
  return Math.max(180, Math.min(1_400, Math.round(Math.max(0, distancePx) / pixelsPerMs)));
}

export function planDragExecution(input: {
  source: ActionTarget;
  destination: ActionTarget;
  fps: number;
  motionPreset: ActionCursorMotionPreset;
  eventKey: string;
}): DragExecutionPlan {
  const from = input.source.center;
  const to = input.destination.center;
  const durationMs = dragDurationMsForDistance(
    Math.hypot(to.x - from.x, to.y - from.y),
    input.motionPreset,
  );
  const points = sampleCursorMotionPath({
    from,
    to,
    travelMs: durationMs,
    intervalMs: 1_000 / Math.max(1, input.fps),
    motionPreset: input.motionPreset,
    eventKey: input.eventKey,
  });
  return {
    source: input.source,
    destination: input.destination,
    durationMs,
    samples: points.map((point, index) => ({
      ...point,
      elapsedMs: Math.round(((index + 1) / points.length) * durationMs),
    })),
  };
}

export async function executeDragPlan(input: {
  plan: DragExecutionPlan;
  sendInputEvent: (event: Record<string, unknown>) => void;
  wait: (durationMs: number) => Promise<boolean | undefined>;
  shouldCancel?: () => boolean;
  beforeInputSideEffect?: () => void;
  onInputSideEffect?: (kind: RecordedInputLandmarkKind) => void;
  onCursorSample?: (point: ActionPoint) => void;
  beforePressedPath?: () => Promise<boolean>;
}): Promise<DragExecutionResult> {
  if (dragExecutionMode() === "off") throw new DragExecutionError("disabled", false);
  if (input.shouldCancel?.()) throw new DragExecutionError("cancelled_before_input", false);

  let pointerDown = false;
  let lastPoint = input.plan.source.center;
  const release = () => {
    if (!pointerDown) return;
    input.sendInputEvent({
      type: "mouseUp",
      x: Math.round(lastPoint.x),
      y: Math.round(lastPoint.y),
      button: "left",
      clickCount: 1,
    });
    pointerDown = false;
    input.onInputSideEffect?.("up");
  };

  try {
    input.beforeInputSideEffect?.();
    input.onInputSideEffect?.("down");
    input.sendInputEvent({
      type: "mouseDown",
      x: Math.round(lastPoint.x),
      y: Math.round(lastPoint.y),
      button: "left",
      clickCount: 1,
    });
    pointerDown = true;
    if (input.beforePressedPath && !(await input.beforePressedPath())) {
      throw new DragExecutionError("target_lost_after_input", true);
    }

    let elapsedMs = 0;
    for (const sample of input.plan.samples) {
      if (input.shouldCancel?.()) throw new DragExecutionError("cancelled_after_input", true);
      const delayMs = Math.max(0, sample.elapsedMs - elapsedMs);
      if (delayMs > 0 && (await input.wait(delayMs)) === false) {
        throw new DragExecutionError("cancelled_after_input", true);
      }
      elapsedMs = sample.elapsedMs;
      lastPoint = sample;
      input.sendInputEvent({
        type: "mouseMove",
        x: Math.round(sample.x),
        y: Math.round(sample.y),
        button: "left",
      });
      input.onCursorSample?.(sample);
    }

    release();
    input.onInputSideEffect?.("action");
    return {
      cursor: lastPoint,
      source: input.plan.source,
      target: input.plan.destination,
      pointer: { button: "left", effect: "drag" },
    };
  } catch (error) {
    if (error instanceof DragExecutionError) throw error;
    throw new DragExecutionError("delivery_failed", pointerDown, error);
  } finally {
    try {
      release();
    } catch {
      // Best effort: the original failure remains authoritative.
    }
  }
}
