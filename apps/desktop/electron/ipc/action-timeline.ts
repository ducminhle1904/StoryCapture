import type { RecordedActionLandmarks } from "./action-landmarks";
import { cursorCommandPolicy } from "./cursor-policy";
import { writeJsonAtomic } from "./json-store";
import { recordingBundleActionsPath, recordingBundlePublicVideoPath } from "./recording-bundle";
import type { RecordingMediaClockSnapshot } from "./recording-media-clock";
import type { ParsedCommandVerb } from "./story-parser";

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

export interface ActionTarget {
  kind: string;
  label: string | null;
  center: ActionPoint;
  bounds: ActionBounds;
}

export interface ActionPointer {
  button: string;
  effect: string;
}

export type ActionCursorMotionPreset = "natural" | "snappy" | "cinematic";

export interface ActionCursorTiming {
  motion_preset: ActionCursorMotionPreset;
  start_ms: number;
  arrival_ms: number;
  travel_ms: number;
  dwell_ms: number;
}

export interface ActionScrollTiming {
  start_ms: number;
  end_ms: number;
  duration_ms: number;
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

export interface ActionTimelineEvent {
  policy_version?: 1;
  include_cursor?: boolean;
  cursor_applicability?: "actionable" | "not_applicable";
  step_id: string | null;
  ordinal: number;
  verb: string;
  t_start_ms: number;
  t_action_ms: number;
  t_end_ms: number;
  target: ActionTarget | null;
  secondary_target: ActionTarget | null;
  pointer: ActionPointer | null;
  scroll_timing?: ActionScrollTiming | null;
  cursor_timing?: ActionCursorTiming | null;
  input_timing?: ActionInputTiming | null;
  input_delivery?: "browser_injected" | "virtual_only";
  cursor_path?: {
    interpolation: "media-frame-linear-v1";
    samples: Array<{ frame_index: number; pts_us: number; x: number; y: number }>;
    arrival: { frame_index: number; pts_us: number };
  };
  input_landmarks?: Partial<
    Record<
      "action" | "down" | "up" | "text_start" | "text_end",
      { frame_index: number; pts_us: number }
    >
  >;
  presentation?: {
    status: "presented" | "timeout" | "not_applicable" | "cancelled" | "failed";
    first_post_input_frame?: { frame_index: number; pts_us: number };
    first_post_input_paint?: { frame_index: number; pts_us: number };
    diagnostic_reason?: string;
  };
  target_match?: { source: string; fallback_index: number | null };
  gesture?: {
    kind: "drag";
    source: ActionPoint;
    destination: ActionPoint;
    samples?: Array<ActionPoint & { elapsed_ms: number }>;
    source_match?: { source: string; fallback_index: number | null };
    destination_match?: { source: string; fallback_index: number | null };
  };
  upload_asset?: {
    project_relative_path: string;
    basename: string;
    byte_size: number;
  };
}

export interface ActionCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecordingActions {
  version: number;
  recording_path: string;
  cursor_motion_preset?: ActionCursorMotionPreset;
  viewport: { width: number; height: number };
  capture_rect: ActionCaptureRect;
  fps: number;
  frame_count: number;
  media_clock?: {
    clock: "encoded_video_pts";
    unit: "us";
    fps_num: number;
    fps_den: number;
    origin_frame: 0;
    frame_count: number;
    duration_us: number;
  };
  events: ActionTimelineEvent[];
}

export interface ActionTimelineRecordingSession {
  outputPath: string;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  frameSeq: number;
  target: { kind: string };
  frameCrop: { x: number; y: number; w: number; h: number } | null;
  mediaClock?: { snapshot(): RecordingMediaClockSnapshot };
}

export interface ActionTimelineCommand {
  verb: string;
  step_id?: string | null;
}

export interface ActionTimelineEventInput {
  ordinal: number;
  command: ActionTimelineCommand;
  stepStartedAtMs: number;
  actionAtMs: number;
  stepEndedAtMs: number;
  target?: ActionTarget | null;
  secondaryTarget?: ActionTarget | null;
  pointer?: ActionPointer | null;
  scrollTiming?: ActionScrollTiming | null;
  cursorTiming?: ActionCursorTiming | null;
  inputTiming?: ActionInputTiming | null;
  landmarks?: RecordedActionLandmarks | null;
  includeCursor?: boolean;
  cursorApplicable?: boolean;
  targetMatch?: { source: string; fallbackIndex: number | null } | null;
  gesture?: ActionTimelineEvent["gesture"] | null;
  uploadAsset?: {
    projectRelativePath: string;
    basename: string;
    byteSize: number;
  } | null;
}

export interface RecordingActionsOptions {
  cursorMotionPreset?: ActionCursorMotionPreset;
  version?: 1 | 2 | 3;
  mediaClock?: RecordingMediaClockSnapshot;
  frameCount?: number;
}

export function actionsSidecarPath(recordingPath: string): string {
  const bundlePath = recordingBundleActionsPath(recordingPath);
  if (bundlePath) return bundlePath;
  return /\.[^/.]+$/.test(recordingPath)
    ? recordingPath.replace(/\.[^/.]+$/, ".actions.json")
    : `${recordingPath}.actions.json`;
}

export async function writeActionsSidecarAtomic(
  file: string,
  dto: RecordingActions,
): Promise<void> {
  await writeJsonAtomic(file, dto);
}

export function deriveActionCaptureRect(
  session: ActionTimelineRecordingSession,
): ActionCaptureRect {
  if (session.target.kind === "author_preview") {
    return {
      x: 0,
      y: 0,
      width: positiveDimension(session.width, session.outputWidth),
      height: positiveDimension(session.height, session.outputHeight),
    };
  }

  // Electron automation reports WebContents viewport coordinates. For
  // display/window captures we do not have a reliable screen-origin transform
  // here, so keep the sidecar bounded to the encoded frame.
  return {
    x: 0,
    y: 0,
    width: positiveDimension(session.outputWidth, session.width),
    height: positiveDimension(session.outputHeight, session.height),
  };
}

export function actionPointerForVerb(verb: string): ActionPointer | null {
  if (verb === "click") return { button: "left", effect: "click" };
  if (verb === "drag") return { button: "left", effect: "drag" };
  return null;
}

export function actionTimelineEventFromStep(input: ActionTimelineEventInput): ActionTimelineEvent {
  const tStart = nonNegativeMs(input.stepStartedAtMs);
  const tEnd = Math.max(tStart, nonNegativeMs(input.stepEndedAtMs));
  const tAction = clampMs(nonNegativeMs(input.actionAtMs), tStart, tEnd);
  const verb = String(input.command.verb || "unknown");

  const scrollTiming = sanitizeScrollTiming(input.scrollTiming ?? null);
  const cursorTiming = sanitizeCursorTiming(input.cursorTiming ?? null);
  const inputTiming = sanitizeInputTiming(input.inputTiming ?? null);
  const serializedLandmarks = input.landmarks ? serializeActionLandmarks(input.landmarks) : null;
  let landmarks: Partial<ActionTimelineEvent> | null = serializedLandmarks;
  if (serializedLandmarks && input.cursorApplicable === false) {
    const { cursor_path: _cursorPath, ...semanticLandmarks } = serializedLandmarks;
    landmarks = semanticLandmarks;
  } else if (serializedLandmarks && input.includeCursor === false) {
    landmarks = {
      ...serializedLandmarks,
      cursor_path: {
        ...serializedLandmarks.cursor_path,
        samples: [],
      },
    };
  }

  return {
    ...(typeof input.includeCursor === "boolean"
      ? { policy_version: 1 as const, include_cursor: input.includeCursor }
      : {}),
    ...(typeof input.cursorApplicable === "boolean"
      ? {
          cursor_applicability: input.cursorApplicable
            ? ("actionable" as const)
            : ("not_applicable" as const),
        }
      : {}),
    step_id:
      typeof input.command.step_id === "string" && input.command.step_id.length > 0
        ? input.command.step_id
        : null,
    ordinal: Math.max(1, Math.round(input.ordinal)),
    verb,
    t_start_ms: tStart,
    t_action_ms: tAction,
    t_end_ms: tEnd,
    target: sanitizeActionTarget(input.target ?? null),
    secondary_target: sanitizeActionTarget(input.secondaryTarget ?? null),
    pointer: input.pointer ?? actionPointerForVerb(verb),
    ...(scrollTiming ? { scroll_timing: scrollTiming } : {}),
    ...(cursorTiming ? { cursor_timing: cursorTiming } : {}),
    ...(inputTiming ? { input_timing: inputTiming } : {}),
    ...(landmarks ?? {}),
    ...(input.targetMatch
      ? {
          target_match: {
            source: input.targetMatch.source,
            fallback_index: input.targetMatch.fallbackIndex,
          },
        }
      : {}),
    ...(input.gesture ? { gesture: input.gesture } : {}),
    ...(input.uploadAsset
      ? {
          upload_asset: {
            project_relative_path: input.uploadAsset.projectRelativePath,
            basename: input.uploadAsset.basename,
            byte_size: input.uploadAsset.byteSize,
          },
        }
      : {}),
  };
}

export function recordingActionsFromSession(
  session: ActionTimelineRecordingSession,
  events: ActionTimelineEvent[],
  options: RecordingActionsOptions = {},
): RecordingActions {
  const cursorMotionPreset = normalizeMotionPreset(options.cursorMotionPreset);
  const clock = options.mediaClock ?? session.mediaClock?.snapshot();
  const version = options.version ?? (cursorMotionPreset ? 2 : 1);
  return {
    version,
    recording_path: recordingBundlePublicVideoPath(session.outputPath),
    ...(cursorMotionPreset ? { cursor_motion_preset: cursorMotionPreset } : {}),
    viewport: {
      width: positiveDimension(session.width, session.outputWidth),
      height: positiveDimension(session.height, session.outputHeight),
    },
    capture_rect: deriveActionCaptureRect(session),
    fps: positiveDimension(session.fps, 30),
    frame_count: Math.max(
      0,
      Math.round(finiteNumber(options.frameCount ?? session.frameSeq, 0)),
    ),
    ...(version === 3 && clock
      ? {
          media_clock: {
            clock: "encoded_video_pts" as const,
            unit: "us" as const,
            fps_num: clock.fpsNum,
            fps_den: clock.fpsDen,
            origin_frame: 0 as const,
            frame_count: clock.frameCount,
            duration_us: clock.durationUs,
          },
        }
      : {}),
    events: events.map((event) => projectActionEvent(event, version)),
  };
}

function projectActionEvent(event: ActionTimelineEvent, version: 1 | 2 | 3): ActionTimelineEvent {
  if (version === 3) return event;
  const {
    policy_version: _policyVersion,
    include_cursor: _includeCursor,
    cursor_applicability: _cursorApplicability,
    target_match: _targetMatch,
    gesture: _gesture,
    upload_asset: _uploadAsset,
    cursor_path: cursorPath,
    input_landmarks: inputLandmarks,
    input_delivery: _inputDelivery,
    presentation,
    ...compatible
  } = event;
  if (!inputLandmarks?.action) return compatible;
  const toMs = (value: { pts_us: number } | undefined, fallback: number) =>
    value ? Math.round(value.pts_us / 1000) : fallback;
  const actionMs = toMs(inputLandmarks.action, compatible.t_action_ms);
  const startMs = toMs(cursorPath?.samples[0], compatible.t_start_ms);
  const arrivalMs = toMs(cursorPath?.arrival, actionMs);
  const endMs = Math.max(actionMs, toMs(presentation?.first_post_input_frame, compatible.t_end_ms));
  return {
    ...compatible,
    t_start_ms: startMs,
    t_action_ms: actionMs,
    t_end_ms: endMs,
    ...(compatible.cursor_timing
      ? {
          cursor_timing: {
            ...compatible.cursor_timing,
            start_ms: startMs,
            arrival_ms: arrivalMs,
            travel_ms: Math.max(0, arrivalMs - startMs),
            dwell_ms: Math.max(0, actionMs - arrivalMs),
          },
        }
      : {}),
    ...(compatible.input_timing
      ? {
          input_timing: {
            ...compatible.input_timing,
            action_ms: actionMs,
            ...(inputLandmarks.down ? { down_ms: toMs(inputLandmarks.down, actionMs) } : {}),
            ...(inputLandmarks.up ? { up_ms: toMs(inputLandmarks.up, actionMs) } : {}),
            ...(inputLandmarks.text_start
              ? { text_start_ms: toMs(inputLandmarks.text_start, actionMs) }
              : {}),
            ...(inputLandmarks.text_end
              ? { text_end_ms: toMs(inputLandmarks.text_end, actionMs) }
              : {}),
          },
        }
      : {}),
  };
}

function pathIsUnsafeAssetReference(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:/.test(value) ||
    value.split(/[\\/]/).includes("..")
  );
}

