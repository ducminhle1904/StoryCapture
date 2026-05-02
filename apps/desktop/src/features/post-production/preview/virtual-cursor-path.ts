import type { ActionPoint, ActionTimelineEvent, RecordingActions } from "@/ipc/actions";
import { type CursorMotionProfile, cursorMotionProfile } from "../state/cursor-motion";
import type { CursorMotionPreset } from "../state/timeline-slice";

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
const QUICK_SUCCESSION_MS = 180;
const MIN_TARGET_WIDTH_PX = 12;
const SETTLE_START = 0.86;

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

function targetWidth(event: ActionTimelineEvent): number {
  const bounds = event.target?.bounds;
  if (!bounds) return MIN_TARGET_WIDTH_PX;
  return Math.max(MIN_TARGET_WIDTH_PX, Math.min(Math.abs(bounds.w), Math.abs(bounds.h)));
}

function travelDurationMs(
  from: ActionPoint,
  to: ActionPoint,
  event: ActionTimelineEvent,
  profile: CursorMotionProfile,
): number {
  const d = distance(from, to);
  const ballistic = d / profile.travelPxPerMs;
  const indexOfDifficulty = Math.log2(d / targetWidth(event) + 1);
  const aimed = profile.fittsInterceptMs + profile.fittsSlopeMs * indexOfDifficulty;
  return Math.round(clamp(Math.max(ballistic, aimed), profile.minTravelMs, profile.maxTravelMs));
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
  return Math.min(
    actionT,
    Math.max(previousT, actionT - travelDurationMs(from, to, event, profile)),
  );
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

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function curveSign(event: ActionTimelineEvent, from: ActionPoint, to: ActionPoint): number {
  const key = `${event.step_id ?? ""}:${event.ordinal}:${event.t_action_ms}:${Math.round(
    from.x,
  )},${Math.round(from.y)}:${Math.round(to.x)},${Math.round(to.y)}`;
  return hashString(key) % 2 === 0 ? 1 : -1;
}

function quadraticBezier(a: ActionPoint, c: ActionPoint, b: ActionPoint, t: number): ActionPoint {
  const inv = 1 - t;
  return {
    x: inv * inv * a.x + 2 * inv * t * c.x + t * t * b.x,
    y: inv * inv * a.y + 2 * inv * t * c.y + t * t * b.y,
  };
}

function curvedCursorPoint(
  from: ActionPoint,
  to: ActionPoint,
  event: ActionTimelineEvent,
  rawProgress: number,
  profile: CursorMotionProfile,
): ActionPoint {
  const d = distance(from, to);
  if (d < 1) return to;

  const progress = smootherstep(rawProgress);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const nx = -dy / d;
  const ny = dx / d;
  const bend = clamp(d * profile.curveBend, 18, 90) * curveSign(event, from, to);
  const control = {
    x: (from.x + to.x) / 2 + nx * bend,
    y: (from.y + to.y) / 2 + ny * bend,
  };
  const overshootDistance = clamp(d * profile.overshoot, 0, 14);
  const overshoot = {
    x: to.x + (dx / d) * overshootDistance,
    y: to.y + (dy / d) * overshootDistance,
  };

  if (progress < SETTLE_START && overshootDistance > 0) {
    return quadraticBezier(from, control, overshoot, progress / SETTLE_START);
  }

  const settle = smootherstep((progress - SETTLE_START) / (1 - SETTLE_START));
  return {
    x: overshoot.x + (to.x - overshoot.x) * settle,
    y: overshoot.y + (to.y - overshoot.y) * settle,
  };
}

function nextPreviousT(
  event: ActionTimelineEvent,
  actionT: number,
  next: ActionTimelineEvent | undefined,
): number {
  const eventEnd = Math.max(actionT, event.t_end_ms);
  if (!next) return eventEnd;
  const nextStart = Math.max(0, Math.min(next.t_start_ms, next.t_action_ms));
  return nextStart - eventEnd < QUICK_SUCCESSION_MS ? actionT : eventEnd;
}

export function sampleVirtualCursor(
  actions: RecordingActions | null | undefined,
  tMs: number,
  motionPreset?: CursorMotionPreset,
): VirtualCursorSample | null {
  if (!actions || actions.events.length === 0) return null;

  const profile = cursorMotionProfile(motionPreset);
  const size = canvasSize(actions);
  let previous: ActionPoint = { x: size.width / 2, y: size.height / 2 };
  let previousT = 0;

  for (let i = 0; i < actions.events.length; i += 1) {
    const event = actions.events[i];
    if (!event) continue;
    const target = eventPoint(actions, event, previous, size);
    const startT = movementStartMs(previousT, event, previous, target, profile);
    const actionT = Math.max(startT, event.t_action_ms);

    if (tMs < startT) {
      return withRipple(actions, { x: previous.x / size.width, y: previous.y / size.height }, tMs);
    }

    if (tMs <= actionT) {
      const span = Math.max(1, actionT - startT);
      const pos = curvedCursorPoint(previous, target, event, (tMs - startT) / span, profile);
      return withRipple(actions, { x: pos.x / size.width, y: pos.y / size.height }, tMs);
    }

    previous = target;
    previousT = nextPreviousT(event, actionT, actions.events[i + 1]);
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
