import type { RecordingActions } from "@/ipc/actions";
import type {
  CaptureRect,
  RecordingStepTiming,
  RecordingStepTimingSidecar,
} from "@/ipc/trajectory";
import { samplePreparedVirtualCursor, sampleVirtualCursor } from "../preview/virtual-cursor-path";
import type {
  AnnotationClip,
  CursorClip,
  CursorMotionPreset,
  TextAnchor,
  Vec2,
} from "./timeline-slice";
import type { VirtualCursorSchedule } from "./virtual-cursor-scheduler";

const TARGET_MARGIN = 0.06;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export function activeCursorClip(
  clips: readonly CursorClip[],
  playheadMs: number,
): CursorClip | null {
  let active: CursorClip | null = null;
  for (const clip of clips) {
    const endMs = clip.startMs + clip.durationMs;
    if (playheadMs < clip.startMs || playheadMs >= endMs) continue;
    if (!active || clip.startMs >= active.startMs) active = clip;
  }
  return active;
}

export function isActionsCursorClip(clip: CursorClip): boolean {
  return clip.trajectoryKind === "actions" || clip.trajectoryDir.endsWith(".actions.json");
}

export function safeAreaPosition(
  placement: Extract<TextAnchor, { kind: "safe-area" }>["placement"],
): Vec2 {
  if (placement === "top") return { x: 0.5, y: 0.14 };
  if (placement === "bottom") return { x: 0.5, y: 0.86 };
  return { x: 0.5, y: 0.5 };
}

function positionAroundBounds(
  bounds: { x: number; y: number; w: number; h: number },
  rect: { x: number; y: number; width: number; height: number },
  placement: Extract<TextAnchor, { kind: "target" }>["placement"],
): Vec2 | null {
  if (rect.width <= 0 || rect.height <= 0 || bounds.w <= 0 || bounds.h <= 0) return null;
  const left = (bounds.x - rect.x) / rect.width;
  const top = (bounds.y - rect.y) / rect.height;
  const right = (bounds.x + bounds.w - rect.x) / rect.width;
  const bottom = (bounds.y + bounds.h - rect.y) / rect.height;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;

  switch (placement) {
    case "top":
      return { x: clamp01(centerX), y: clamp01(top - TARGET_MARGIN) };
    case "right":
      return { x: clamp01(right + TARGET_MARGIN), y: clamp01(centerY) };
    case "bottom":
      return { x: clamp01(centerX), y: clamp01(bottom + TARGET_MARGIN) };
    case "left":
      return { x: clamp01(left - TARGET_MARGIN), y: clamp01(centerY) };
  }
}

function stepForAnchor(
  stepTiming: RecordingStepTimingSidecar | null | undefined,
  stepId: string,
): RecordingStepTiming | null {
  if (!stepId) return null;
  return stepTiming?.steps.find((step) => step.stepId === stepId) ?? null;
}

export function currentStepForPlayhead(
  stepTiming: RecordingStepTimingSidecar | null | undefined,
  playheadMs: number,
): RecordingStepTiming | null {
  const steps = stepTiming?.steps ?? [];
  let nearest: RecordingStepTiming | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const step of steps) {
    if (playheadMs >= step.startMs && playheadMs <= step.endMs) return step;
    const distance = Math.abs(playheadMs - step.startMs);
    if (distance < nearestDistance) {
      nearest = step;
      nearestDistance = distance;
    }
  }

  return nearest;
}

export function targetAnchorPosition(
  anchor: Extract<TextAnchor, { kind: "target" }>,
  actions: RecordingActions | null | undefined,
  stepTiming?: RecordingStepTimingSidecar | null,
  captureRect?: CaptureRect | null,
): Vec2 | null {
  const event = actions?.events.find(
    (item) => item.step_id === anchor.stepId && item.target?.bounds,
  );
  if (event?.target?.bounds && actions) {
    return positionAroundBounds(event.target.bounds, actions.capture_rect, anchor.placement);
  }

  const step = stepForAnchor(stepTiming, anchor.stepId);
  const rect = stepTiming?.captureRect ?? actions?.capture_rect ?? captureRect ?? null;
  if (step?.target?.bbox && rect) {
    return positionAroundBounds(step.target.bbox, rect, anchor.placement);
  }
  return null;
}

export function targetAnchorHasGeometry(
  anchor: Extract<TextAnchor, { kind: "target" }>,
  actions: RecordingActions | null | undefined,
  stepTiming?: RecordingStepTimingSidecar | null,
  captureRect?: CaptureRect | null,
): boolean {
  return Boolean(targetAnchorPosition(anchor, actions, stepTiming, captureRect));
}

export function resolveTextAnchorPosition(
  clip: AnnotationClip,
  playheadMs: number,
  actions: RecordingActions | null | undefined,
  cursorClips: readonly CursorClip[],
  stepTiming?: RecordingStepTimingSidecar | null,
  captureRect?: CaptureRect | null,
  preparedSchedules?: ReadonlyMap<CursorMotionPreset, VirtualCursorSchedule | null>,
): Vec2 {
  const anchor = clip.anchor;
  if (!anchor || anchor.kind === "screen") return clip.pos;
  if (anchor.kind === "safe-area") return safeAreaPosition(anchor.placement);
  if (anchor.kind === "target") {
    return targetAnchorPosition(anchor, actions, stepTiming, captureRect) ?? clip.pos;
  }

  const cursorClip = activeCursorClip(cursorClips, playheadMs);
  if (!actions || !cursorClip || !isActionsCursorClip(cursorClip)) return clip.pos;
  const motionPreset = cursorClip.motionPreset ?? "natural";
  const sample = preparedSchedules
    ? samplePreparedVirtualCursor(
        preparedSchedules.get(motionPreset),
        playheadMs - cursorClip.startMs,
      )
    : sampleVirtualCursor(actions, playheadMs - cursorClip.startMs, motionPreset);
  if (!sample) return clip.pos;
  return {
    x: clamp01(sample.x + anchor.offset.x),
    y: clamp01(sample.y + anchor.offset.y),
  };
}

export function avoidAnchorPosition(target: Vec2 | null, fallback: Vec2): Vec2 {
  const point = target ?? fallback;
  if (point.y < 0.38) return safeAreaPosition("bottom");
  if (point.y > 0.62) return safeAreaPosition("top");
  return point.x < 0.5 ? { x: 0.74, y: 0.5 } : { x: 0.26, y: 0.5 };
}