export class RecordingActionsV3ValidationError extends Error {
  readonly recordingReasonCode = "action_sidecar_invalid";

  constructor(readonly issues: readonly string[]) {
    super(`action_sidecar_invalid:${issues.join(",")}`);
    this.name = "RecordingActionsV3ValidationError";
  }
}

export function validateRecordingActionsV3(
  actions: RecordingActions,
  options: { requirePresented?: boolean } = {},
): void {
  const issues: string[] = [];
  if (actions.version !== 3) issues.push("version_not_v3");
  if (!actions.media_clock) issues.push("media_clock_missing");
  const eventIds = new Set<string>();

  const validPts = (value: unknown, field: string) => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) issues.push(`${field}_invalid_pts`);
  };
  const validPoint = (value: ActionPoint, field: string) => {
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y))
      issues.push(`${field}_invalid_point`);
  };

  for (const [index, event] of actions.events.entries()) {
    const prefix = `event_${index + 1}`;
    const eventId = event.step_id ? `step:${event.step_id}` : `ordinal:${event.ordinal}`;
    if (eventIds.has(eventId)) issues.push(`${prefix}_duplicate_id`);
    eventIds.add(eventId);

    let policy: ReturnType<typeof cursorCommandPolicy> | null = null;
    try {
      policy = cursorCommandPolicy(event.verb as ParsedCommandVerb);
    } catch {
      issues.push(`${prefix}_cursor_policy_missing`);
    }
    if (policy && !policy.contributesActionEvent) issues.push(`${prefix}_unexpected_event`);
    if (event.policy_version !== 1) issues.push(`${prefix}_policy_version_missing`);
    if (typeof event.include_cursor !== "boolean") issues.push(`${prefix}_include_cursor_missing`);
    if (!Number.isFinite(event.t_start_ms) || event.t_start_ms < 0)
      issues.push(`${prefix}_invalid_start_ms`);
    if (!Number.isFinite(event.t_action_ms) || event.t_action_ms < event.t_start_ms)
      issues.push(`${prefix}_invalid_action_ms`);
    if (!Number.isFinite(event.t_end_ms) || event.t_end_ms < event.t_action_ms)
      issues.push(`${prefix}_invalid_end_ms`);

    if (event.cursor_path) {
      validPts(event.cursor_path.arrival.frame_index, `${prefix}_arrival_frame`);
      validPts(event.cursor_path.arrival.pts_us, `${prefix}_arrival`);
      for (const [sampleIndex, sample] of event.cursor_path.samples.entries()) {
        validPts(sample.frame_index, `${prefix}_sample_${sampleIndex}_frame`);
        validPts(sample.pts_us, `${prefix}_sample_${sampleIndex}`);
        validPoint(sample, `${prefix}_sample_${sampleIndex}`);
      }
    }
    if (event.include_cursor === false && event.cursor_path?.samples.length)
      issues.push(`${prefix}_cursor_samples_disabled`);
    if (event.include_cursor === false && event.cursor_timing)
      issues.push(`${prefix}_cursor_timing_disabled`);
    if (
      event.include_cursor === true &&
      policy?.visibleTrajectory &&
      event.cursor_applicability !== "not_applicable" &&
      !event.cursor_path
    )
      issues.push(`${prefix}_cursor_path_missing`);
    if (event.cursor_applicability === "not_applicable" && event.cursor_path)
      issues.push(`${prefix}_cursor_path_not_applicable`);

    for (const [kind, landmark] of Object.entries(event.input_landmarks ?? {})) {
      if (!landmark) continue;
      validPts(landmark.frame_index, `${prefix}_${kind}_frame`);
      validPts(landmark.pts_us, `${prefix}_${kind}`);
    }
    for (const required of policy?.requiredInputLandmarks ?? []) {
      if (!event.input_landmarks?.[required]) issues.push(`${prefix}_${required}_missing`);
    }

    const arrivalPts = event.cursor_path?.arrival.pts_us;
    const actionPts = event.input_landmarks?.action?.pts_us;
    const presentationPts = event.presentation?.first_post_input_frame?.pts_us;
    if (arrivalPts != null && actionPts != null && arrivalPts > actionPts)
      issues.push(`${prefix}_arrival_after_action`);
    if (actionPts != null && presentationPts != null && actionPts > presentationPts)
      issues.push(`${prefix}_action_after_presentation`);
    if (presentationPts != null) validPts(presentationPts, `${prefix}_presentation`);

    if (policy?.presentation === "required") {
      if (!event.presentation || event.presentation.status === "not_applicable") {
        issues.push(`${prefix}_presentation_missing`);
      } else if (
        event.presentation.status === "presented" &&
        !event.presentation.first_post_input_frame
      ) {
        issues.push(`${prefix}_presentation_frame_missing`);
      } else if (options.requirePresented && event.presentation.status !== "presented") {
        issues.push(`${prefix}_presentation_not_proven`);
      }
    }

    if (event.target_match) {
      if (!event.target_match.source) issues.push(`${prefix}_target_source_missing`);
      const fallbackIndex = event.target_match.fallback_index;
      if (fallbackIndex != null && (!Number.isSafeInteger(fallbackIndex) || fallbackIndex < 0)) {
        issues.push(`${prefix}_fallback_index_invalid`);
      }
    }
    if (event.gesture) {
      if (event.gesture.kind !== "drag") issues.push(`${prefix}_gesture_kind_invalid`);
      validPoint(event.gesture.source, `${prefix}_gesture_source`);
      validPoint(event.gesture.destination, `${prefix}_gesture_destination`);
      for (const [sampleIndex, sample] of (event.gesture.samples ?? []).entries()) {
        validPoint(sample, `${prefix}_gesture_sample_${sampleIndex}`);
        if (!Number.isFinite(sample.elapsed_ms) || sample.elapsed_ms < 0) {
          issues.push(`${prefix}_gesture_sample_${sampleIndex}_invalid_time`);
        }
      }
      for (const [matchName, match] of [
        ["source", event.gesture.source_match],
        ["destination", event.gesture.destination_match],
      ] as const) {
        if (!match) continue;
        if (!match.source) issues.push(`${prefix}_gesture_${matchName}_source_missing`);
        if (
          match.fallback_index != null &&
          (!Number.isSafeInteger(match.fallback_index) || match.fallback_index < 0)
        ) {
          issues.push(`${prefix}_gesture_${matchName}_fallback_index_invalid`);
        }
      }
    }
    if (event.verb === "drag" && !event.gesture) issues.push(`${prefix}_drag_gesture_missing`);
    if (event.verb === "upload") {
      const asset = event.upload_asset;
      if (!asset) {
        issues.push(`${prefix}_upload_asset_missing`);
      } else {
        if (
          !asset.project_relative_path ||
          pathIsUnsafeAssetReference(asset.project_relative_path)
        ) {
          issues.push(`${prefix}_upload_asset_path_invalid`);
        }
        if (!asset.basename || asset.basename.includes("/") || asset.basename.includes("\\")) {
          issues.push(`${prefix}_upload_asset_basename_invalid`);
        }
        if (!Number.isSafeInteger(asset.byte_size) || asset.byte_size < 0) {
          issues.push(`${prefix}_upload_asset_size_invalid`);
        }
      }
    }
  }

  if (issues.length > 0) throw new RecordingActionsV3ValidationError(issues);
}

