export interface ActionPoint {
  x: number;
  y: number;
}

export interface ActionBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ActionCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActionTarget {
  kind: string;
  label: string | null;
  center: ActionPoint;
  bounds: ActionBounds;
}

export type ActionCursorMotionPreset = "natural" | "snappy" | "cinematic";

export interface ActionCursorTiming {
  motion_preset: ActionCursorMotionPreset;
  start_ms: number;
  arrival_ms: number;
  travel_ms: number;
  dwell_ms: number;
}

export type ActionInputKind =
  | "click"
  | "focus"
  | "hover"
  | "type"
  | "select"
  | "scroll"
  | "drag"
  | "upload";

export interface ActionInputTiming {
  kind: ActionInputKind;
  down_ms?: number;
  up_ms?: number;
  action_ms: number;
  text_start_ms?: number;
  text_end_ms?: number;
}

export type ActionSourceVersion = 1 | 2 | 3;
export type ActionEventConfidence = "legacy-approximate" | "validated" | "authoritative";
export type ActionRecordingConfidence = ActionEventConfidence | "mixed";

export interface ActionMediaLandmark {
  frame_index: number;
  pts_us: number;
}

export interface ActionCursorPath {
  interpolation: string;
  samples: Array<ActionMediaLandmark & ActionPoint>;
  arrival: ActionMediaLandmark;
}

export interface ActionInputLandmarks {
  action?: ActionMediaLandmark;
  down?: ActionMediaLandmark;
  up?: ActionMediaLandmark;
  text_start?: ActionMediaLandmark;
  text_end?: ActionMediaLandmark;
}

export interface ActionPresentation {
  status: "presented" | "timeout" | "not_applicable";
  first_post_input_frame?: ActionMediaLandmark;
  first_post_input_paint?: ActionMediaLandmark;
  diagnostic_reason?: string;
}

export interface ActionMediaClock {
  clock: "encoded_video_pts";
  unit: "us";
  fps_num: number;
  fps_den: number;
  origin_frame: 0;
  frame_count: number;
  duration_us: number;
}

export interface ActionTimelineEvent {
  source_index: number;
  confidence: ActionEventConfidence;
  step_id: string | null;
  ordinal: number;
  verb: string;
  t_start_ms: number;
  t_action_ms: number;
  t_end_ms: number;
  target: ActionTarget | null;
  secondary_target: ActionTarget | null;
  pointer: { button: string; effect: string } | null;
  cursor_timing: ActionCursorTiming | null;
  input_timing: ActionInputTiming | null;
  cursor_path?: ActionCursorPath;
  input_landmarks?: ActionInputLandmarks;
  presentation?: ActionPresentation;
}

export interface RecordingActions {
  source_version: ActionSourceVersion;
  confidence: ActionRecordingConfidence;
  recording_path: string;
  cursor_motion_preset: ActionCursorMotionPreset;
  viewport: { width: number; height: number };
  capture_rect: ActionCaptureRect;
  fps_num: number;
  fps_den: number;
  frame_count: number;
  media_clock?: ActionMediaClock;
  events: ActionTimelineEvent[];
}

type JsonRecord = Record<string, unknown>;

const INPUT_KINDS = new Set<ActionInputKind>([
  "click",
  "focus",
  "hover",
  "type",
  "select",
  "scroll",
  "drag",
  "upload",
]);
const MOTION_PRESETS = new Set<ActionCursorMotionPreset>(["natural", "snappy", "cinematic"]);
const CURSOR_INTERACTION_VERBS = new Set(["click", "type", "hover", "select"]);

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function positiveDimension(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right > 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1;
}

function rationalFromFps(value: unknown): { fps_num: number; fps_den: number } | null {
  const fps = positiveDimension(value);
  if (fps === null) return null;
  const denominator = Number.isInteger(fps) ? 1 : 1_000_000;
  const numerator = Math.round(fps * denominator);
  if (!Number.isSafeInteger(numerator) || numerator <= 0) return null;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { fps_num: numerator / divisor, fps_den: denominator / divisor };
}

function parseViewport(value: unknown): { width: number; height: number } | null {
  const record = asRecord(value);
  if (!record) return null;
  const width = positiveDimension(record.width);
  const height = positiveDimension(record.height);
  return width !== null && height !== null ? { width, height } : null;
}

