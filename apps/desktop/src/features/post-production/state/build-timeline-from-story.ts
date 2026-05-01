/**
 * Pure producer that turns a story + recording sidecars into initial timeline clips.
 */

import {
  calloutText,
  highlightEnabled,
  type StoryPolishDoc,
} from "@/features/editor/polish-sidecar";
import type { RecordingActions } from "@/ipc/actions";
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
import { XFADE_KINDS } from "../state/timeline-slice";
import type { EditorBackgroundKind, Rgba } from "./store";

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
}

type CaptureRect = { x: number; y: number; width: number; height: number };

const FALLBACK_DURATION_MS = 60_000;
const AUTO_ZOOM_PRE_ROLL_MS = 200;
const AUTO_ZOOM_DURATION_MS = 800;
const AUTO_ZOOM_DEBOUNCE_MS = 800;
const CALLOUT_DURATION_MS = 1_600;

const ZOOM_SCALE = {
  subtle: 1.18,
  standard: 1.35,
  strong: 1.65,
} as const;

const DEFAULT_BACKGROUND: EditorBackgroundKind = { kind: "transparent" };

function hashPath(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
  let lastEmittedClickMs = Number.NEGATIVE_INFINITY;
  for (const frame of trajectory.frames) {
    if (!frame.click) continue;
    if (frame.t_ms - lastEmittedClickMs < AUTO_ZOOM_DEBOUNCE_MS) continue;
    lastEmittedClickMs = frame.t_ms;
    zoom.push({
      id: `zoom-${idBase}-${frame.t_ms}`,
      trackId: "zoom",
      startMs: Math.max(0, frame.t_ms - AUTO_ZOOM_PRE_ROLL_MS),
      durationMs,
      label: "Auto zoom",
      target: { kind: "cursor" },
      scale,
      center: normalizeCenter(trajectory.capture_rect, frame.x, frame.y),
      preset: "CALM",
    });
  }
  return zoom;
}

function cursorSidecarFor(
  recordingPath: string,
  actions: RecordingActions | null,
  trajectory: RecordingTrajectory | null,
  durationMs: number,
): { path: string; fps: number; frameCount: number } | null {
  if (actions) {
    const fps = actions.fps > 0 ? actions.fps : 60;
    const durationFrameCount = Math.ceil((Math.max(0, durationMs) / 1000) * fps);
    return {
      path: deriveActionsPath(recordingPath),
      fps,
      frameCount: Math.max(actions.frame_count, durationFrameCount, 1),
    };
  }
  if (!trajectory) return null;
  return {
    path: deriveTrajectoryPath(recordingPath),
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
  return actions.fps > 0 ? Math.round((actions.frame_count / actions.fps) * 1000) : 0;
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
      };
    }),
  );
}

function estimatedStepTimeMs(index: number, total: number, durationMs: number): number {
  if (total <= 0) return 0;
  const slot = durationMs / Math.max(1, total);
  return Math.round(Math.min(durationMs, Math.max(0, slot * index + slot * 0.45)));
}

function centerFromTrajectoryAt(
  trajectory: RecordingTrajectory | null,
  tMs: number,
): { x: number; y: number } {
  if (!trajectory || trajectory.frames.length === 0) return { x: 0.5, y: 0.5 };
  const frames = trajectory.frames;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (frames[mid]?.t_ms == null || frames[mid].t_ms < tMs) lo = mid + 1;
    else hi = mid;
  }
  const next = frames[lo];
  const prev = lo > 0 ? frames[lo - 1] : null;
  const best = prev && next && Math.abs(prev.t_ms - tMs) <= Math.abs(next.t_ms - tMs) ? prev : next;
  return best ? normalizeCenter(trajectory.capture_rect, best.x, best.y) : { x: 0.5, y: 0.5 };
}

