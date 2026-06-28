import fs from "node:fs/promises";
import path from "node:path";

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

export interface ActionTimelineEvent {
  step_id: string | null;
  ordinal: number;
  verb: string;
  t_start_ms: number;
  t_action_ms: number;
  t_end_ms: number;
  target: ActionTarget | null;
  secondary_target: ActionTarget | null;
  pointer: ActionPointer | null;
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
  viewport: { width: number; height: number };
  capture_rect: ActionCaptureRect;
  fps: number;
  frame_count: number;
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
}

export function actionsSidecarPath(recordingPath: string): string {
  return /\.[^/.]+$/.test(recordingPath)
    ? recordingPath.replace(/\.[^/.]+$/, ".actions.json")
    : `${recordingPath}.actions.json`;
}

export async function writeActionsSidecarAtomic(
  file: string,
  dto: RecordingActions,
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(file)}.tmp.${process.pid}.${Date.now()}`,
  );
  try {
    await fs.writeFile(tempPath, JSON.stringify(dto, null, 2), "utf8");
    await fs.rename(tempPath, file);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
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
  return verb === "click" ? { button: "left", effect: "click" } : null;
}

export function actionTimelineEventFromStep(
  input: ActionTimelineEventInput,
): ActionTimelineEvent {
  const tStart = nonNegativeMs(input.stepStartedAtMs);
  const tEnd = Math.max(tStart, nonNegativeMs(input.stepEndedAtMs));
  const tAction = clampMs(nonNegativeMs(input.actionAtMs), tStart, tEnd);
  const verb = String(input.command.verb || "unknown");

  return {
    step_id:
      typeof input.command.step_id === "string" &&
      input.command.step_id.length > 0
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
  };
}

export function recordingActionsFromSession(
  session: ActionTimelineRecordingSession,
  events: ActionTimelineEvent[],
): RecordingActions {
  return {
    version: 1,
    recording_path: session.outputPath,
    viewport: {
      width: positiveDimension(session.width, session.outputWidth),
      height: positiveDimension(session.height, session.outputHeight),
    },
    capture_rect: deriveActionCaptureRect(session),
    fps: positiveDimension(session.fps, 30),
    frame_count: Math.max(0, Math.round(finiteNumber(session.frameSeq, 0))),
    events,
  };
}

function sanitizeActionTarget(
  target: ActionTarget | null,
): ActionTarget | null {
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
