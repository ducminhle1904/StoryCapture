import {
  RECORDING_V4_CURSOR_COORDINATE_HEIGHT,
  RECORDING_V4_CURSOR_COORDINATE_WIDTH,
  type RecordingV4ActionSidecar,
  type RecordingV4CursorKind,
  type RecordingV4CursorSample,
  type RecordingV4CursorSidecar,
} from "@storycapture/shared-types/recording-v4";
import type { ClickFeedbackFrame, VirtualCursorSample } from "../preview/virtual-cursor-path";
import {
  CURSOR_CLICK_EFFECT_MAX_ACTIVE_FEEDBACK,
  type CursorClickEffectConfig,
  normalizeCursorClickEffect,
  sampleCursorClickEffect,
} from "../state/cursor-click-effect";
import { VIRTUAL_CURSOR_CLICK_FEEDBACK_MAX_MS } from "../state/virtual-cursor-scheduler";

interface CursorClickMoment {
  activeMediaTimeUs: number;
  x: number;
  y: number;
}

export interface PreparedRecordingV4Cursor {
  cursor: RecordingV4CursorSidecar;
  actions: RecordingV4ActionSidecar;
  clickMoments: CursorClickMoment[];
}

export interface RecordingV4CursorState {
  x: number;
  y: number;
  kind: RecordingV4CursorKind;
  visible: boolean;
  pressed: boolean;
}

