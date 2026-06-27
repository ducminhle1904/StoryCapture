import type { ActionPoint, ActionTimelineEvent, RecordingActions } from "@/ipc/actions";
import { type CursorMotionProfile, cursorMotionProfile } from "../state/cursor-motion";
import {
  buildVirtualCursorSchedule,
  VIRTUAL_CURSOR_CLICK_RIPPLE_MS,
  type VirtualCursorSchedule,
} from "../state/virtual-cursor-scheduler";
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

export function sampleVirtualCursor(
  actions: RecordingActions | null | undefined,
  tMs: number,
  motionPreset?: CursorMotionPreset,
): VirtualCursorSample | null {
  const schedule = buildVirtualCursorSchedule(actions, motionPreset);
  if (!schedule) return null;
  const profile = cursorMotionProfile(motionPreset);

  for (const segment of schedule.segments) {
    const { event, from, to, startMs, arrivalMs } = segment;

    if (tMs < startMs) {
      return withRipple(
        schedule,
        { x: from.x / schedule.size.width, y: from.y / schedule.size.height },
        tMs,
      );
    }

    if (tMs <= arrivalMs) {
      const span = Math.max(1, arrivalMs - startMs);
      const pos = curvedCursorPoint(from, to, event, (tMs - startMs) / span, profile);
      return withRipple(
        schedule,
        { x: pos.x / schedule.size.width, y: pos.y / schedule.size.height },
        tMs,
      );
    }
  }

  const final = schedule.segments.at(-1);
  if (!final) return null;
  return withRipple(
    schedule,
    { x: final.to.x / schedule.size.width, y: final.to.y / schedule.size.height },
    tMs,
  );
}

function withRipple(
  schedule: VirtualCursorSchedule,
  sample: { x: number; y: number },
  tMs: number,
): VirtualCursorSample {
  const size = schedule.size;
  let active: { segment: VirtualCursorSchedule["segments"][number]; elapsed: number } | null =
    null;
  for (let i = schedule.segments.length - 1; i >= 0; i -= 1) {
    const segment = schedule.segments[i];
    if (!segment) continue;
    const event = segment.event;
    if (!isClickEvent(event) || !event.target) continue;
    const elapsed = tMs - segment.arrivalMs;
    if (elapsed < 0) continue;
    if (elapsed > VIRTUAL_CURSOR_CLICK_RIPPLE_MS) break;
    if (!active || elapsed < active.elapsed) active = { segment, elapsed };
  }

  if (!active) return { ...sample, ripple: null };

  const point = active.segment.to;
  const progress = clamp01(active.elapsed / VIRTUAL_CURSOR_CLICK_RIPPLE_MS);
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
