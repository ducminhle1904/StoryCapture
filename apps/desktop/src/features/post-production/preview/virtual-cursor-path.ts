import type { ActionPoint, ActionTimelineEvent, RecordingActions } from "@/ipc/actions";
import { type CursorMotionPreset, normalizeCursorMotionPreset } from "../state/timeline-slice";

export interface VirtualCursorSample {
  x: number;
  y: number;
  ripple: {
    x: number;
    y: number;
    progress: number;
    opacity: number;
  } | null;
}

const CLICK_RIPPLE_MS = 520;

interface CursorMotionProfile {
  minTravelMs: number;
  maxTravelMs: number;
  travelPxPerMs: number;
}

const CURSOR_MOTION_PROFILES: Record<CursorMotionPreset, CursorMotionProfile> = {
  natural: { minTravelMs: 320, maxTravelMs: 980, travelPxPerMs: 2.4 },
  snappy: { minTravelMs: 220, maxTravelMs: 720, travelPxPerMs: 3.2 },
  cinematic: { minTravelMs: 420, maxTravelMs: 1250, travelPxPerMs: 1.8 },
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function smootherstep(value: number): number {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function distance(a: ActionPoint, b: ActionPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function travelDurationMs(
  from: ActionPoint,
  to: ActionPoint,
  profile: CursorMotionProfile,
): number {
  return Math.round(
    clamp(distance(from, to) / profile.travelPxPerMs, profile.minTravelMs, profile.maxTravelMs),
  );
}

function movementStartMs(
  previousT: number,
  event: ActionTimelineEvent,
  from: ActionPoint,
  to: ActionPoint,
  profile: CursorMotionProfile,
) {
  const actionT = Math.max(0, event.t_action_ms);
  const declaredWindow = actionT - event.t_start_ms;
  if (declaredWindow >= profile.minTravelMs / 2) {
    return Math.min(actionT, Math.max(previousT, event.t_start_ms));
  }
  if (actionT === 0) return 0;
  return Math.min(actionT, Math.max(previousT, actionT - travelDurationMs(from, to, profile)));
}

function canvasSize(actions: RecordingActions): { width: number; height: number } {
  const width = Math.max(1, actions.capture_rect.width || actions.viewport.width || 1);
  const height = Math.max(1, actions.capture_rect.height || actions.viewport.height || 1);
  return { width, height };
}

function eventPoint(
  actions: RecordingActions,
  event: ActionTimelineEvent,
  fallback: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const center = event.target?.center;
  if (!center) return fallback;
  return {
    x: clamp(center.x - actions.capture_rect.x, 0, size.width),
    y: clamp(center.y - actions.capture_rect.y, 0, size.height),
  };
}

function isClickEvent(event: ActionTimelineEvent): boolean {
  return event.verb === "click" || event.pointer?.effect === "click";
}

export function sampleVirtualCursor(
  actions: RecordingActions | null | undefined,
  tMs: number,
  motionPreset?: CursorMotionPreset,
): VirtualCursorSample | null {
  if (!actions || actions.events.length === 0) return null;

  const profile = CURSOR_MOTION_PROFILES[normalizeCursorMotionPreset(motionPreset)];
  const size = canvasSize(actions);
  let previous: ActionPoint = { x: size.width / 2, y: size.height / 2 };
  let previousT = 0;

  for (const event of actions.events) {
    const target = eventPoint(actions, event, previous, size);
    const startT = movementStartMs(previousT, event, previous, target, profile);
    const actionT = Math.max(startT, event.t_action_ms);

    if (tMs < startT) {
      return withRipple(actions, { x: previous.x / size.width, y: previous.y / size.height }, tMs);
    }

    if (tMs <= actionT) {
      const span = Math.max(1, actionT - startT);
      const amount = smootherstep((tMs - startT) / span);
      const pos = {
        x: previous.x + (target.x - previous.x) * amount,
        y: previous.y + (target.y - previous.y) * amount,
      };
      return withRipple(actions, { x: pos.x / size.width, y: pos.y / size.height }, tMs);
    }

    previous = target;
    previousT = Math.max(actionT, event.t_end_ms);
  }

  return withRipple(actions, { x: previous.x / size.width, y: previous.y / size.height }, tMs);
}

function withRipple(
  actions: RecordingActions,
  sample: { x: number; y: number },
  tMs: number,
): VirtualCursorSample {
  const size = canvasSize(actions);
  let active: { event: ActionTimelineEvent; elapsed: number } | null = null;
  for (let i = actions.events.length - 1; i >= 0; i -= 1) {
    const event = actions.events[i];
    if (!event) continue;
    if (!isClickEvent(event) || !event.target) continue;
    const elapsed = tMs - event.t_action_ms;
    if (elapsed < 0) continue;
    if (elapsed > CLICK_RIPPLE_MS) break;
    if (!active || elapsed < active.elapsed) active = { event, elapsed };
  }

  if (!active) return { ...sample, ripple: null };

  const point = eventPoint(
    actions,
    active.event,
    { x: sample.x * size.width, y: sample.y * size.height },
    size,
  );
  const progress = clamp01(active.elapsed / CLICK_RIPPLE_MS);
  return {
    ...sample,
    ripple: {
      x: point.x / size.width,
      y: point.y / size.height,
      progress,
      opacity: 1 - progress,
    },
  };
}
