import type { ActionPoint, ActionTimelineEvent, RecordingActions } from "@/ipc/actions";
import type { RecordingTrajectory } from "@/ipc/trajectory";
import {
  CURSOR_CLICK_EFFECT_MAX_ACTIVE_FEEDBACK,
  type CursorClickEffectConfig,
  type CursorClickEffectPrimitive,
  normalizeCursorClickEffect,
  sampleCursorClickEffect,
} from "../state/cursor-click-effect";
import { type CursorMotionProfile, cursorMotionProfile } from "../state/cursor-motion";
import type { CursorMotionPreset } from "../state/timeline-slice";
import {
  buildVirtualCursorSchedule,
  VIRTUAL_CURSOR_CLICK_FEEDBACK_MAX_MS,
  type VirtualCursorSchedule,
} from "../state/virtual-cursor-scheduler";

export interface ClickFeedbackFrame {
  x: number;
  y: number;
  elapsedMs: number;
  progress: number;
  primitives: CursorClickEffectPrimitive[];
}

export interface VirtualCursorSample {
  x: number;
  y: number;
  clickFeedback: ClickFeedbackFrame[];
  cursorScale: number;
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
  clickEffect?: CursorClickEffectConfig,
): VirtualCursorSample | null {
  return samplePreparedVirtualCursor(
    buildVirtualCursorSchedule(actions, motionPreset),
    tMs,
    clickEffect,
  );
}

export function samplePreparedVirtualCursor(
  schedule: VirtualCursorSchedule | null | undefined,
  tMs: number,
  clickEffect?: CursorClickEffectConfig,
): VirtualCursorSample | null {
  if (!schedule) return null;
  const profile = cursorMotionProfile(schedule.motionPreset);

  for (const segment of schedule.segments) {
    const { event, from, to, startMs, arrivalMs } = segment;

    if (tMs < startMs) {
      return withClickFeedback(
        schedule,
        { x: from.x / schedule.size.width, y: from.y / schedule.size.height },
        tMs,
        clickEffect,
      );
    }

    if (tMs <= arrivalMs) {
      const pos =
        arrivalMs === startMs
          ? to
          : curvedCursorPoint(from, to, event, (tMs - startMs) / (arrivalMs - startMs), profile);
      return withClickFeedback(
        schedule,
        { x: pos.x / schedule.size.width, y: pos.y / schedule.size.height },
        tMs,
        clickEffect,
      );
    }
  }

  const final = schedule.segments.at(-1);
  if (!final) return null;
  return withClickFeedback(
    schedule,
    { x: final.to.x / schedule.size.width, y: final.to.y / schedule.size.height },
    tMs,
    clickEffect,
  );
}

function withClickFeedback(
  schedule: VirtualCursorSchedule,
  sample: { x: number; y: number },
  tMs: number,
  value?: CursorClickEffectConfig,
): VirtualCursorSample {
  const size = schedule.size;
  const config = normalizeCursorClickEffect(value);
  const clickFeedback: ClickFeedbackFrame[] = [];
  let cursorScale = 1;
  let foundPress = false;
  for (let i = schedule.segments.length - 1; i >= 0; i -= 1) {
    const segment = schedule.segments[i];
    if (!segment) continue;
    const event = segment.event;
    if (!isClickEvent(event) || !event.target) continue;
    const elapsed = tMs - segment.effectMs;
    if (elapsed < 0) continue;
    if (elapsed > VIRTUAL_CURSOR_CLICK_FEEDBACK_MAX_MS) break;
    const frame = sampleCursorClickEffect(config, elapsed);
    if (!frame) continue;
    const point = segment.to;
    clickFeedback.push({
      x: point.x / size.width,
      y: point.y / size.height,
      elapsedMs: elapsed,
      progress: frame.progress,
      primitives: frame.primitives,
    });
    if (!foundPress && config.style === "press") {
      cursorScale = frame.cursorScale;
      foundPress = true;
    }
    if (clickFeedback.length === CURSOR_CLICK_EFFECT_MAX_ACTIVE_FEEDBACK) break;
  }
  clickFeedback.reverse();
  return { ...sample, clickFeedback, cursorScale };
}

export function sampleTrajectoryCursor(
  trajectory: RecordingTrajectory | null,
  relativeMs: number,
): VirtualCursorSample | null {
  const frames = trajectory?.frames ?? [];
  if (frames.length === 0) return null;
  let best = frames[0];
  let bestDistance = Math.abs(best.t_ms - relativeMs);
  for (const frame of frames) {
    const distance = Math.abs(frame.t_ms - relativeMs);
    if (distance > bestDistance) continue;
    best = frame;
    bestDistance = distance;
  }
  return {
    x: best.x,
    y: best.y,
    clickFeedback: [],
    cursorScale: 1,
  };
}
