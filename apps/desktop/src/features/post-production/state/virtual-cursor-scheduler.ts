import {
  type ActionPoint,
  type ActionTimelineEvent,
  actionSidecarFps,
  type RecordingActions,
} from "@/ipc/action-sidecar";
import { type CursorMotionProfile, cursorMotionProfile } from "./cursor-motion";
import type { CursorMotionPreset } from "./timeline-slice";

export interface VirtualCursorSegment {
  event: ActionTimelineEvent;
  from: ActionPoint;
  to: ActionPoint;
  startMs: number;
  arrivalMs: number;
  travelMs: number;
  requestedTravelMs: number;
  compressed: boolean;
  snapped: boolean;
  effectMs: number;
}

export interface VirtualCursorSchedule {
  size: { width: number; height: number };
  segments: VirtualCursorSegment[];
  durationMs: number;
  motionPreset: CursorMotionPreset;
  holds: Array<{ sourcePtsUs: number; durationUs: number }>;
  totalInsertedHoldMs: number;
}

export interface VirtualCursorScheduleOptions {
  preserveFullMotion?: boolean;
}

export const VIRTUAL_CURSOR_CLICK_RIPPLE_MS = 520;

const MIN_TARGET_WIDTH_PX = 12;
const CURSOR_INTERACTION_VERBS = new Set(["click", "type", "hover", "select"]);

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

function actionsDurationMs(events: ActionTimelineEvent[], actions: RecordingActions): number {
  let eventMaxEndMs = 0;
  for (const event of events) {
    eventMaxEndMs = Math.max(eventMaxEndMs, event.t_end_ms);
  }
  if (eventMaxEndMs > 0) return eventMaxEndMs;
  const fps = actionSidecarFps(actions);
  return fps > 0 ? Math.round((actions.frame_count / fps) * 1000) : 0;
}

export function isCursorInteractionVerb(verb: string | null | undefined): boolean {
  return Boolean(verb && CURSOR_INTERACTION_VERBS.has(verb));
}

function isClickEvent(event: ActionTimelineEvent): boolean {
  return event.verb === "click" || event.pointer?.effect === "click";
}

function explicitCursorTiming(event: ActionTimelineEvent): {
  startMs: number;
  arrivalMs: number;
  travelMs: number;
} | null {
  const timing = event.cursor_timing;
  if (!timing) return null;
  const startMs = Math.max(0, timing.start_ms);
  const arrivalMs = Math.max(startMs, timing.arrival_ms);
  const travelMs = Math.max(0, Math.min(timing.travel_ms, arrivalMs - startMs));
  return { startMs, arrivalMs, travelMs };
}

function inputEffectMs(event: ActionTimelineEvent, fallbackMs: number): number {
  const actionMs = event.input_timing?.action_ms;
  return typeof actionMs === "number" && Number.isFinite(actionMs)
    ? Math.max(0, actionMs)
    : fallbackMs;
}

export function buildVirtualCursorSchedule(
  actions: RecordingActions | null | undefined,
  motionPreset?: CursorMotionPreset,
  options: VirtualCursorScheduleOptions = {},
): VirtualCursorSchedule | null {
  if (!actions || actions.events.length === 0) return null;
  const events = actions.events.filter((event) => isCursorInteractionVerb(event.verb));
  if (events.length === 0) return null;

  const resolvedPreset = motionPreset ?? actions.cursor_motion_preset;
  const profile = cursorMotionProfile(resolvedPreset);
  const size = canvasSize(actions);
  const segments: VirtualCursorSegment[] = [];
  let previous: ActionPoint = { x: size.width / 2, y: size.height / 2 };
  let previousCursorEndMs = 0;
  let durationMs = actionsDurationMs(events, actions);
  let timelineShiftMs = 0;
  const holds: VirtualCursorSchedule["holds"] = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event) continue;

    const target = eventPoint(actions, event, previous, size);
    const explicitTiming = explicitCursorTiming(event);
    const sourceInputActionMs = inputEffectMs(event, Math.max(0, event.t_action_ms));
    const sourceEventStartMs = Math.max(0, Math.min(event.t_start_ms, sourceInputActionMs));
    let inputActionMs = sourceInputActionMs + timelineShiftMs;
    const eventStartMs = sourceEventStartMs + timelineShiftMs;
    const syntheticTravelMs = travelDurationMs(previous, target, event, profile);
    const requestedTravelMs = explicitTiming?.travelMs ?? syntheticTravelMs;
    let arrivalMs = Math.min(
      inputActionMs,
      (explicitTiming?.arrivalMs ?? sourceInputActionMs) + timelineShiftMs,
    );
    const eventWindowStart = Math.min(
      arrivalMs,
      Math.max(eventStartMs, (explicitTiming?.startMs ?? sourceEventStartMs) + timelineShiftMs),
    );
    const desiredStartMs = arrivalMs - requestedTravelMs;
    let startMs = Math.min(
      arrivalMs,
      Math.max(previousCursorEndMs, eventWindowStart, desiredStartMs),
    );
    let availableTravelMs = Math.max(0, arrivalMs - startMs);
    if (options.preserveFullMotion && requestedTravelMs > availableTravelMs) {
      const deficitMs = requestedTravelMs - availableTravelMs;
      holds.push({
        sourcePtsUs: Math.round(Math.max(0, startMs - timelineShiftMs) * 1000),
        durationUs: Math.round(deficitMs * 1000),
      });
      timelineShiftMs += deficitMs;
      arrivalMs += deficitMs;
      inputActionMs += deficitMs;
      startMs = arrivalMs - requestedTravelMs;
      availableTravelMs = requestedTravelMs;
    }
    const travelMs = Math.min(requestedTravelMs, availableTravelMs);
    const effectMs = inputActionMs;

    const segment = {
      event,
      from: previous,
      to: target,
      startMs,
      arrivalMs,
      travelMs,
      requestedTravelMs,
      compressed: travelMs < requestedTravelMs,
      snapped: requestedTravelMs > 0 && travelMs === 0,
      effectMs,
    };
    segments.push(segment);

    durationMs = Math.max(
      durationMs,
      arrivalMs,
      isClickEvent(event) && event.target
        ? effectMs + VIRTUAL_CURSOR_CLICK_RIPPLE_MS
        : Math.max(arrivalMs, effectMs),
    );
    previous = target;
    previousCursorEndMs = arrivalMs;
  }

  return {
    size,
    segments,
    durationMs: Math.ceil(durationMs),
    motionPreset: resolvedPreset,
    holds,
    totalInsertedHoldMs: timelineShiftMs,
  };
}

export function virtualCursorVisualDurationMs(
  actions: RecordingActions | null | undefined,
  motionPreset?: CursorMotionPreset,
): number {
  return buildVirtualCursorSchedule(actions, motionPreset)?.durationMs ?? 0;
}