function serializeActionLandmarks(landmarks: RecordedActionLandmarks) {
  const media = (value: { frameIndex: number; ptsUs: number }) => ({
    frame_index: value.frameIndex,
    pts_us: value.ptsUs,
  });
  return {
    input_delivery: landmarks.delivery,
    cursor_path: {
      interpolation: landmarks.cursorPath.interpolation,
      samples: landmarks.cursorPath.samples.map((sample) => ({
        ...media(sample),
        x: sample.x,
        y: sample.y,
      })),
      arrival: media(landmarks.cursorPath.arrival),
    },
    input_landmarks: Object.fromEntries(
      Object.entries(landmarks.input).map(([key, value]) => [key, media(value)]),
    ) as ActionTimelineEvent["input_landmarks"],
    presentation:
      landmarks.presentation.status === "presented"
        ? {
            status: "presented" as const,
            first_post_input_frame: media(landmarks.presentation.firstPostInputFrame),
            ...(landmarks.presentation.firstPostInputPaint
              ? { first_post_input_paint: media(landmarks.presentation.firstPostInputPaint) }
              : {}),
          }
        : landmarks.presentation.status === "timeout"
          ? {
              status: "timeout" as const,
              diagnostic_reason: landmarks.presentation.diagnosticReason,
            }
          : { status: "not_applicable" as const },
  };
}