function centerFromTimingTarget(
  timing: RecordingStepTiming | null,
  rect: CaptureRect | null,
): { x: number; y: number } | null {
  const bbox = timing?.target?.bbox;
  if (!bbox || !rect || rect.width <= 0 || rect.height <= 0) return null;
  return normalizeCenter(rect, bbox.x + bbox.w / 2, bbox.y + bbox.h / 2);
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
  trajectory: RecordingTrajectory | null;
  actions: RecordingActions | null;
  stepTiming: RecordingStepTimingSidecar | null | undefined;
  durationMs: number;
  idBase: string;
}

function buildPolishClips({
  story,
  polish,
  trajectory,
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
  const rect = actions?.capture_rect ?? trajectory?.capture_rect ?? null;
  const zoom: ZoomClip[] = [];
  const annotations: AnnotationClip[] = [];
  const sound: SoundClip[] = [];

  steps.forEach((step, index) => {
    if (!step.stepId) return;
    const stepPolish = polish.steps[step.stepId];
    if (!stepPolish) return;
    const stepTime = timing.byStepId.get(step.stepId) ?? timing.byOrdinal.get(step.ordinal) ?? null;
    const tMs = stepTime
      ? Math.min(durationMs, Math.max(0, stepTime.startMs + Math.round(stepTime.durationMs * 0.45)))
      : estimatedStepTimeMs(index, steps.length, durationMs);
    const zoomLevel = stepPolish.zoom && stepPolish.zoom !== "off" ? stepPolish.zoom : null;
    const callout = calloutText(stepPolish.callout);
    const highlight = highlightEnabled(stepPolish.highlight);
    const needsTargetCenter = Boolean(zoomLevel || highlight);
    const center = needsTargetCenter
      ? (centerFromTimingTarget(stepTime, rect) ?? centerFromTrajectoryAt(trajectory, tMs))
      : { x: 0.5, y: 0.5 };
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
      zoom.push({
        id: `polish-zoom-${idBase}-${step.stepId}`,
        trackId: "zoom",
        startMs: Math.max(0, tMs - 250),
        durationMs: stepPolish.zoomDurationMs ?? 900,
        label: "Script zoom",
        target: zoomTarget,
        scale: stepPolish.zoomScale ?? ZOOM_SCALE[zoomLevel as keyof typeof ZOOM_SCALE],
        center,
        preset: polish.global.recipe === "calm" ? "CALM" : "DYNAMIC",
      });
    }
    const calloutSpec = typeof stepPolish.callout === "object" ? stepPolish.callout : null;
    const highlightSpec = typeof stepPolish.highlight === "object" ? stepPolish.highlight : null;
    if (callout || highlight) {
      annotations.push({
        id: `${callout ? "callout" : "highlight"}-${idBase}-${step.stepId}`,
        trackId: "annotations",
        startMs: Math.max(0, tMs - 100),
        durationMs: calloutSpec?.durationMs ?? highlightSpec?.durationMs ?? CALLOUT_DURATION_MS,
        label: callout ? "Callout" : "Highlight",
        text: callout,
        pos: calloutSpec?.pos ?? { x: 0.5, y: 0.86 },
        sizePt: calloutSpec?.sizePt ?? 24,
        color: calloutSpec?.color ?? "#ffffff",
        highlight: highlight
          ? {
              center,
              radiusPx: highlightSpec?.radiusPx ?? 56,
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

  const durationMs = mediaDurationMs(recording, trajectory, actions);

  const baseVideo: VideoClip[] = [
    {
      id: `video-${idBase}`,
      trackId: "video",
      startMs: 0,
      durationMs,
      sourcePath: recording.path,
      label: basename(recording.path),
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
      trajectoryFps: cursorSidecar.fps,
      trajectoryFrameCount: cursorSidecar.frameCount,
      skin: polish?.global.cursorSkin ?? "mac-default",
      sizeScale: polish?.global.cursorSizeScale ?? 1.0,
    });
  }

  const autoZoom =
    polish?.global.autoZoom === "off"
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
    trajectory,
    actions,
    stepTiming,
    durationMs,
    idBase,
  });
  const zoom = [...autoZoom, ...polishClips.zoom];
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
    annotations: polishClips.annotations,
    background: backgroundFromPolish(polish),
  };
}