function parseCaptureRect(
  value: unknown,
): { x: number; y: number; width: number; height: number } | null {
  const record = asRecord(value);
  if (!record) return null;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const width = positiveDimension(record.width);
  const height = positiveDimension(record.height);
  return x !== null && y !== null && width !== null && height !== null
    ? { x, y, width, height }
    : null;
}

function parsePoint(value: unknown): ActionPoint | null {
  const record = asRecord(value);
  if (!record) return null;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  return x !== null && y !== null ? { x, y } : null;
}

function parseBounds(value: unknown): ActionBounds | null {
  const record = asRecord(value);
  if (!record) return null;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const w = positiveDimension(record.w);
  const h = positiveDimension(record.h);
  return x !== null && y !== null && w !== null && h !== null ? { x, y, w, h } : null;
}

function parseTarget(value: unknown): { target: ActionTarget | null; valid: boolean } {
  if (value === null) return { target: null, valid: true };
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string" || record.kind.length === 0) {
    return { target: null, valid: false };
  }
  if (record.label !== null && typeof record.label !== "string") {
    return { target: null, valid: false };
  }
  const center = parsePoint(record.center);
  const bounds = parseBounds(record.bounds);
  if (!center || !bounds) return { target: null, valid: false };
  return {
    target: { kind: record.kind, label: record.label as string | null, center, bounds },
    valid: true,
  };
}

function parsePointer(value: unknown): {
  pointer: { button: string; effect: string } | null;
  valid: boolean;
} {
  if (value === null) return { pointer: null, valid: true };
  const record = asRecord(value);
  if (
    !record ||
    typeof record.button !== "string" ||
    record.button.length === 0 ||
    typeof record.effect !== "string" ||
    record.effect.length === 0
  ) {
    return { pointer: null, valid: false };
  }
  return { pointer: { button: record.button, effect: record.effect }, valid: true };
}

function motionPreset(value: unknown): ActionCursorMotionPreset | null {
  return typeof value === "string" && MOTION_PRESETS.has(value as ActionCursorMotionPreset)
    ? (value as ActionCursorMotionPreset)
    : null;
}

function inputKindForVerb(verb: string): ActionInputKind | null {
  return INPUT_KINDS.has(verb as ActionInputKind) ? (verb as ActionInputKind) : null;
}

function derivedInputTiming(verb: string, actionMs: number): ActionInputTiming | null {
  const kind = inputKindForVerb(verb);
  return kind ? { kind, action_ms: actionMs } : null;
}

function optionalTime(
  record: JsonRecord,
  key: keyof ActionInputTiming,
  startMs: number,
  endMs: number,
): number | undefined | null {
  if (!(key in record)) return undefined;
  const value = nonNegativeNumber(record[key]);
  return value !== null && value >= startMs && value <= endMs ? value : null;
}

function parseInputTiming(
  value: unknown,
  verb: string,
  startMs: number,
  actionMs: number,
  endMs: number,
): { timing: ActionInputTiming | null; valid: boolean } {
  const fallback = derivedInputTiming(verb, actionMs);
  const record = asRecord(value);
  if (
    !record ||
    typeof record.kind !== "string" ||
    !INPUT_KINDS.has(record.kind as ActionInputKind)
  ) {
    return { timing: fallback, valid: false };
  }
  const inputActionMs = nonNegativeNumber(record.action_ms);
  if (inputActionMs === null || inputActionMs < startMs || inputActionMs > endMs) {
    return { timing: fallback, valid: false };
  }
  const downMs = optionalTime(record, "down_ms", startMs, endMs);
  const upMs = optionalTime(record, "up_ms", startMs, endMs);
  const textStartMs = optionalTime(record, "text_start_ms", startMs, endMs);
  const textEndMs = optionalTime(record, "text_end_ms", startMs, endMs);
  if (
    downMs === null ||
    upMs === null ||
    textStartMs === null ||
    textEndMs === null ||
    (downMs !== undefined && upMs !== undefined && downMs > upMs) ||
    (textStartMs !== undefined && textEndMs !== undefined && textStartMs > textEndMs)
  ) {
    return { timing: fallback, valid: false };
  }
  return {
    timing: {
      kind: record.kind as ActionInputKind,
      ...(downMs !== undefined ? { down_ms: downMs } : {}),
      ...(upMs !== undefined ? { up_ms: upMs } : {}),
      action_ms: inputActionMs,
      ...(textStartMs !== undefined ? { text_start_ms: textStartMs } : {}),
      ...(textEndMs !== undefined ? { text_end_ms: textEndMs } : {}),
    },
    valid: true,
  };
}