function normalizeMotionPreset(
  preset: ActionCursorMotionPreset | undefined,
): ActionCursorMotionPreset | null {
  if (preset === "natural" || preset === "snappy" || preset === "cinematic") {
    return preset;
  }
  return null;
}

function sanitizeActionTarget(target: ActionTarget | null): ActionTarget | null {
  if (!target) return null;
  const center = {
    x: finiteNumber(target.center?.x, Number.NaN),
    y: finiteNumber(target.center?.y, Number.NaN),
  };
  const bounds = {
    x: finiteNumber(target.bounds?.x, Number.NaN),
    y: finiteNumber(target.bounds?.y, Number.NaN),
    w: finiteNumber(target.bounds?.w, Number.NaN),
    h: finiteNumber(target.bounds?.h, Number.NaN),
  };
  if (
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.w) ||
    !Number.isFinite(bounds.h)
  ) {
    return null;
  }
  return {
    kind: target.kind || "element",
    label: target.label,
    center,
    bounds,
  };
}

function sanitizeScrollTiming(timing: ActionScrollTiming | null): ActionScrollTiming | null {
  if (!timing) return null;
  const startMs = nonNegativeMs(timing.start_ms);
  const endMs = Math.max(startMs, nonNegativeMs(timing.end_ms));
  return {
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: Math.max(0, endMs - startMs),
  };
}

