/**
 * computeGraph — pure projection from the timeline editor store into the
 * export graph shape that the Electron export pipeline consumes.
 *
 * The JSON-safe composition contract lives in `@storycapture/shared-types`. The
 * generated effects surface still uses bigint timestamps and is intentionally
 * not used at this serialization boundary.
 *
 * Determinism: NodeId UUIDs are derived from a stable hash of the clip id,
 * so calling `computeGraph` twice with the same store produces JSON.stringify
 * output that compares byte-for-byte equal. This is required by the
 * Plan 02-13b verification path.
 *
 * Canonical stage ordering (enforced by the effects builder):
 *   Source → ZoomPan → Background → Cursor → Ripple → Text → Transition → AudioMix
 *
 * As of Phase 19-01, clip variants are typed at the source — there is no
 * `metadata` bag to read from. Field access here is direct.
 */

import {
  EXPORT_COMPOSITION_SCHEMA_VERSION,
  type ExportAudioNode,
  type ExportCompositionGraphV5,
  type ExportEasingKind,
  type ExportHighlightOverlaySpec,
  type ExportIssue,
  type ExportRgba,
  type ExportTextBox,
  type ExportTextFontChoice,
  type ExportTextShadow,
  type ExportTrajectoryRef,
  type ExportVideoNode,
  type ExportZoomKeyframe,
} from "@storycapture/shared-types";
import type { RecordingActions } from "../../../ipc/actions";
import type { ExportResolution } from "../../../ipc/export";
import type { CaptureRect, RecordingStepTimingSidecar } from "../../../ipc/trajectory";
import { normalizeCursorClickEffect } from "./cursor-click-effect";
import type { ExportFormState } from "./export-slice";
import { type EditorBackgroundKind, readEditorBackground } from "./store";
import { resolveTextAnchorPosition } from "./text-anchor";
import { effectiveTextFontChoice, hexToRgbaWithAlpha, resolvedTextStyle } from "./text-style";
import type {
  AnnotationClip,
  Clip,
  CursorClip,
  CursorSkin,
  SoundClip,
  TimelineSlice,
  TrackId,
  Vec2,
  VideoClip,
  XfadeKind,
  ZoomClip,
  ZoomTarget,
} from "./timeline-slice";
import { normalizeCursorMotionPreset } from "./timeline-slice";
import {
  applyZoomToBounds,
  applyZoomToPoint,
  normalizedZoomCenterToPixels,
  resolveZoomMotion,
  sampleResolvedZoom,
  type ZoomSample,
} from "./zoom-motion";

/**
 * Minimal slice of the editor store that `computeGraph` reads. Narrowing
 * the input lets callers subscribe to just these fields and avoids
 * spurious re-renders when unrelated slices (selection, panels, queue)
 * change.
 */
export interface ComputeGraphInput {
  tracks: TimelineSlice["tracks"];
  exportForm: ExportFormState;
  _undoExtras?: {
    background?: EditorBackgroundKind;
    actions?: RecordingActions | null;
    stepTiming?: RecordingStepTimingSidecar | null;
    captureRect?: CaptureRect | null;
  };
}

export type { CursorSkin, Vec2, XfadeKind, ZoomTarget };
export type Rgba = ExportRgba;
export type EasingKind = ExportEasingKind;
export type ZoomKeyframe = ExportZoomKeyframe;
export type TrajectoryRef = ExportTrajectoryRef;
export type FontChoice = ExportTextFontChoice;
export type TextShadow = ExportTextShadow;
export type TextBox = ExportTextBox;
export type HighlightOverlaySpec = ExportHighlightOverlaySpec;
export type VideoNode = ExportVideoNode;
export type AudioNode = ExportAudioNode;
export type Graph = ExportCompositionGraphV5;

// ---------------------------------------------------------------------------
// Determinism helpers
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = EXPORT_COMPOSITION_SCHEMA_VERSION;

const RESOLUTION_PX: Record<ExportResolution, { w: number; h: number }> = {
  "match-source": { w: 1920, h: 1080 },
  "720p": { w: 1280, h: 720 },
  "1080p": { w: 1920, h: 1080 },
  "4k": { w: 3840, h: 2160 },
  custom: { w: 1920, h: 1080 },
};