function parseCursorTiming(
  value: unknown,
  inputActionMs: number,
): { timing: ActionCursorTiming | null; valid: boolean } {
  const record = asRecord(value);
  if (!record) return { timing: null, valid: false };
  const preset = motionPreset(record.motion_preset);
  const startMs = nonNegativeNumber(record.start_ms);
  const arrivalMs = nonNegativeNumber(record.arrival_ms);
  const travelMs = nonNegativeNumber(record.travel_ms);
  const dwellMs = nonNegativeNumber(record.dwell_ms);
  if (
    !preset ||
    startMs === null ||
    arrivalMs === null ||
    travelMs === null ||
    dwellMs === null ||
    startMs > arrivalMs ||
    arrivalMs > inputActionMs ||
    travelMs > arrivalMs - startMs ||
    arrivalMs + dwellMs > inputActionMs
  ) {
    return { timing: null, valid: false };
  }
  return {
    timing: {
      motion_preset: preset,
      start_ms: startMs,
      arrival_ms: arrivalMs,
      travel_ms: travelMs,
      dwell_ms: dwellMs,
    },
    valid: true,
  };
}

function parseMediaClock(value: unknown): ActionMediaClock | null {
  const record = asRecord(value);
  if (!record || record.clock !== "encoded_video_pts" || record.unit !== "us") return null;
  const fpsNum = positiveInteger(record.fps_num);
  const fpsDen = positiveInteger(record.fps_den);
  const frameCount = nonNegativeInteger(record.frame_count);
  const durationUs = nonNegativeInteger(record.duration_us);
  if (
    fpsNum === null ||
    fpsDen === null ||
    record.origin_frame !== 0 ||
    frameCount === null ||
    durationUs === null
  ) {
    return null;
  }
  return {
    clock: "encoded_video_pts",
    unit: "us",
    fps_num: fpsNum,
    fps_den: fpsDen,
    origin_frame: 0,
    frame_count: frameCount,
    duration_us: durationUs,
  };
}

function parseLandmark(value: unknown, clock: ActionMediaClock): ActionMediaLandmark | null {
  const record = asRecord(value);
  if (!record) return null;
  const frameIndex = nonNegativeInteger(record.frame_index);
  const ptsUs = nonNegativeInteger(record.pts_us);
  if (
    frameIndex === null ||
    ptsUs === null ||
    frameIndex >= clock.frame_count ||
    ptsUs > clock.duration_us
  ) {
    return null;
  }
  return { frame_index: frameIndex, pts_us: ptsUs };
}

function parseCursorPath(value: unknown, clock: ActionMediaClock): ActionCursorPath | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.interpolation !== "string" ||
    !/^[a-z][a-z0-9-]*-v[1-9]\d*$/.test(record.interpolation) ||
    !Array.isArray(record.samples)
  ) {
    return null;
  }
  const samples: ActionCursorPath["samples"] = [];
  let previousFrame = -1;
  let previousPts = -1;
  for (const rawSample of record.samples) {
    const landmark = parseLandmark(rawSample, clock);
    const point = parsePoint(rawSample);
    if (
      !landmark ||
      !point ||
      landmark.frame_index <= previousFrame ||
      landmark.pts_us < previousPts
    ) {
      return null;
    }
    samples.push({ ...landmark, ...point });
    previousFrame = landmark.frame_index;
    previousPts = landmark.pts_us;
  }
  const arrival = parseLandmark(record.arrival, clock);
  if (
    !arrival ||
    arrival.frame_index < previousFrame ||
    arrival.pts_us < previousPts ||
    samples.length === 0
  ) {
    return null;
  }
  return { interpolation: record.interpolation, samples, arrival };
}

function parseInputLandmarks(value: unknown, clock: ActionMediaClock): ActionInputLandmarks | null {
  const record = asRecord(value);
  if (!record) return null;
  const output: ActionInputLandmarks = {};
  for (const key of ["action", "down", "up", "text_start", "text_end"] as const) {
    if (!(key in record)) continue;
    const landmark = parseLandmark(record[key], clock);
    if (!landmark) return null;
    output[key] = landmark;
  }
  if (Object.keys(output).length === 0) return null;
  if (output.down && output.up && output.down.pts_us > output.up.pts_us) return null;
  if (output.text_start && output.text_end && output.text_start.pts_us > output.text_end.pts_us) {
    return null;
  }
  return output;
}