function sanitizeCursorTiming(timing: ActionCursorTiming | null): ActionCursorTiming | null {
  if (!timing) return null;
  const startMs = nonNegativeMs(timing.start_ms);
  const arrivalMs = Math.max(startMs, nonNegativeMs(timing.arrival_ms));
  const travelMs = Math.max(0, Math.min(nonNegativeMs(timing.travel_ms), arrivalMs - startMs));
  return {
    motion_preset: normalizeMotionPreset(timing.motion_preset) ?? "natural",
    start_ms: startMs,
    arrival_ms: arrivalMs,
    travel_ms: travelMs,
    dwell_ms: nonNegativeMs(timing.dwell_ms),
  };
}

function sanitizeInputTiming(timing: ActionInputTiming | null): ActionInputTiming | null {
  if (!timing) return null;
  const kind = normalizeInputKind(timing.kind);
  if (!kind) return null;
  const sanitized: ActionInputTiming = {
    kind,
    action_ms: nonNegativeMs(timing.action_ms),
  };
  if (timing.down_ms != null) sanitized.down_ms = nonNegativeMs(timing.down_ms);
  if (timing.up_ms != null) sanitized.up_ms = nonNegativeMs(timing.up_ms);
  if (timing.text_start_ms != null) {
    sanitized.text_start_ms = nonNegativeMs(timing.text_start_ms);
  }
  if (timing.text_end_ms != null) {
    sanitized.text_end_ms = nonNegativeMs(timing.text_end_ms);
  }
  return sanitized;
}

function normalizeInputKind(kind: string): ActionInputKind | null {
  switch (kind) {
    case "click":
    case "focus":
    case "hover":
    case "type":
    case "select":
    case "scroll":
    case "drag":
    case "upload":
      return kind;
    default:
      return null;
  }
}

function nonNegativeMs(value: number): number {
  return Math.max(0, Math.round(finiteNumber(value, 0)));
}

function clampMs(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function positiveDimension(value: number, fallback: number): number {
  const numeric = finiteNumber(value, fallback);
  const fallbackNumeric = finiteNumber(fallback, 1);
  return Math.max(1, Math.round(numeric > 0 ? numeric : fallbackNumeric));
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