/**
 * Deterministic UUID-shaped string derived from a clip id + role. Same
 * input ⇒ same output. We don't need cryptographic strength — Rust accepts
 * any well-formed UUID and only uses it as identity / label seed.
 */
function deterministicNodeId(clipId: string, role: string): string {
  const seed = `${role}:${clipId}`;
  // FNV-1a 32-bit, then expanded to 128 bits by xor-shifting.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Stretch the 32-bit hash deterministically into 16 bytes.
  const bytes: number[] = [];
  let acc = h >>> 0;
  for (let i = 0; i < 16; i++) {
    acc = Math.imul(acc ^ (acc >>> 15), 0x85ebca6b) >>> 0;
    bytes.push(acc & 0xff);
  }
  // Force RFC 4122 v4 / variant bits so the string is a valid UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Per-track projections — typed direct access, no metadata bag.
// ---------------------------------------------------------------------------

function safeTimelineMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function videoSource(clip: VideoClip): VideoNode | null {
  if (!clip.sourcePath) return null;
  return {
    type: "source",
    id: deterministicNodeId(clip.id, "source"),
    clip_id: clip.id,
    path: clip.sourcePath,
    pts_offset_ms: safeTimelineMs(clip.startMs),
    timeline_start_ms: safeTimelineMs(clip.startMs),
    duration_ms: safeTimelineMs(clip.durationMs),
    source_width: clip.sourceSize?.width,
    source_height: clip.sourceSize?.height,
    source_time_map: clip.sourceTimeMap,
  };
}

function zoomPan(
  clip: ZoomClip,
  keyframes: ReturnType<typeof resolveZoomMotion>[number]["keyframes"],
  startMs: number,
  endMs: number,
  outputWidth: number,
  outputHeight: number,
): VideoNode {
  return {
    type: "zoom-pan",
    id: deterministicNodeId(clip.id, "zoom"),
    clip_id: clip.id,
    t_start_ms: safeTimelineMs(startMs),
    duration_ms: safeTimelineMs(Math.max(0, endMs - startMs)),
    target: clip.target,
    keyframes: keyframes.map((keyframe) => ({
      t_ms: safeTimelineMs(keyframe.timeMs),
      center: normalizedZoomCenterToPixels(
        keyframe.center,
        keyframe.scale,
        outputWidth,
        outputHeight,
      ),
      scale: keyframe.scale,
      easing: keyframe.easing,
    })),
  };
}

function backgroundNode(
  background: EditorBackgroundKind,
  foregroundScale: number,
  radiusPx: number,
): VideoNode {
  const kind =
    background.kind === "transparent"
      ? ({ kind: "ambient" } as const)
      : background.kind === "image"
        ? {
            kind: "image" as const,
            asset_id: background.assetId,
            path: background.path || null,
          }
        : background.kind === "gradient"
          ? { kind: "gradient" as const, preset_id: background.preset_id }
          : { kind: "solid" as const, color: background.color };
  return {
    type: "background",
    id: deterministicNodeId("scene-background", "background"),
    kind,
    radius_px: radiusPx,
    shadow: null,
    foreground_scale: foregroundScale,
  };
}

function evenDimension(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  const even = rounded % 2 === 0 ? rounded : rounded - 1;
  return Math.max(16, even);
}

function sourceDimension(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.round(n));
}

function firstSourceDimensions(tracks: TimelineSlice["tracks"]): { w: number; h: number } | null {
  const source = tracks.video
    .filter((clip) => clip.sourcePath)
    .reduce<VideoClip | null>(
      (earliest, clip) =>
        !earliest ||
        clip.startMs < earliest.startMs ||
        (clip.startMs === earliest.startMs && clip.id < earliest.id)
          ? clip
          : earliest,
      null,
    );
  if (!source) return null;
  return source.sourceSize ? { w: source.sourceSize.width, h: source.sourceSize.height } : null;
}