function parsePresentation(value: unknown, clock: ActionMediaClock): ActionPresentation | null {
  const record = asRecord(value);
  if (
    !record ||
    (record.status !== "presented" &&
      record.status !== "timeout" &&
      record.status !== "not_applicable")
  ) {
    return null;
  }
  const firstFrame =
    "first_post_input_frame" in record
      ? parseLandmark(record.first_post_input_frame, clock)
      : undefined;
  const firstPaint =
    "first_post_input_paint" in record
      ? parseLandmark(record.first_post_input_paint, clock)
      : undefined;
  if (firstFrame === null || firstPaint === null) return null;
  if (record.diagnostic_reason !== undefined && typeof record.diagnostic_reason !== "string") {
    return null;
  }
  return {
    status: record.status,
    ...(firstFrame ? { first_post_input_frame: firstFrame } : {}),
    ...(firstPaint ? { first_post_input_paint: firstPaint } : {}),
    ...(typeof record.diagnostic_reason === "string"
      ? { diagnostic_reason: record.diagnostic_reason }
      : {}),
  };
}

function aggregateConfidence(
  events: ActionTimelineEvent[],
  fallback: ActionEventConfidence,
): ActionRecordingConfidence {
  const values = new Set(events.map((event) => event.confidence));
  if (values.size === 0) return fallback;
  return values.size === 1 ? (values.values().next().value ?? fallback) : "mixed";
}

function parseEvent(
  value: unknown,
  sourceIndex: number,
  sourceVersion: ActionSourceVersion,
  mediaClock: ActionMediaClock | undefined,
  durationMs: number,
): ActionTimelineEvent | null {
  const record = asRecord(value);
  if (!record) return null;
  const ordinal = positiveInteger(record.ordinal);
  const startMs = nonNegativeNumber(record.t_start_ms);
  const actionMs = nonNegativeNumber(record.t_action_ms);
  const endMs = nonNegativeNumber(record.t_end_ms);
  if (
    ordinal === null ||
    typeof record.verb !== "string" ||
    record.verb.length === 0 ||
    startMs === null ||
    actionMs === null ||
    endMs === null ||
    startMs > actionMs ||
    actionMs > endMs ||
    endMs > durationMs ||
    (record.step_id !== null && typeof record.step_id !== "string")
  ) {
    return null;
  }

  const target = parseTarget(record.target);
  const secondaryTarget = parseTarget(record.secondary_target);
  const pointer = parsePointer(record.pointer);
  let confidence: ActionEventConfidence = sourceVersion === 1 ? "legacy-approximate" : "validated";
  if (!target.valid || !secondaryTarget.valid || !pointer.valid) confidence = "legacy-approximate";

  const input =
    sourceVersion === 1
      ? { timing: derivedInputTiming(record.verb, actionMs), valid: false }
      : parseInputTiming(record.input_timing, record.verb, startMs, actionMs, endMs);
  if (!input.valid) confidence = "legacy-approximate";
  const inputBoundaryMs = input.timing?.action_ms ?? actionMs;

  const cursor =
    sourceVersion === 1 || record.cursor_timing === undefined || record.cursor_timing === null
      ? { timing: null, valid: sourceVersion === 1 || !CURSOR_INTERACTION_VERBS.has(record.verb) }
      : parseCursorTiming(record.cursor_timing, inputBoundaryMs);
  if (!cursor.valid) confidence = "legacy-approximate";

  let cursorPath: ActionCursorPath | undefined;
  let inputLandmarks: ActionInputLandmarks | undefined;
  let presentation: ActionPresentation | undefined;
  if (sourceVersion === 3 && mediaClock) {
    cursorPath = parseCursorPath(record.cursor_path, mediaClock) ?? undefined;
    inputLandmarks = parseInputLandmarks(record.input_landmarks, mediaClock) ?? undefined;
    presentation = parsePresentation(record.presentation, mediaClock) ?? undefined;
    const needsCursorPath = CURSOR_INTERACTION_VERBS.has(record.verb);
    const inputLandmark = inputLandmarks?.action;
    const downLandmark = inputLandmarks?.down ?? inputLandmark;
    const upLandmark = inputLandmarks?.up ?? downLandmark;
    const firstFrame = presentation?.first_post_input_frame;
    const firstPaint = presentation?.first_post_input_paint;
    const orderingValid = Boolean(
      inputLandmark &&
        downLandmark &&
        upLandmark &&
        (!cursorPath || cursorPath.arrival.pts_us <= downLandmark.pts_us) &&
        downLandmark.pts_us <= upLandmark.pts_us &&
        (!firstFrame || upLandmark.pts_us <= firstFrame.pts_us) &&
        (!firstPaint || upLandmark.pts_us <= firstPaint.pts_us),
    );
    if (orderingValid && presentation && (!needsCursorPath || cursorPath)) {
      confidence = "authoritative";
    } else {
      cursorPath = undefined;
      inputLandmarks = undefined;
      presentation = undefined;
    }
  }

  return {
    source_index: sourceIndex,
    confidence,
    step_id: record.step_id as string | null,
    ordinal,
    verb: record.verb,
    t_start_ms: startMs,
    t_action_ms: actionMs,
    t_end_ms: endMs,
    target: target.target,
    secondary_target: secondaryTarget.target,
    pointer: pointer.pointer,
    cursor_timing: cursor.timing,
    input_timing: input.timing,
    ...(cursorPath ? { cursor_path: cursorPath } : {}),
    ...(inputLandmarks ? { input_landmarks: inputLandmarks } : {}),
    ...(presentation ? { presentation } : {}),
  };
}

