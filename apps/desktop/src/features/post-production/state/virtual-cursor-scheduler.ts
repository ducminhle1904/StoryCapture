import type { ActionPoint, ActionTimelineEvent, RecordingActions } from "@/ipc/actions";
import { type CursorMotionProfile, cursorMotionProfile } from "./cursor-motion";
import type { CursorMotionPreset } from "./timeline-slice";

export interface VirtualCursorSegment {
  event: ActionTimelineEvent;
  from: ActionPoint;
  to: ActionPoint;
  startMs: number;
  arrivalMs: number;
  travelMs: number;
}

export interface VirtualCursorSchedule {
  size: { width: number; height: number };
  segments: VirtualCursorSegment[];
  durationMs: number;
}

export const VIRTUAL_CURSOR_CLICK_RIPPLE_MS = 520;

const QUICK_SUCCESSION_MS = 180;
const MIN_TARGET_WIDTH_PX = 12;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
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
  if (d < 1) return 0;
  const ballistic = d / profile.travelPxPerMs;
  const indexOfDifficulty = Math.log2(d / targetWidth(event) + 1);
  const aimed = profile.fittsInterceptMs + profile.fittsSlopeMs * indexOfDifficulty;
  return Math.round(clamp(Math.max(ballistic, aimed), profile.minTravelMs, profile.maxTravelMs));
}

function canvasSize(actions: RecordingActions): { width: number; height: number } {
  const width = Math.max(1, actions.capture_rect.width || actions.viewport.width || 1);
  const height = Math.max(1, actions.capture_rect.height || actions.viewport.height || 1);
  return { width, height };
}

function eventPoint(
  actions: RecordingActions,
  event: ActionTimelineEvent,
  fallback: ActionPoint,
  size: { width: number; height: number },
): ActionPoint {
  const center = event.target?.center;
  if (!center) return fallback;
  return {
    x: clamp(center.x - actions.capture_rect.x, 0, size.width),
    y: clamp(center.y - actions.capture_rect.y, 0, size.height),
  };
}

function nextReadyMs(
  event: ActionTimelineEvent,
  arrivalMs: number,
  next: ActionTimelineEvent | undefined,
): number {
  const eventEnd = Math.max(arrivalMs, event.t_end_ms);
  if (!next) return eventEnd;
  const nextStart = Math.max(0, Math.min(next.t_start_ms, next.t_action_ms));
  return nextStart - eventEnd < QUICK_SUCCESSION_MS ? arrivalMs : eventEnd;
}

function actionsDurationMs(actions: RecordingActions): number {
  let eventMaxEndMs = 0;
  for (const event of actions.events) {
    eventMaxEndMs = Math.max(eventMaxEndMs, event.t_end_ms);
  }
  if (eventMaxEndMs > 0) return eventMaxEndMs;
  return actions.fps > 0 ? Math.round((actions.frame_count / actions.fps) * 1000) : 0;
}

function isClickEvent(event: ActionTimelineEvent): boolean {
  return event.verb === "click" || event.pointer?.effect === "click";
}

export function buildVirtualCursorSchedule(
  actions: RecordingActions | null | undefined,
  motionPreset?: CursorMotionPreset,
): VirtualCursorSchedule | null {
  if (!actions || actions.events.length === 0) return null;

  const profile = cursorMotionProfile(motionPreset);
  const size = canvasSize(actions);
  const segments: VirtualCursorSegment[] = [];
  let previous: ActionPoint = { x: size.width / 2, y: size.height / 2 };
  let readyMs = 0;
  let durationMs = actionsDurationMs(actions);

  for (let i = 0; i < actions.events.length; i += 1) {
    const event = actions.events[i];
    if (!event) continue;

    const target = eventPoint(actions, event, previous, size);
    const actionMs = Math.max(0, event.t_action_ms);
    const eventStartMs = Math.max(0, Math.min(event.t_start_ms, actionMs));
    const travelMs = travelDurationMs(previous, target, event, profile);
    const declaredWindowMs = actionMs - eventStartMs;
    const preferredStartMs =
      declaredWindowMs >= travelMs ? eventStartMs : actionMs - travelMs;
    const startMs = Math.max(0, readyMs, preferredStartMs);
    const arrivalMs = Math.max(actionMs, startMs + travelMs);

    const segment = {
      event,
      from: previous,
      to: target,
      startMs,
      arrivalMs,
      travelMs,
    };
    segments.push(segment);

    durationMs = Math.max(
      durationMs,
      arrivalMs,
      isClickEvent(event) && event.target
        ? arrivalMs + VIRTUAL_CURSOR_CLICK_RIPPLE_MS
        : arrivalMs,
    );
    previous = target;
    readyMs = nextReadyMs(event, arrivalMs, actions.events[i + 1]);
    durationMs = Math.max(durationMs, readyMs);
  }

  return { size, segments, durationMs: Math.ceil(durationMs) };
}

export function virtualCursorVisualDurationMs(
  actions: RecordingActions | null | undefined,
  motionPreset?: CursorMotionPreset,
): number {
  return buildVirtualCursorSchedule(actions, motionPreset)?.durationMs ?? 0;
}