function outputPixels(state: ComputeGraphInput): { w: number; h: number } {
  const { exportForm } = state;
  if (exportForm.resolution === "custom") {
    return {
      w: evenDimension(exportForm.customWidth, 1920),
      h: evenDimension(exportForm.customHeight, 1080),
    };
  }
  if (exportForm.resolution === "match-source") {
    const source = firstSourceDimensions(state.tracks);
    const rect = state._undoExtras?.captureRect;
    const sourceWidth = source?.w ?? rect?.width;
    const sourceHeight = source?.h ?? rect?.height;
    if (sourceWidth && sourceHeight && sourceWidth > 0 && sourceHeight > 0) {
      return {
        w: sourceDimension(sourceWidth, 1920),
        h: sourceDimension(sourceHeight, 1080),
      };
    }
  }
  return RESOLUTION_PX[exportForm.resolution as ExportResolution] ?? RESOLUTION_PX["1080p"];
}

function hexToRgba(
  hex: string | undefined,
  fallback: Rgba = { r: 255, g: 255, b: 255, a: 255 },
): Rgba {
  if (!hex) return fallback;
  const clean = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
    a: 255,
  };
}

function cursorOverlay(clip: CursorClip): VideoNode | null {
  if (!clip.trajectoryDir) return null;
  return {
    type: "cursor-overlay",
    id: deterministicNodeId(clip.id, "cursor"),
    clip_id: clip.id,
    skin: clip.skin,
    size_scale: clip.sizeScale,
    motion_preset: normalizeCursorMotionPreset(clip.motionPreset),
    preserve_full_motion: clip.preserveFullMotion ?? false,
    click_effect: normalizeCursorClickEffect(clip.clickEffect),
    color_tint: clip.colorTint ? hexToRgba(clip.colorTint) : null,
    t_start_ms: safeTimelineMs(clip.startMs),
    duration_ms: safeTimelineMs(clip.durationMs),
    source_time_map: clip.sourceTimeMap,
    trajectory: {
      kind: clip.trajectoryKind ?? "trajectory",
      path: clip.trajectoryDir,
      png_sequence_dir: clip.trajectoryDir,
      fps: clip.trajectoryFps,
      frame_count: clip.trajectoryFrameCount,
    },
  };
}

function textBox(clip: AnnotationClip, pos: Vec2): TextBox | null {
  if (!clip.text) return null;
  const style = resolvedTextStyle(clip);
  const textShadow = style.textShadow
    ? {
        color: hexToRgbaWithAlpha(style.textShadow.color, { r: 0, g: 0, b: 0, a: 128 }),
        blur_px: style.textShadow.blurPx,
        offset_x_px: style.textShadow.offsetXpx,
        offset_y_px: style.textShadow.offsetYpx,
      }
    : null;
  return {
    clip_id: clip.id,
    t_start_ms: safeTimelineMs(clip.startMs),
    t_end_ms: safeTimelineMs(clip.startMs + clip.durationMs),
    text: clip.text,
    pos,
    fallback_pos: clip.pos,
    anchor: clip.anchor ?? { kind: "screen", pos: clip.pos },
    source_binding: clip.sourceBinding ?? null,
    font: effectiveTextFontChoice(style.font),
    size_pt: style.sizePt,
    color: hexToRgbaWithAlpha(style.color, { r: 255, g: 255, b: 255, a: 255 }),
    align: style.align,
    max_width_pct: style.maxWidthPct,
    line_height: style.lineHeight,
    letter_spacing_px: style.letterSpacingPx,
    text_shadow: textShadow,
    box_style: style.boxStyle
      ? {
          padding_px: style.boxStyle.paddingPx,
          radius_px: style.boxStyle.radiusPx,
          bg_color: hexToRgbaWithAlpha(style.boxStyle.bgColor, { r: 17, g: 19, b: 23, a: 216 }),
          border_color: style.boxStyle.borderColor
            ? hexToRgbaWithAlpha(style.boxStyle.borderColor, { r: 255, g: 255, b: 255, a: 36 })
            : null,
          border_width_px: style.boxStyle.borderWidthPx,
          shadow: style.boxStyle.shadow
            ? {
                color: hexToRgbaWithAlpha(style.boxStyle.shadow.color, {
                  r: 0,
                  g: 0,
                  b: 0,
                  a: 128,
                }),
                blur_px: style.boxStyle.shadow.blurPx,
                offset_x_px: style.boxStyle.shadow.offsetXpx,
                offset_y_px: style.boxStyle.shadow.offsetYpx,
              }
            : null,
        }
      : null,
    anim_in: style.animation.in,
    anim_out: style.animation.out,
    anim_duration_ms: Math.max(0, Math.round(style.animation.durationMs)),
  };
}