export function parseActionSidecar(value: unknown): RecordingActions | null {
  const record = asRecord(value);
  if (!record || (record.version !== 1 && record.version !== 2 && record.version !== 3)) {
    return null;
  }
  const sourceVersion = record.version;
  if (typeof record.recording_path !== "string" || record.recording_path.length === 0) return null;
  const viewport = parseViewport(record.viewport);
  const captureRect = parseCaptureRect(record.capture_rect);
  const frameCount = nonNegativeInteger(record.frame_count);
  const projectedFps = rationalFromFps(record.fps);
  if (!viewport || !captureRect || frameCount === null || !Array.isArray(record.events))
    return null;

  const parsedMediaClock = sourceVersion === 3 ? parseMediaClock(record.media_clock) : undefined;
  if (sourceVersion === 3 && !parsedMediaClock) return null;
  const mediaClock = parsedMediaClock ?? undefined;
  if (!mediaClock && !projectedFps) return null;
  if (mediaClock && mediaClock.frame_count !== frameCount) return null;
  const fpsNum = mediaClock?.fps_num ?? projectedFps?.fps_num;
  const fpsDen = mediaClock?.fps_den ?? projectedFps?.fps_den;
  if (!fpsNum || !fpsDen) return null;

  const preset = motionPreset(record.cursor_motion_preset) ?? "natural";
  const durationMs = mediaClock
    ? mediaClock.duration_us / 1000
    : (frameCount / (fpsNum / fpsDen)) * 1000;
  const events: ActionTimelineEvent[] = [];
  let previousInputActionMs = -1;
  for (let sourceIndex = 0; sourceIndex < record.events.length; sourceIndex += 1) {
    const event = parseEvent(
      record.events[sourceIndex],
      sourceIndex,
      sourceVersion,
      mediaClock,
      durationMs,
    );
    const inputActionMs = event?.input_timing?.action_ms ?? event?.t_action_ms ?? -1;
    if (!event || inputActionMs < previousInputActionMs) continue;
    events.push(event);
    previousInputActionMs = inputActionMs;
  }
  if (record.events.length > 0 && events.length === 0) return null;

  const fallbackConfidence: ActionEventConfidence =
    sourceVersion === 1 ? "legacy-approximate" : "validated";
  return {
    source_version: sourceVersion,
    confidence: aggregateConfidence(events, fallbackConfidence),
    recording_path: record.recording_path,
    cursor_motion_preset: preset,
    viewport,
    capture_rect: captureRect,
    fps_num: fpsNum,
    fps_den: fpsDen,
    frame_count: frameCount,
    ...(mediaClock ? { media_clock: mediaClock } : {}),
    events,
  };
}

export function parseActionSidecarJson(text: string): RecordingActions | null {
  try {
    return parseActionSidecar(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export function actionSidecarFps(actions: RecordingActions): number {
  return actions.fps_num / actions.fps_den;
}