function upperBoundByTime<T>(
  values: readonly T[],
  timeUs: number,
  getTime: (value: T) => number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value && getTime(value) <= timeUs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function cursorStateAt(
  cursor: RecordingV4CursorSidecar,
  activeMediaTimeUs: number,
): RecordingV4CursorState | null {
  const samples = cursor.samples;
  if (samples.length === 0) return null;
  const upper = upperBoundByTime(
    samples,
    activeMediaTimeUs,
    (sample) => sample.active_media_time_us,
  );
  if (upper === 0) return null;
  const left = samples[upper - 1];
  if (!left) return null;
  const right = samples[upper];
  if (!right || right.active_media_time_us <= left.active_media_time_us) {
    return {
      x: left.x,
      y: left.y,
      kind: left.kind,
      visible: left.visible,
      pressed: left.pressed,
    };
  }
  const progress = Math.max(
    0,
    Math.min(
      1,
      (activeMediaTimeUs - left.active_media_time_us) /
        (right.active_media_time_us - left.active_media_time_us),
    ),
  );
  return {
    x: left.x + (right.x - left.x) * progress,
    y: left.y + (right.y - left.y) * progress,
    kind: left.kind,
    visible: left.visible,
    pressed: left.pressed,
  };
}

function normalizedTargetCenter(
  target: NonNullable<RecordingV4ActionSidecar["events"][number]["target"]>,
): { x: number; y: number } {
  return {
    x: Math.max(
      0,
      Math.min(
        1,
        (target.bounds.x + target.bounds.width / 2) / RECORDING_V4_CURSOR_COORDINATE_WIDTH,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        1,
        (target.bounds.y + target.bounds.height / 2) / RECORDING_V4_CURSOR_COORDINATE_HEIGHT,
      ),
    ),
  };
}

function buildClickMoments(
  actions: RecordingV4ActionSidecar,
  cursor: RecordingV4CursorSidecar,
): CursorClickMoment[] {
  const moments: CursorClickMoment[] = [];
  let previous: RecordingV4CursorSample | undefined;
  for (const sample of cursor.samples) {
    if (sample.pressed && !previous?.pressed) {
      moments.push({
        activeMediaTimeUs: sample.active_media_time_us,
        x: sample.x,
        y: sample.y,
      });
    }
    previous = sample;
  }
  for (const event of actions.events) {
    if (event.verb !== "click" || !event.timing) continue;
    const point = event.target
      ? normalizedTargetCenter(event.target)
      : cursorStateAt(cursor, event.timing.action_us);
    if (!point) continue;
    moments.push({
      activeMediaTimeUs: event.timing.action_us,
      x: point.x,
      y: point.y,
    });
  }
  moments.sort((a, b) => a.activeMediaTimeUs - b.activeMediaTimeUs);
  return moments.filter(
    (moment, index) =>
      index === 0 ||
      Math.abs(moment.activeMediaTimeUs - (moments[index - 1]?.activeMediaTimeUs ?? -Infinity)) >
        50_000,
  );
}

export function prepareRecordingV4Cursor(
  actions: RecordingV4ActionSidecar,
  cursor: RecordingV4CursorSidecar,
): PreparedRecordingV4Cursor {
  if (actions.session_id !== cursor.session_id) {
    throw new Error("Recording V4 cursor runtime requires matching sidecar sessions");
  }
  return { actions, cursor, clickMoments: buildClickMoments(actions, cursor) };
}

function clickFeedbackAt(
  runtime: PreparedRecordingV4Cursor,
  activeMediaTimeUs: number,
  configValue?: CursorClickEffectConfig,
): { feedback: ClickFeedbackFrame[]; cursorScale: number } {
  const config = normalizeCursorClickEffect(configValue);
  const feedback: ClickFeedbackFrame[] = [];
  let cursorScale = 1;
  const upper = upperBoundByTime(
    runtime.clickMoments,
    activeMediaTimeUs,
    (moment) => moment.activeMediaTimeUs,
  );
  for (let index = upper - 1; index >= 0; index -= 1) {
    const moment = runtime.clickMoments[index];
    if (!moment) continue;
    const elapsedMs = (activeMediaTimeUs - moment.activeMediaTimeUs) / 1_000;
    if (elapsedMs > VIRTUAL_CURSOR_CLICK_FEEDBACK_MAX_MS) break;
    const frame = sampleCursorClickEffect(config, elapsedMs);
    if (!frame) continue;
    feedback.push({
      x: moment.x,
      y: moment.y,
      elapsedMs,
      progress: frame.progress,
      primitives: frame.primitives,
    });
    if (feedback.length === 1 && config.style === "press") cursorScale = frame.cursorScale;
    if (feedback.length === CURSOR_CLICK_EFFECT_MAX_ACTIVE_FEEDBACK) break;
  }
  feedback.reverse();
  return { feedback, cursorScale };
}

export function sampleRecordingV4Cursor(
  runtime: PreparedRecordingV4Cursor,
  activeMediaTimeUs: number,
  clickEffect?: CursorClickEffectConfig,
): VirtualCursorSample | null {
  const state = cursorStateAt(runtime.cursor, Math.max(0, activeMediaTimeUs));
  if (!state) return null;
  const click = clickFeedbackAt(runtime, Math.max(0, activeMediaTimeUs), clickEffect);
  return {
    ...state,
    clickFeedback: click.feedback,
    cursorScale: click.cursorScale,
  };
}

export function recordingV4TargetBounds(
  actions: RecordingV4ActionSidecar,
): Map<string, { x: number; y: number; w: number; h: number }> {
  const boundsByStepId = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const event of actions.events) {
    if (!event.step_id || !event.target || boundsByStepId.has(event.step_id)) continue;
    const bounds = event.target.bounds;
    const x1 = Math.max(0, Math.min(1, bounds.x / RECORDING_V4_CURSOR_COORDINATE_WIDTH));
    const y1 = Math.max(0, Math.min(1, bounds.y / RECORDING_V4_CURSOR_COORDINATE_HEIGHT));
    const x2 = Math.max(
      0,
      Math.min(1, (bounds.x + bounds.width) / RECORDING_V4_CURSOR_COORDINATE_WIDTH),
    );
    const y2 = Math.max(
      0,
      Math.min(1, (bounds.y + bounds.height) / RECORDING_V4_CURSOR_COORDINATE_HEIGHT),
    );
    boundsByStepId.set(event.step_id, {
      x: x1,
      y: y1,
      w: Math.max(0, x2 - x1),
      h: Math.max(0, y2 - y1),
    });
  }
  return boundsByStepId;
}