function highlightOverlaySpec(
  clip: AnnotationClip,
  zoomAt: (playheadMs: number) => ZoomSample,
  output: { w: number; h: number },
): HighlightOverlaySpec | null {
  const highlight = clip.highlight;
  if (!highlight) return null;
  const impact = safeTimelineMs(clip.startMs);
  const zoom = zoomAt(impact);
  const center = applyZoomToPoint(highlight.center, zoom);
  const bounds = highlight.bounds ? applyZoomToBounds(highlight.bounds, zoom) : undefined;
  return {
    clip_id: clip.id,
    t_start_ms: impact,
    duration_ms: Math.max(1, safeTimelineMs(highlight.durationMs ?? clip.durationMs)),
    shape: highlight.shape ?? "ring",
    center: { x: center.x * output.w, y: center.y * output.h },
    source_center: highlight.center,
    max_radius_px: Math.max(1, highlight.radiusPx * Math.max(1, zoom.scale)),
    bounds: bounds
      ? {
          x: bounds.x * output.w,
          y: bounds.y * output.h,
          w: bounds.w * output.w,
          h: bounds.h * output.h,
        }
      : undefined,
    source_bounds: highlight.bounds,
    padding_px: highlight.paddingPx ?? 8,
    radius_px: highlight.bounds
      ? Math.min(12, Math.max(4, highlight.radiusPx * 0.18))
      : highlight.radiusPx,
    stroke_px: highlight.strokePx ?? 2,
    glow_px: highlight.glowPx ?? 16,
    color: hexToRgba(highlight.color, { r: 255, g: 255, b: 255, a: 229 }),
    opacity: highlight.opacity ?? 0.72,
  };
}

function audioNode(clip: SoundClip): AudioNode | null {
  if (!clip.path) return null;
  const gain = clip.gain ?? 1;
  return {
    type: "sound",
    id: deterministicNodeId(clip.id, "sound"),
    clip_id: clip.id,
    kind: clip.kind,
    path: clip.path,
    t_start_ms: safeTimelineMs(clip.startMs),
    duration_ms: safeTimelineMs(clip.durationMs),
    gain: Number.isFinite(gain) ? Math.max(0, gain) : 1,
    source_binding: clip.sourceBinding ?? null,
    source_time_map: clip.sourceTimeMap,
  };
}

interface TimelineTransition {
  boundary: number;
  leftClipId: string;
  rightClipId: string;
  kind: XfadeKind;
  durationMs: number;
}

function normalizeTransitionDuration(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor(ms));
}

