/**
 * Pure producer that turns a story + recording sidecars into initial timeline clips.
 */

import {
  calloutText,
  DEFAULT_AUTO_ZOOM_DURATION_MS,
  highlightEnabled,
  type StoryPolishDoc,
} from "@/features/editor/polish-sidecar";
import { type ActionTarget, actionSidecarFps, type RecordingActions } from "@/ipc/actions";
import type { ParseResult } from "@/ipc/parse";
import type { RecordingInfo } from "@/ipc/projects";
import type {
  RecordingStepTiming,
  RecordingStepTimingSidecar,
  RecordingTrajectory,
} from "@/ipc/trajectory";
import type {
  AnnotationClip,
  CursorClip,
  SoundClip,
  VideoClip,
  XfadeKind,
  ZoomClip,
} from "../state/timeline-slice";
import { normalizeCursorMotionPreset, XFADE_KINDS } from "../state/timeline-slice";
import { NEW_CURSOR_CLICK_EFFECT } from "./cursor-click-effect";
import { identitySourceTimelineMap } from "./source-timeline-map";
import type { EditorBackgroundKind, Rgba } from "./store";
import { styleDefaults } from "./text-style";
import { buildVirtualCursorSchedule } from "./virtual-cursor-scheduler";

export interface BuildTimelineInput {
  story: ParseResult | null;
  recording: RecordingInfo;
  trajectory: RecordingTrajectory | null;
  actions?: RecordingActions | null;
  polish?: StoryPolishDoc | null;
  stepTiming?: RecordingStepTimingSidecar | null;
}

export interface BuildTimelineOutput {
  video: VideoClip[];
  cursor: CursorClip[];
  zoom: ZoomClip[];
  sound: SoundClip[];
  annotations: AnnotationClip[];
  background: EditorBackgroundKind;
  warnings: BuildTimelineWarning[];
}

export type BuildTimelineWarningCode = "missing-text-overlay-timing" | "text-overlay-outside-media";

export interface BuildTimelineWarning {
  code: BuildTimelineWarningCode;
  stepId: string | null;
  ordinal: number;
  message: string;
}

export function mergeIndependentAnnotations(
  generated: readonly AnnotationClip[],
  saved: readonly AnnotationClip[],
): AnnotationClip[] {
  return [...generated, ...saved.filter((clip) => !clip.syncGroupId)];
}

type CaptureRect = { x: number; y: number; width: number; height: number };
type NormalizedBounds = { x: number; y: number; w: number; h: number };

const FALLBACK_DURATION_MS = 60_000;
const AUTO_ZOOM_PRE_ROLL_MS = 300;
const AUTO_ZOOM_DURATION_MS = DEFAULT_AUTO_ZOOM_DURATION_MS;
const CALLOUT_DURATION_MS = 1_600;

const ZOOM_SCALE = {
  subtle: 1.15,
  standard: 1.28,
  strong: 1.5,
} as const;

const ACTION_FOCUS_HIGHLIGHT = {
  subtle: {
    radiusPx: 36,
    color: "#ffffff",
    durationMs: 520,
    shape: "ring",
    paddingPx: 6,
    strokePx: 2,
    glowPx: 8,
    opacity: 0.66,
  },
  standard: {
    radiusPx: 56,
    color: "#ffffff",
    durationMs: 700,
    shape: "ring",
    paddingPx: 8,
    strokePx: 2,
    glowPx: 16,
    opacity: 0.72,
  },
  strong: {
    radiusPx: 72,
    color: "#ffffff",
    durationMs: 840,
    shape: "spotlight",
    paddingPx: 10,
    strokePx: 3,
    glowPx: 22,
    opacity: 0.86,
  },
} as const;