function transitionNodes(
  videoClips: readonly VideoClip[],
  sourceVideoClips: readonly VideoClip[],
): VideoNode[] {
  const transitions: TimelineTransition[] = [];
  const sourceIndexByClipId = new Map(sourceVideoClips.map((clip, index) => [clip.id, index]));
  for (let i = 0; i < videoClips.length - 1; i++) {
    const clip = videoClips[i];
    const rightClip = videoClips[i + 1];
    if (!clip || !rightClip) continue;
    if (!clip.sourcePath || !rightClip.sourcePath) continue;
    const spec = clip.outgoingTransition;
    if (!spec) continue;
    const durationMs = normalizeTransitionDuration(spec.durationMs);
    if (durationMs <= 0) continue;
    const boundary = sourceIndexByClipId.get(clip.id);
    if (boundary === undefined || sourceVideoClips[boundary + 1]?.id !== rightClip.id) {
      continue;
    }
    transitions.push({
      boundary,
      leftClipId: clip.id,
      rightClipId: rightClip.id,
      kind: spec.kind,
      durationMs,
    });
  }

  const clipDurationPrefix = [0];
  for (const clip of sourceVideoClips) {
    const previous = clipDurationPrefix.at(-1) ?? 0;
    clipDurationPrefix.push(previous + normalizeTransitionDuration(clip.durationMs));
  }

  let consumedTransitionMs = 0;
  return transitions.map((transition) => {
    const sumClips = clipDurationPrefix[transition.boundary + 1] ?? 0;
    const offsetMs = Math.max(0, sumClips - consumedTransitionMs - transition.durationMs);
    consumedTransitionMs += transition.durationMs;
    return {
      type: "transition",
      id: deterministicNodeId(`${transition.leftClipId}->${transition.rightClipId}`, "transition"),
      kind: transition.kind,
      duration_ms: transition.durationMs,
      offset_ms: offsetMs,
      from_source_id: deterministicNodeId(transition.leftClipId, "source"),
      to_source_id: deterministicNodeId(transition.rightClipId, "source"),
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function clipsByStart<C extends Clip>(clips: readonly C[]): C[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

type ExportFieldDisposition = "graph" | "identity" | "editor-only" | "diagnostic";

const COMMON_CLIP_FIELD_COVERAGE = {
  id: "identity",
  trackId: "identity",
  startMs: "graph",
  durationMs: "graph",
  label: "editor-only",
  syncGroupId: "editor-only",
  sourceRevision: "editor-only",
  sourceTimeMap: "graph",
} as const;

/** Compile-time inventory: adding a timeline property requires an export decision. */
export const EXPORT_CLIP_FIELD_COVERAGE = {
  video: {
    ...COMMON_CLIP_FIELD_COVERAGE,
    sourcePath: "graph",
    sourceSize: "graph",
    outgoingTransition: "graph",
  } satisfies Record<keyof VideoClip, ExportFieldDisposition>,
  cursor: {
    ...COMMON_CLIP_FIELD_COVERAGE,
    trajectoryDir: "graph",
    trajectoryKind: "graph",
    trajectoryFps: "graph",
    trajectoryFrameCount: "graph",
    skin: "graph",
    motionPreset: "graph",
    clickEffect: "graph",
    preserveFullMotion: "graph",
    sizeScale: "graph",
    colorTint: "graph",
  } satisfies Record<keyof CursorClip, ExportFieldDisposition>,
  zoom: {
    ...COMMON_CLIP_FIELD_COVERAGE,
    target: "graph",
    scale: "graph",
    center: "graph",
    origin: "graph",
    preset: "graph",
    easing: "graph",
  } satisfies Record<keyof ZoomClip, ExportFieldDisposition>,
  sound: {
    ...COMMON_CLIP_FIELD_COVERAGE,
    path: "graph",
    kind: "graph",
    gain: "graph",
    sourceBinding: "graph",
  } satisfies Record<keyof SoundClip, ExportFieldDisposition>,
  annotations: {
    ...COMMON_CLIP_FIELD_COVERAGE,
    text: "graph",
    pos: "graph",
    sizePt: "graph",
    font: "graph",
    color: "graph",
    styleId: "graph",
    maxWidthPct: "graph",
    lineHeight: "graph",
    letterSpacingPx: "graph",
    textShadow: "graph",
    boxStyle: "graph",
    align: "graph",
    anchor: "graph",
    animation: "graph",
    sourceBinding: "graph",
    highlight: "graph",
  } satisfies Record<keyof AnnotationClip, ExportFieldDisposition>,
} as const;

export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}

function exportIssue(
  code: string,
  message: string,
  options: Omit<ExportIssue, "id" | "code" | "message">,
): ExportIssue {
  const scope = [options.clip_id, options.output_index, options.property]
    .filter((value) => value !== undefined)
    .join(":");
  return {
    id: scope ? `${code}:${scope}` : code,
    code,
    message,
    ...options,
  };
}

function finiteTimelineValue(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function clipIssues(clip: Clip, state: ComputeGraphInput): ExportIssue[] {
  const issues: ExportIssue[] = [];
  if (!finiteTimelineValue(clip.startMs)) {
    issues.push(
      exportIssue("clip.invalid-start", "Clip start must be a finite non-negative number.", {
        severity: "error",
        clip_id: clip.id,
        property: "startMs",
      }),
    );
  }
  if (!Number.isFinite(clip.durationMs) || clip.durationMs <= 0) {
    issues.push(
      exportIssue("clip.invalid-duration", "Clip duration must be greater than zero.", {
        severity: "error",
        clip_id: clip.id,
        property: "durationMs",
      }),
    );
  }

  switch (clip.trackId) {
    case "video":
      if (!clip.sourcePath.trim()) {
        issues.push(
          exportIssue("video.missing-source", "Video clip has no source path.", {
            severity: "error",
            clip_id: clip.id,
            property: "sourcePath",
            remediation: "Relink or re-record the missing source video.",
          }),
        );
      }
      if (
        clip.sourceSize &&
        (!Number.isFinite(clip.sourceSize.width) ||
          !Number.isFinite(clip.sourceSize.height) ||
          clip.sourceSize.width <= 0 ||
          clip.sourceSize.height <= 0)
      ) {
        issues.push(
          exportIssue("video.invalid-source-size", "Video source dimensions are invalid.", {
            severity: "error",
            clip_id: clip.id,
            property: "sourceSize",
          }),
        );
      }
      break;
    case "cursor":
      if (!clip.trajectoryDir.trim()) {
        issues.push(
          exportIssue("cursor.missing-trajectory", "Cursor clip has no trajectory source.", {
            severity: "error",
            clip_id: clip.id,
            property: "trajectoryDir",
          }),
        );
      }
      if (!Number.isFinite(clip.trajectoryFps) || clip.trajectoryFps <= 0) {
        issues.push(
          exportIssue("cursor.invalid-fps", "Cursor trajectory FPS must be greater than zero.", {
            severity: "error",
            clip_id: clip.id,
            property: "trajectoryFps",
          }),
        );
      }
      if (!Number.isFinite(clip.trajectoryFrameCount) || clip.trajectoryFrameCount <= 0) {
        issues.push(
          exportIssue(
            "cursor.invalid-frame-count",
            "Cursor trajectory must contain at least one frame.",
            {
              severity: "error",
              clip_id: clip.id,
              property: "trajectoryFrameCount",
            },
          ),
        );
      }
      if (clip.colorTint && !validHexColor(clip.colorTint)) {
        issues.push(
          exportIssue(
            "cursor.invalid-color-tint",
            "Cursor color tint must be a six-digit hex color.",
            {
              severity: "error",
              clip_id: clip.id,
              property: "colorTint",
            },
          ),
        );
      }
      break;
    case "zoom":
      if (!Number.isFinite(clip.scale) || clip.scale < 1) {
        issues.push(
          exportIssue("zoom.invalid-scale", "Zoom scale must be a finite value of at least 1.", {
            severity: "error",
            clip_id: clip.id,
            property: "scale",
          }),
        );
      }
      if (clip.target.kind === "element" && !clip.target.selector.trim()) {
        issues.push(
          exportIssue("zoom.missing-selector", "Element zoom target has no selector.", {
            severity: "error",
            clip_id: clip.id,
            property: "target.selector",
          }),
        );
      }
      break;
    case "sound":
      if (!clip.path.trim()) {
        issues.push(
          exportIssue("sound.missing-source", "Sound clip has no audio path.", {
            severity: "error",
            clip_id: clip.id,
            property: "path",
            remediation: "Relink or regenerate the missing audio clip.",
          }),
        );
      }
      if (clip.gain !== undefined && (!Number.isFinite(clip.gain) || clip.gain < 0)) {
        issues.push(
          exportIssue("sound.invalid-gain", "Sound gain must be a finite non-negative value.", {
            severity: "error",
            clip_id: clip.id,
            property: "gain",
          }),
        );
      }
      if (clip.kind === "voiceover" && !clip.sourceBinding) {
        issues.push(
          exportIssue(
            "voiceover.missing-step-binding",
            "Voiceover is missing its stable story-step binding.",
            {
              severity: "error",
              clip_id: clip.id,
              property: "sourceBinding",
              remediation: "Regenerate the voiceover for the corresponding story step.",
            },
          ),
        );
      }
      break;
    case "annotations":
      if (!clip.text.trim() && !clip.highlight) {
        issues.push(
          exportIssue("annotation.empty", "Annotation has neither text nor a highlight effect.", {
            severity: "error",
            clip_id: clip.id,
            property: "text",
          }),
        );
      }
      if (
        (clip.anchor?.kind === "target" || clip.anchor?.kind === "cursor") &&
        !state._undoExtras?.actions &&
        !state._undoExtras?.stepTiming
      ) {
        issues.push(
          exportIssue(
            "annotation.missing-anchor-data",
            "Dynamic annotation anchor cannot be resolved without recorded action or step timing data.",
            {
              severity: "error",
              clip_id: clip.id,
              property: "anchor",
              remediation: "Re-record the story or change the annotation to a screen anchor.",
            },
          ),
        );
      }
      break;
    default:
      assertNever(clip, "timeline clip");
  }
  return issues;
}

function compilationIssues(state: ComputeGraphInput): ExportIssue[] {
  const issues = Object.values(state.tracks)
    .flatMap((clips) => clips as Clip[])
    .flatMap((clip) => clipIssues(clip, state));
  const sortedVideo = clipsByStart(state.tracks.video);
  sortedVideo.forEach((clip, index) => {
    if (!clip.outgoingTransition) return;
    const next = sortedVideo[index + 1];
    if (!next?.sourcePath) {
      issues.push(
        exportIssue(
          "transition.missing-next-source",
          "Transition does not have a following source video.",
          {
            severity: "error",
            clip_id: clip.id,
            property: "outgoingTransition",
          },
        ),
      );
    }
  });
  const background = readEditorBackground(state);
  if (background.kind === "gradient" && !background.preset_id.trim()) {
    issues.push(
      exportIssue("background.missing-preset", "Gradient background has no preset id.", {
        severity: "error",
        property: "background.preset_id",
      }),
    );
  }
  if (background.kind === "image" && !background.assetId && !background.path.trim()) {
    issues.push(
      exportIssue("background.missing-image", "Image background has no asset id or local path.", {
        severity: "error",
        property: "background",
      }),
    );
  }
  if (!state.tracks.video.some((clip) => clip.sourcePath.trim())) {
    issues.push(
      exportIssue("composition.missing-video", "Composition has no renderable source video.", {
        severity: "error",
        remediation: "Add or relink a video clip before exporting.",
      }),
    );
  }
  return issues.sort((a, b) => a.id.localeCompare(b.id));
}

function compositionDurationMs(tracks: TimelineSlice["tracks"]): number {
  return Math.max(
    0,
    ...Object.values(tracks).flatMap((clips) =>
      clips.map((clip) => safeTimelineMs(clip.startMs) + safeTimelineMs(clip.durationMs)),
    ),
  );
}

/**
 * Project the timeline state into a Graph. Pure: no side effects, no IO.
 * The output is JSON-serializable (no bigints, no functions) and stable
 * across calls with equal input.
 *
 * Empty tracks ⇒ empty `video`/`audio` arrays. Clips missing required
 * fields (e.g. video without `sourcePath`, sound without `path`) are
 * skipped silently — the Export modal's `graphAvailable` flag gates
 * submission when nothing usable was produced.
 */
function projectGraph(state: ComputeGraphInput): Graph {
  const { tracks, exportForm } = state;
  const px = outputPixels(state);

  const video: VideoNode[] = [];

  const sortedVideoClips = clipsByStart(tracks.video);
  const sourceVideoClips = sortedVideoClips.filter((clip) => clip.sourcePath);

  for (const clip of sourceVideoClips) {
    const n = videoSource(clip);
    if (n) video.push(n);
  }
  const sortedZoomClips = clipsByStart(tracks.zoom);
  const resolvedZoomMotions = resolveZoomMotion(sortedZoomClips);
  for (const motion of resolvedZoomMotions) {
    video.push(
      zoomPan(motion.sourceClip, motion.keyframes, motion.startMs, motion.endMs, px.w, px.h),
    );
  }
  const editorBackground = readEditorBackground(state);
  const bg =
    editorBackground.kind !== "transparent" || sourceVideoClips.length > 0
      ? backgroundNode(
          editorBackground,
          exportForm.frameMode === "source" ? 1 : editorBackground.foregroundScale,
          exportForm.frameMode === "source" ? 0 : 24,
        )
      : null;
  if (bg) video.push(bg);
  const sortedAnnotations = clipsByStart(tracks.annotations);
  const zoomSampleCache = new Map<number, ZoomSample>();
  const zoomAt = (playheadMs: number): ZoomSample => {
    const cached = zoomSampleCache.get(playheadMs);
    if (cached) return cached;
    const next = sampleResolvedZoom(resolvedZoomMotions, playheadMs);
    zoomSampleCache.set(playheadMs, next);
    return next;
  };
  const highlights: HighlightOverlaySpec[] = [];
  for (const clip of sortedAnnotations) {
    const h = highlightOverlaySpec(clip, zoomAt, px);
    if (h) highlights.push(h);
  }
  const firstHighlightClip = sortedAnnotations.find((clip) => clip.highlight);
  if (highlights.length > 0 && firstHighlightClip) {
    video.push({
      type: "highlight-overlay",
      id: deterministicNodeId(firstHighlightClip.id, "highlight"),
      highlights,
    });
  }
  for (const clip of clipsByStart(tracks.cursor)) {
    const n = cursorOverlay(clip);
    if (n) video.push(n);
  }
  const boxes: TextBox[] = [];
  for (const clip of sortedAnnotations) {
    const sampleMs = clip.startMs + clip.durationMs / 2;
    const anchorPos = resolveTextAnchorPosition(
      clip,
      sampleMs,
      state._undoExtras?.actions,
      tracks.cursor,
      state._undoExtras?.stepTiming,
      state._undoExtras?.captureRect,
    );
    const pos =
      clip.anchor?.kind === "target" || clip.anchor?.kind === "cursor"
        ? applyZoomToPoint(anchorPos, zoomAt(sampleMs))
        : anchorPos;
    const b = textBox(clip, pos);
    if (b) boxes.push(b);
  }
  const firstAnnotation = sortedAnnotations[0];
  if (boxes.length > 0 && firstAnnotation) {
    const seedId = firstAnnotation.id;
    video.push({
      type: "text-overlay",
      id: deterministicNodeId(seedId, "text"),
      boxes,
    });
  }
  video.push(...transitionNodes(sortedVideoClips, sourceVideoClips));

  const audio: AudioNode[] = [];
  for (const clip of clipsByStart(tracks.sound)) {
    const node = audioNode(clip);
    if (node) audio.push(node);
  }

  return {
    schema_version: SCHEMA_VERSION,
    output_width: px.w,
    output_height: px.h,
    output_fps: exportForm.fps,
    duration_ms: compositionDurationMs(tracks),
    video,
    audio,
  };
}

export interface CompileExportCompositionResult {
  graph: Graph;
  issues: ExportIssue[];
}

/** Compile the canonical graph and return every blocking/non-blocking diagnostic. */
export function compileExportComposition(state: ComputeGraphInput): CompileExportCompositionResult {
  return {
    graph: projectGraph(state),
    issues: compilationIssues(state),
  };
}

/** Compatibility projection for preview/tests that only need the graph. */
export function computeGraph(state: ComputeGraphInput): Graph {
  return compileExportComposition(state).graph;
}

/** True when the graph has at least one renderable video node. */
export function graphIsRenderable(graph: Graph): boolean {
  return graph.video.some(
    (node) => node.type === "source" && typeof node.path === "string" && node.path.length > 0,
  );
}

/** Track ids consumed by `computeGraph`. Exported for documentation/tests. */
export const COMPUTED_TRACKS: readonly TrackId[] = [
  "video",
  "zoom",
  "cursor",
  "annotations",
  "sound",
];