function positiveDimension(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function sourceSize(input: BuildTimelineInput): VideoClip["sourceSize"] {
  const recordingWidth = positiveDimension(input.recording.width);
  const recordingHeight = positiveDimension(input.recording.height);
  if (recordingWidth && recordingHeight) {
    return { width: recordingWidth, height: recordingHeight };
  }

  const rect =
    input.actions?.capture_rect ??
    input.trajectory?.capture_rect ??
    input.stepTiming?.captureRect ??
    null;
  const width = positiveDimension(rect?.width);
  const height = positiveDimension(rect?.height);
  return width && height ? { width, height } : undefined;
}

const DEFAULT_BACKGROUND: EditorBackgroundKind = { kind: "transparent" };

function hashPath(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function recordingSourceRevision(recording: RecordingInfo): string {
  return hashPath(
    `${recording.path}\0${recording.captured_at}\0${recording.duration_ms ?? ""}\0${recording.width ?? ""}x${recording.height ?? ""}`,
  );
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function deriveTrajectoryPath(recordingPath: string): string {
  return recordingPath.replace(/\.mp4$/i, ".trajectory.json");
}

function deriveActionsPath(recordingPath: string): string {
  return recordingPath.replace(/\.mp4$/i, ".actions.json");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function hexToRgba(hex: string): Rgba {
  const clean = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return { r: 16, g: 18, b: 24, a: 255 };
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
    a: 255,
  };
}

function backgroundFromPolish(polish?: StoryPolishDoc | null): EditorBackgroundKind {
  const background = polish?.global.background;
  if (!background) return DEFAULT_BACKGROUND;
  switch (background.kind) {
    case "transparent":
      return { kind: "transparent" };
    case "solid":
      return { kind: "solid", color: hexToRgba(background.color) };
    case "gradient":
      return { kind: "gradient", preset_id: background.presetId };
  }
}

function normalizeCenter(rect: CaptureRect, x: number, y: number): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
  return {
    x: clamp01((x - rect.x) / rect.width),
    y: clamp01((y - rect.y) / rect.height),
  };
}

function normalizeBounds(
  rect: CaptureRect,
  bounds: { x: number; y: number; w: number; h: number } | null | undefined,
): NormalizedBounds | undefined {
  if (!bounds || rect.width <= 0 || rect.height <= 0 || bounds.w <= 0 || bounds.h <= 0) {
    return undefined;
  }
  const x1 = clamp01((bounds.x - rect.x) / rect.width);
  const y1 = clamp01((bounds.y - rect.y) / rect.height);
  const x2 = clamp01((bounds.x + bounds.w - rect.x) / rect.width);
  const y2 = clamp01((bounds.y + bounds.h - rect.y) / rect.height);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return undefined;
  return { x: x1, y: y1, w, h };
}

function buildAutoZoomClips(
  trajectory: RecordingTrajectory | null,
  actions: RecordingActions | null,
  idBase: string,
  mode: keyof typeof ZOOM_SCALE,
  durationMs = AUTO_ZOOM_DURATION_MS,
): ZoomClip[] {
  const scale = ZOOM_SCALE[mode];
  if (actions) {
    return actions.events
      .filter(
        (event) => event.target && (event.verb === "click" || event.pointer?.effect === "click"),
      )
      .map((event) => ({
        id: `zoom-${idBase}-${event.t_action_ms}`,
        trackId: "zoom" as const,
        startMs: Math.max(0, event.t_action_ms - AUTO_ZOOM_PRE_ROLL_MS),
        durationMs,
        label: "Auto zoom",
        target: { kind: "cursor" as const },
        origin: "auto" as const,
        scale,
        center: normalizeCenter(
          actions.capture_rect,
          event.target?.center.x ?? 0.5,
          event.target?.center.y ?? 0.5,
        ),
        preset: "CALM" as const,
      }));
  }
  if (!trajectory) return [];

  const zoom: ZoomClip[] = [];
  for (const frame of trajectory.frames) {
    if (!frame.click) continue;
    zoom.push({
      id: `zoom-${idBase}-${frame.t_ms}`,
      trackId: "zoom",
      startMs: Math.max(0, frame.t_ms - AUTO_ZOOM_PRE_ROLL_MS),
      durationMs,
      label: "Auto zoom",
      target: { kind: "cursor" },
      origin: "auto",
      scale,
      center: normalizeCenter(trajectory.capture_rect, frame.x, frame.y),
      preset: "CALM",
    });
  }
  return zoom;
}

function buildActionFocusAnnotations(
  actions: RecordingActions | null,
  idBase: string,
  mode: keyof typeof ACTION_FOCUS_HIGHLIGHT,
  excludeStepIds: ReadonlySet<string>,
): AnnotationClip[] {
  if (!actions) return [];
  const recipe = ACTION_FOCUS_HIGHLIGHT[mode];
  return actions.events
    .filter(
      (event) => event.target && (event.verb === "click" || event.pointer?.effect === "click"),
    )
    .filter((event) => !event.step_id || !excludeStepIds.has(event.step_id))
    .filter((event) => normalizeBounds(actions.capture_rect, event.target?.bounds))
    .map((event) => {
      const center = normalizeCenter(
        actions.capture_rect,
        event.target?.center.x ?? 0.5,
        event.target?.center.y ?? 0.5,
      );
      const bounds = normalizeBounds(actions.capture_rect, event.target?.bounds);
      const stepId = event.step_id ?? `action-${event.ordinal}`;
      return {
        id: `action-focus-${idBase}-${stepId}-${event.t_action_ms}`,
        trackId: "annotations" as const,
        startMs: Math.max(0, event.t_action_ms - 60),
        durationMs: recipe.durationMs,
        label: "Action focus",
        text: "",
        pos: center,
        sizePt: 18,
        color: recipe.color,
        anchor: event.step_id
          ? ({ kind: "target", stepId: event.step_id, placement: "top" } as const)
          : ({ kind: "screen", pos: center } as const),
        highlight: {
          center,
          radiusPx: recipe.radiusPx,
          bounds,
          shape: recipe.shape,
          paddingPx: recipe.paddingPx,
          strokePx: recipe.strokePx,
          glowPx: recipe.glowPx,
          opacity: recipe.opacity,
          color: recipe.color,
          durationMs: recipe.durationMs,
        },
      };
    });
}

function cursorSidecarFor(
  recordingPath: string,
  actions: RecordingActions | null,
  trajectory: RecordingTrajectory | null,
  durationMs: number,
): { path: string; kind: "actions" | "trajectory"; fps: number; frameCount: number } | null {
  if (actions) {
    const fps = actionSidecarFps(actions);
    const durationFrameCount = Math.ceil((Math.max(0, durationMs) / 1000) * fps);
    return {
      path: deriveActionsPath(recordingPath),
      kind: "actions",
      fps,
      frameCount: Math.max(actions.frame_count, durationFrameCount, 1),
    };
  }
  if (!trajectory) return null;
  return {
    path: deriveTrajectoryPath(recordingPath),
    kind: "trajectory",
    fps: trajectory.fps,
    frameCount: trajectory.frame_count,
  };
}

function trajectoryDurationMs(trajectory: RecordingTrajectory | null): number {
  if (!trajectory) return 0;
  const finalFrameMs = trajectory.frames.at(-1)?.t_ms ?? 0;
  if (finalFrameMs > 0) return finalFrameMs;
  return trajectory.fps > 0 ? Math.round((trajectory.frame_count / trajectory.fps) * 1000) : 0;
}

function actionsDurationMs(actions: RecordingActions | null): number {
  if (!actions) return 0;
  let eventMaxEndMs = 0;
  for (const event of actions.events) {
    eventMaxEndMs = Math.max(eventMaxEndMs, event.t_end_ms);
  }
  if (eventMaxEndMs > 0) return eventMaxEndMs;
  const fps = actionSidecarFps(actions);
  return fps > 0 ? Math.round((actions.frame_count / fps) * 1000) : 0;
}

function mediaDurationMs(
  recording: RecordingInfo,
  trajectory: RecordingTrajectory | null,
  actions: RecordingActions | null,
): number {
  const recordingDurationMs = recording.duration_ms ?? 0;
  if (recordingDurationMs > 0) return recordingDurationMs;
  const trajectoryMs = trajectoryDurationMs(trajectory);
  if (trajectoryMs > 0) return trajectoryMs;
  const actionMs = actionsDurationMs(actions);
  if (actionMs > 0) return actionMs;
  return FALLBACK_DURATION_MS;
}

function flattenStorySteps(story: ParseResult | null): Array<{
  sceneName: string;
  stepId: string | null;
  ordinal: number;
  verb: string;
  text: string | null;
  durationMs: number | null;
}> {
  const scenes = story?.ast?.scenes ?? [];
  let ordinal = 0;
  return scenes.flatMap((scene) =>
    scene.commands.map((command) => {
      ordinal += 1;
      return {
        sceneName: scene.name,
        stepId: command.step_id ?? null,
        ordinal,
        verb: command.verb,
        text: command.verb === "text-overlay" ? command.text : null,
        durationMs: command.verb === "text-overlay" ? command.duration_ms : null,
      };
    }),
  );
}

function centerFromTimingTarget(
  timing: RecordingStepTiming | null,
  rect: CaptureRect | null,
): { x: number; y: number } | null {
  const bbox = timing?.target?.bbox;
  if (!bbox || !rect || rect.width <= 0 || rect.height <= 0) return null;
  return normalizeCenter(rect, bbox.x + bbox.w / 2, bbox.y + bbox.h / 2);
}

function boundsFromTimingTarget(
  timing: RecordingStepTiming | null,
  rect: CaptureRect | null,
): NormalizedBounds | undefined {
  return normalizeBounds(rect ?? { x: 0, y: 0, width: 0, height: 0 }, timing?.target?.bbox);
}

function actionTargetForStep(
  actions: RecordingActions | null,
  stepId: string,
  ordinal: number,
): ActionTarget | null {
  return actionEventForStep(actions, stepId, ordinal)?.target ?? null;
}

function actionEventForStep(
  actions: RecordingActions | null,
  stepId: string,
  ordinal: number,
): RecordingActions["events"][number] | null {
  if (!actions) return null;
  return (
    actions.events.find(
      (item) => (stepId && item.step_id === stepId) || (!item.step_id && item.ordinal === ordinal),
    ) ?? null
  );
}

function centerFromActionTarget(
  actions: RecordingActions | null,
  stepId: string,
  ordinal: number,
): { x: number; y: number } | null {
  if (!actions) return null;
  const target = actionTargetForStep(actions, stepId, ordinal);
  return target ? normalizeCenter(actions.capture_rect, target.center.x, target.center.y) : null;
}

function boundsFromActionTarget(
  actions: RecordingActions | null,
  stepId: string,
  ordinal: number,
): NormalizedBounds | undefined {
  if (!actions) return undefined;
  return normalizeBounds(
    actions.capture_rect,
    actionTargetForStep(actions, stepId, ordinal)?.bounds,
  );
}

function stepTimingLookup(sidecar: RecordingStepTimingSidecar | null | undefined): {
  byStepId: Map<string, RecordingStepTiming>;
  byOrdinal: Map<number, RecordingStepTiming>;
} {
  const byStepId = new Map<string, RecordingStepTiming>();
  const byOrdinal = new Map<number, RecordingStepTiming>();
  for (const step of sidecar?.steps ?? []) {
    if (step.stepId) byStepId.set(step.stepId, step);
    byOrdinal.set(step.ordinal, step);
  }
  return { byStepId, byOrdinal };
}

function stepSceneEndMs(
  sidecar: RecordingStepTimingSidecar | null | undefined,
  stepTime: RecordingStepTiming | null,
  durationMs: number,
): number {
  if (!sidecar || !stepTime) return durationMs;
  const nextSceneStep = sidecar.steps
    .filter((step) => step.startMs > stepTime.startMs && step.sceneName !== stepTime.sceneName)
    .sort((a, b) => a.startMs - b.startMs)[0];
  return Math.min(durationMs, nextSceneStep?.startMs ?? durationMs);
}

function clampClipDuration(
  startMs: number,
  requestedDurationMs: number,
  endBoundaryMs: number,
): number {
  return Math.max(1, Math.min(requestedDurationMs, Math.max(1, endBoundaryMs - startMs)));
}

interface BuildTextOverlayClipsContext {
  story: ParseResult | null;
  stepTiming: RecordingStepTimingSidecar | null | undefined;
  mediaEndMs: number;
  idBase: string;
  syncGroupId: string;
  sourceRevision: string;
  sourceTimeMap: AnnotationClip["sourceTimeMap"];
}

function buildTextOverlayClips({
  story,
  stepTiming,
  mediaEndMs,
  idBase,
  syncGroupId,
  sourceRevision,
  sourceTimeMap,
}: BuildTextOverlayClipsContext): {
  annotations: AnnotationClip[];
  warnings: BuildTimelineWarning[];
} {
  const timing = stepTimingLookup(stepTiming);
  const annotations: AnnotationClip[] = [];
  const warnings: BuildTimelineWarning[] = [];

  for (const step of flattenStorySteps(story)) {
    if (step.verb !== "text-overlay" || step.text == null || step.durationMs == null) continue;
    const stepTime =
      (step.stepId ? timing.byStepId.get(step.stepId) : undefined) ??
      timing.byOrdinal.get(step.ordinal) ??
      null;
    const stepLabel = step.stepId ? `step ${step.stepId}` : `step ${step.ordinal}`;
    if (!stepTime) {
      warnings.push({
        code: "missing-text-overlay-timing",
        stepId: step.stepId,
        ordinal: step.ordinal,
        message: `Text overlay at ${stepLabel} has no recorded timing and was skipped.`,
      });
      continue;
    }

    const startMs = stepTime.startMs;
    const durationMs = Math.min(step.durationMs, mediaEndMs - startMs);
    if (startMs < 0 || startMs >= mediaEndMs || durationMs <= 0) {
      warnings.push({
        code: "text-overlay-outside-media",
        stepId: step.stepId,
        ordinal: step.ordinal,
        message: `Text overlay at ${stepLabel} starts outside the recorded media and was skipped.`,
      });
      continue;
    }

    const defaults = styleDefaults("caption");
    annotations.push({
      id: `text-overlay-${idBase}-${step.stepId || `ordinal-${step.ordinal}`}`,
      trackId: "annotations",
      startMs,
      durationMs,
      label: "Text overlay",
      ...defaults,
      text: step.text,
      syncGroupId,
      sourceRevision,
      sourceTimeMap,
    });
  }

  return { annotations, warnings };
}

function fallbackPolishStepTimeMs(
  polishedSteps: Array<{ stepId: string | null }>,
  stepId: string,
  durationMs: number,
): number | null {
  const index = polishedSteps.findIndex((step) => step.stepId === stepId);
  if (index < 0 || polishedSteps.length === 0) return null;
  const safeStartMs = Math.min(300, Math.max(0, durationMs - 1));
  const safeEndMs = Math.max(safeStartMs + 1, durationMs - 500);
  return Math.round(
    safeStartMs + ((index + 0.5) / polishedSteps.length) * (safeEndMs - safeStartMs),
  );
}

function isInteractionVerb(verb: string | null | undefined): boolean {
  return verb === "click" || verb === "type";
}

function transitionKind(kind: string | undefined): XfadeKind | null {
  if (!kind || kind === "none") return null;
  return XFADE_KINDS.includes(kind as XfadeKind) ? (kind as XfadeKind) : null;
}

function applySceneTransitionIntent(
  video: VideoClip[],
  story: ParseResult | null,
  polish?: StoryPolishDoc | null,
): VideoClip[] {
  if (!polish || video.length === 0) return video;
  const scenes = story?.ast?.scenes ?? [];
  const firstTransitionScene = scenes.find((scene) =>
    transitionKind(polish.scenes[scene.name]?.transitionOut),
  );
  if (!firstTransitionScene) return video;
  const scenePolish = polish.scenes[firstTransitionScene.name];
  const firstTransition = transitionKind(scenePolish?.transitionOut);
  if (!firstTransition) return video;
  return video.map((clip, index) =>
    index === 0
      ? {
          ...clip,
          outgoingTransition: {
            kind: firstTransition,
            durationMs: scenePolish?.transitionDurationMs ?? 500,
          },
        }
      : clip,
  );
}

interface BuildPolishClipsContext {
  story: ParseResult | null;
  polish: StoryPolishDoc | null | undefined;
  captureRect: CaptureRect | null;
  actions: RecordingActions | null;
  stepTiming: RecordingStepTimingSidecar | null | undefined;
  durationMs: number;
  idBase: string;
}

function buildPolishClips({
  story,
  polish,
  captureRect,
  actions,
  stepTiming,
  durationMs,
  idBase,
}: BuildPolishClipsContext): {
  zoom: ZoomClip[];
  annotations: AnnotationClip[];
  sound: SoundClip[];
} {
  if (!polish) return { zoom: [], annotations: [], sound: [] };
  const steps = flattenStorySteps(story);
  const timing = stepTimingLookup(stepTiming);
  const stepRect = stepTiming?.captureRect ?? captureRect;
  const zoom: ZoomClip[] = [];
  const annotations: AnnotationClip[] = [];
  const sound: SoundClip[] = [];
  const polishedSteps = steps.filter((step) => step.stepId && polish.steps[step.stepId]);

  steps.forEach((step) => {
    if (!step.stepId) return;
    const stepPolish = polish.steps[step.stepId];
    if (!stepPolish) return;
    const callout = calloutText(stepPolish.callout);
    const stepTime = timing.byStepId.get(step.stepId) ?? timing.byOrdinal.get(step.ordinal) ?? null;
    const actionEvent = actionEventForStep(actions, step.stepId, step.ordinal);
    const interactionStep = isInteractionVerb(stepTime?.verb ?? actionEvent?.verb ?? step.verb);
    const actionTimeMs =
      interactionStep && actionEvent
        ? Math.min(durationMs, Math.max(0, actionEvent.t_action_ms))
        : null;
    const fallbackTimeMs = callout
      ? fallbackPolishStepTimeMs(polishedSteps, step.stepId, durationMs)
      : null;
    const tMs = stepTime
      ? Math.min(durationMs, Math.max(0, stepTime.startMs + Math.round(stepTime.durationMs * 0.45)))
      : (actionTimeMs ?? fallbackTimeMs);
    if (tMs == null) return;
    const sceneEndMs = stepSceneEndMs(stepTiming, stepTime, durationMs);
    const zoomLevel = stepPolish.zoom && stepPolish.zoom !== "off" ? stepPolish.zoom : null;
    const highlight = highlightEnabled(stepPolish.highlight);
    const actionCenter = interactionStep
      ? centerFromActionTarget(actions, step.stepId, step.ordinal)
      : null;
    const timingCenter = centerFromTimingTarget(stepTime, stepRect);
    const center = actionCenter ?? timingCenter;
    const actionBounds = interactionStep
      ? boundsFromActionTarget(actions, step.stepId, step.ordinal)
      : undefined;
    const targetBounds = highlight
      ? (actionBounds ?? boundsFromTimingTarget(stepTime, stepRect))
      : undefined;
    if (zoomLevel && zoomLevel in ZOOM_SCALE) {
      const zoomTarget = (() => {
        switch (stepPolish.zoomTarget?.kind) {
          case "element":
            return { kind: "element" as const, selector: stepPolish.zoomTarget.selector };
          case "fixed-region":
            return {
              kind: "fixed-region" as const,
              top_left: stepPolish.zoomTarget.topLeft,
              size: stepPolish.zoomTarget.size,
            };
          default:
            return { kind: "cursor" as const };
        }
      })();
      if (zoomTarget.kind === "fixed-region" || center) {
        const zoomStartMs = Math.max(0, tMs - 250);
        zoom.push({
          id: `polish-zoom-${idBase}-${step.stepId}`,
          trackId: "zoom",
          startMs: zoomStartMs,
          durationMs: clampClipDuration(zoomStartMs, stepPolish.zoomDurationMs ?? 900, sceneEndMs),
          label: "Script zoom",
          target: zoomTarget,
          origin: "authored",
          scale: stepPolish.zoomScale ?? ZOOM_SCALE[zoomLevel as keyof typeof ZOOM_SCALE],
          center: center ?? { x: 0.5, y: 0.5 },
          preset: polish.global.recipe === "calm" ? "CALM" : "DYNAMIC",
        });
      }
    }
    const calloutSpec = typeof stepPolish.callout === "object" ? stepPolish.callout : null;
    const highlightSpec = typeof stepPolish.highlight === "object" ? stepPolish.highlight : null;
    const highlightClip = highlight && center && targetBounds;
    if (callout || highlightClip) {
      const defaults = styleDefaults(callout ? "callout" : "hotspot");
      const annotationStartMs = Math.max(0, tMs - 100);
      const requestedDurationMs =
        calloutSpec?.durationMs ?? highlightSpec?.durationMs ?? CALLOUT_DURATION_MS;
      annotations.push({
        id: `${callout ? "callout" : "highlight"}-${idBase}-${step.stepId}`,
        trackId: "annotations",
        startMs: annotationStartMs,
        durationMs: clampClipDuration(annotationStartMs, requestedDurationMs, sceneEndMs),
        label: callout ? "Callout" : "Highlight",
        ...defaults,
        text: callout,
        pos: calloutSpec?.pos ?? defaults.pos,
        sizePt: calloutSpec?.sizePt ?? defaults.sizePt,
        color: calloutSpec?.color ?? defaults.color,
        anchor: center
          ? ({ kind: "target", stepId: step.stepId, placement: "top" } as const)
          : ({ kind: "screen", pos: calloutSpec?.pos ?? defaults.pos } as const),
        highlight: highlightClip
          ? {
              center,
              radiusPx: highlightSpec?.radiusPx ?? 32,
              bounds: targetBounds,
              shape: "ring",
              paddingPx: 6,
              strokePx: 2,
              glowPx: 10,
              opacity: 0.66,
              color: highlightSpec?.color ?? "#ffffff",
              durationMs: highlightSpec?.durationMs ?? 700,
            }
          : undefined,
      });
    }
    if (stepPolish.sfx?.path.trim()) {
      sound.push({
        id: `sfx-${idBase}-${step.stepId}`,
        trackId: "sound",
        startMs: Math.max(0, tMs),
        durationMs: stepPolish.sfx.durationMs ?? 1_000,
        path: stepPolish.sfx.path,
        kind: "sfx",
        label: stepPolish.sfx.label ?? "Step SFX",
        gain: stepPolish.sfx.gain ?? 1,
      });
    }
  });

  return { zoom, annotations, sound };
}

export function buildTimelineFromStory(input: BuildTimelineInput): BuildTimelineOutput {
  const { recording, trajectory, polish, stepTiming } = input;
  const actions = input.actions ?? null;
  const idBase = hashPath(recording.path);
  const syncGroupId = `recording-${idBase}`;
  const sourceRevision = recordingSourceRevision(recording);

  const cursorMotionPreset = normalizeCursorMotionPreset(actions?.cursor_motion_preset);
  const cursorVisible = polish?.global.cursor !== "hidden";
  const cursorSchedule = cursorVisible
    ? buildVirtualCursorSchedule(actions, cursorMotionPreset)
    : null;
  const mediaEndMs = mediaDurationMs(recording, trajectory, actions);
  const durationMs = Math.max(mediaEndMs, cursorSchedule?.durationMs ?? 0);
  const source = sourceSize(input);
  const sourceTimeMap = identitySourceTimelineMap(durationMs);

  const baseVideo: VideoClip[] = [
    {
      id: `video-${idBase}`,
      trackId: "video",
      startMs: 0,
      durationMs,
      sourcePath: recording.path,
      sourceSize: source,
      label: basename(recording.path),
      syncGroupId,
      sourceRevision,
      sourceTimeMap,
    },
  ];
  const video = applySceneTransitionIntent(baseVideo, input.story, polish);

  const cursor: CursorClip[] = [];
  const cursorSidecar = cursorSidecarFor(recording.path, actions, trajectory, durationMs);
  if (cursorSidecar && polish?.global.cursor !== "hidden") {
    cursor.push({
      id: `cursor-${idBase}`,
      trackId: "cursor",
      startMs: 0,
      durationMs,
      trajectoryDir: cursorSidecar.path,
      trajectoryKind: cursorSidecar.kind,
      trajectoryFps: cursorSidecar.fps,
      trajectoryFrameCount: cursorSidecar.frameCount,
      skin: polish?.global.cursorSkin ?? "mac-default",
      motionPreset: cursorMotionPreset,
      clickEffect: { ...NEW_CURSOR_CLICK_EFFECT },
      preserveFullMotion: false,
      sizeScale: polish?.global.cursorSizeScale ?? 1.0,
      syncGroupId,
      sourceRevision,
      sourceTimeMap,
    });
  }

  const reducedMotion = polish?.global.motionMode === "reduced";
  const autoZoom =
    reducedMotion || polish?.global.autoZoom === "off"
      ? []
      : buildAutoZoomClips(
          trajectory,
          actions,
          idBase,
          polish?.global.autoZoom ?? "standard",
          polish?.global.autoZoomDurationMs ?? AUTO_ZOOM_DURATION_MS,
        );
  const polishClips = buildPolishClips({
    story: input.story,
    polish,
    captureRect: actions?.capture_rect ?? trajectory?.capture_rect ?? null,
    actions,
    stepTiming,
    durationMs,
    idBase,
  });
  const textOverlayClips = buildTextOverlayClips({
    story: input.story,
    stepTiming,
    mediaEndMs,
    idBase,
    syncGroupId,
    sourceRevision,
    sourceTimeMap,
  });
  const zoom = [
    ...autoZoom.map((clip) => ({ ...clip, syncGroupId, sourceRevision, sourceTimeMap })),
    ...polishClips.zoom,
  ];
  const actionFocusMode = reducedMotion
    ? polish?.global.actionFocus === "off"
      ? "standard"
      : (polish?.global.actionFocus ?? "standard")
    : (polish?.global.actionFocus ?? "off");
  const actionFocusAnnotations =
    actionFocusMode === "off"
      ? []
      : buildActionFocusAnnotations(
          actions,
          idBase,
          actionFocusMode,
          new Set(
            polishClips.annotations
              .map((clip) =>
                clip.highlight && clip.anchor?.kind === "target" ? clip.anchor.stepId : null,
              )
              .filter((stepId): stepId is string => Boolean(stepId)),
          ),
        );
  const sound: SoundClip[] = [];
  if (polish?.global.bgm?.path.trim()) {
    sound.push({
      id: `bgm-${idBase}`,
      trackId: "sound",
      startMs: 0,
      durationMs,
      path: polish.global.bgm.path,
      kind: "bgm",
      label: polish.global.bgm.label ?? "Background music",
      gain: polish.global.bgm.gain ?? 0.35,
    });
  }
  sound.push(...polishClips.sound);

  return {
    video,
    cursor,
    zoom,
    sound,
    annotations: [
      ...actionFocusAnnotations.map((clip) => ({
        ...clip,
        syncGroupId,
        sourceRevision,
        sourceTimeMap,
      })),
      ...polishClips.annotations,
      ...textOverlayClips.annotations,
    ],
    background: backgroundFromPolish(polish),
    warnings: textOverlayClips.warnings,
  };
}
