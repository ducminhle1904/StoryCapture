/**
 * computeGraph — pure projection from the timeline editor store into the
 * effects-crate `Graph` AST that the export pipeline consumes.
 *
 * The Rust shape is the source of truth (see `crates/effects/src/ast/`).
 * The TS reference lives in `packages/shared-types/src/generated/effects.ts`,
 * but that file uses `bigint` for u64 fields which JSON.stringify cannot
 * encode. We instead emit plain numbers (JSON numbers deserialize into
 * Rust u64 via serde with no precision loss for ms-scale timestamps), and
 * narrow our own structurally-identical local types so the boundary stays
 * type-checked.
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

import type { RecordingActions } from "../../../ipc/actions";
import type { ExportResolution } from "../../../ipc/export";
import type { CaptureRect, RecordingStepTimingSidecar } from "../../../ipc/trajectory";
import type { ExportFormState } from "./export-slice";
import { type EditorBackgroundKind, readEditorBackground } from "./store";
import { resolveTextAnchorPosition } from "./text-anchor";
import { hexToRgbaWithAlpha, resolvedTextStyle } from "./text-style";
import type {
  AnnotationClip,
  Clip,
  CursorClip,
  CursorMotionPreset,
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
  sampleZoom,
  zoomTiming,
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

// ---------------------------------------------------------------------------
// Local Graph types — mirror Rust shape, but use `number` instead of `bigint`
// for u64 fields so JSON.stringify works. Drift guard: any change here MUST
// match a corresponding change in `crates/effects/src/ast/`.
//
// Vec2, ZoomTarget, CursorSkin are re-exported from timeline-slice so the
// editor's store shape and the wire format share a single definition.
// ---------------------------------------------------------------------------

export type { CursorSkin, Vec2, XfadeKind, ZoomTarget };

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type EasingKind =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "ease-in-out-cubic"
  | "ease-out-quad";

export interface ZoomKeyframe {
  t_ms: number;
  center: Vec2;
  scale: number;
  easing: EasingKind;
}

export interface TrajectoryRef {
  png_sequence_dir: string;
  fps: number;
  frame_count: number;
}

export type FontChoice =
  | { kind: "bundled"; family: string; weight: number }
  | { kind: "system-default" };

export type TextAnim = "none" | "fade" | "slide-up" | "scale-in";

export interface BoxStyle {
  padding_px: number;
  radius_px: number;
  bg_color: Rgba;
  border_color: Rgba | null;
}

export interface TextBox {
  t_start_ms: number;
  t_end_ms: number;
  text: string;
  pos: Vec2;
  font: FontChoice;
  size_pt: number;
  color: Rgba;
  box_style: BoxStyle | null;
  anim_in: TextAnim;
  anim_out: Extract<TextAnim, "none" | "fade">;
}

export interface RippleEvent {
  t_anticipate_ms: number;
  t_impact_ms: number;
  duration_ms: number;
  center: Vec2;
  max_radius_px: number;
  bounds?: { x: number; y: number; w: number; h: number };
  color: Rgba;
}

export type HighlightShape = "ring" | "spotlight";

export interface HighlightOverlaySpec {
  t_start_ms: number;
  duration_ms: number;
  shape: HighlightShape;
  center: Vec2;
  max_radius_px: number;
  bounds?: { x: number; y: number; w: number; h: number };
  padding_px: number;
  radius_px: number;
  stroke_px: number;
  glow_px: number;
  color: Rgba;
  opacity: number;
  png_path?: string | null;
  overlay_pos?: Vec2 | null;
}

export type VideoNode =
  | { type: "source"; id: string; path: string; pts_offset_ms: number }
  | { type: "zoom-pan"; id: string; target: ZoomTarget; keyframes: ZoomKeyframe[] }
  | {
      type: "background";
      id: string;
      kind: Exclude<EditorBackgroundKind, { kind: "transparent" }>;
      radius_px: number;
      shadow: null;
      padding_px: number;
    }
  | {
      type: "cursor-overlay";
      id: string;
      skin: CursorSkin;
      size_scale: number;
      motion_preset: CursorMotionPreset;
      color_tint: Rgba | null;
      trajectory: TrajectoryRef;
    }
  | { type: "ripple-overlay"; id: string; events: RippleEvent[] }
  | { type: "highlight-overlay"; id: string; highlights: HighlightOverlaySpec[] }
  | { type: "text-overlay"; id: string; boxes: TextBox[] }
  | {
      type: "transition";
      id: string;
      kind: XfadeKind;
      duration_ms: number;
      offset_ms: number;
    };

export type AudioNode =
  | { type: "audio-source"; id: string; path: string; pts_offset_ms: number }
  | { type: "volume"; id: string; input_label: string; volume: number };

export interface Graph {
  schema_version: number;
  output_width: number;
  output_height: number;
  output_fps: number;
  video: VideoNode[];
  audio: AudioNode[];
}

// ---------------------------------------------------------------------------
// Determinism helpers
// ---------------------------------------------------------------------------

/** Mirrors the Rust schema_version constant. */
const SCHEMA_VERSION = 2;

const RESOLUTION_PX: Record<ExportResolution, { w: number; h: number }> = {
  "match-source": { w: 1920, h: 1080 },
  "720p": { w: 1280, h: 720 },
  "1080p": { w: 1920, h: 1080 },
  "4k": { w: 3840, h: 2160 },
  custom: { w: 1920, h: 1080 },
};

const FRAMED_BACKGROUND_PADDING_PX = 64;

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

function audioNodeLabel(id: string): string {
  return `a_${id.replaceAll("-", "").slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Per-track projections — typed direct access, no metadata bag.
// ---------------------------------------------------------------------------

function videoSource(clip: VideoClip): VideoNode | null {
  if (!clip.sourcePath) return null;
  return {
    type: "source",
    id: deterministicNodeId(clip.id, "source"),
    path: clip.sourcePath,
    pts_offset_ms: clip.startMs,
  };
}

function zoomPan(clip: ZoomClip, outputWidth: number, outputHeight: number): VideoNode {
  const timing = zoomTiming(clip);
  const targetScale = Number.isFinite(clip.scale) ? Math.max(1, clip.scale) : 1;
  const centerAtRest = normalizedZoomCenterToPixels(clip.center, 1, outputWidth, outputHeight);
  const centerAtScale = normalizedZoomCenterToPixels(
    clip.center,
    targetScale,
    outputWidth,
    outputHeight,
  );
  const keyframes: ZoomKeyframe[] = [
    {
      t_ms: clip.startMs,
      center: centerAtRest,
      scale: 1.0,
      easing: "ease-in-out-cubic",
    },
    {
      t_ms: timing.inEndMs,
      center: centerAtScale,
      scale: targetScale,
      easing: "ease-in-out-cubic",
    },
    {
      t_ms: timing.outStartMs,
      center: centerAtScale,
      scale: targetScale,
      easing: "ease-in-out-cubic",
    },
    {
      t_ms: clip.startMs + clip.durationMs,
      center: centerAtRest,
      scale: 1.0,
      easing: "ease-in-out-cubic",
    },
  ];
  return {
    type: "zoom-pan",
    id: deterministicNodeId(clip.id, "zoom"),
    target: clip.target,
    keyframes,
  };
}

function backgroundNode(background: EditorBackgroundKind): VideoNode | null {
  if (background.kind === "transparent") return null;
  return {
    type: "background",
    id: deterministicNodeId("scene-background", "background"),
    kind: background,
    radius_px: 24,
    shadow: null,
    padding_px: FRAMED_BACKGROUND_PADDING_PX,
  };
}

function evenDimension(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  const even = rounded % 2 === 0 ? rounded : rounded - 1;
  return Math.max(16, even);
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
    const rect = state._undoExtras?.captureRect;
    if (rect && rect.width > 0 && rect.height > 0) {
      const background = readEditorBackground(state);
      const framedPadding =
        exportForm.frameMode === "framed" && background.kind !== "transparent"
          ? FRAMED_BACKGROUND_PADDING_PX * 2
          : 0;
      return {
        w: evenDimension(rect.width + framedPadding, 1920),
        h: evenDimension(rect.height + framedPadding, 1080),
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
    skin: clip.skin,
    size_scale: clip.sizeScale,
    motion_preset: normalizeCursorMotionPreset(clip.motionPreset),
    color_tint: null,
    trajectory: {
      png_sequence_dir: clip.trajectoryDir,
      fps: clip.trajectoryFps,
      frame_count: clip.trajectoryFrameCount,
    },
  };
}

function textBox(clip: AnnotationClip, pos: Vec2): TextBox | null {
  if (!clip.text) return null;
  const style = resolvedTextStyle(clip);
  return {
    t_start_ms: clip.startMs,
    t_end_ms: clip.startMs + clip.durationMs,
    text: clip.text,
    pos,
    font: style.font,
    size_pt: style.sizePt,
    color: hexToRgba(style.color),
    box_style: style.boxStyle
      ? {
          padding_px: style.boxStyle.paddingPx,
          radius_px: style.boxStyle.radiusPx,
          bg_color: hexToRgbaWithAlpha(style.boxStyle.bgColor, { r: 17, g: 19, b: 23, a: 216 }),
          border_color: style.boxStyle.borderColor
            ? hexToRgbaWithAlpha(style.boxStyle.borderColor, { r: 255, g: 255, b: 255, a: 36 })
            : null,
        }
      : null,
    anim_in: style.animation.in,
    anim_out: style.animation.out,
  };
}

function highlightOverlaySpec(
  clip: AnnotationClip,
  zoomAt: (playheadMs: number) => ReturnType<typeof sampleZoom>,
  output: { w: number; h: number },
): HighlightOverlaySpec | null {
  const highlight = clip.highlight;
  if (!highlight) return null;
  const impact = Math.max(0, clip.startMs);
  const zoom = zoomAt(impact);
  const center = applyZoomToPoint(highlight.center, zoom);
  const bounds = highlight.bounds ? applyZoomToBounds(highlight.bounds, zoom) : undefined;
  return {
    t_start_ms: impact,
    duration_ms: Math.max(1, highlight.durationMs ?? clip.durationMs),
    shape: highlight.shape ?? "ring",
    center: { x: center.x * output.w, y: center.y * output.h },
    max_radius_px: Math.max(1, highlight.radiusPx * Math.max(1, zoom.scale)),
    bounds: bounds
      ? {
          x: bounds.x * output.w,
          y: bounds.y * output.h,
          w: bounds.w * output.w,
          h: bounds.h * output.h,
        }
      : undefined,
    padding_px: highlight.paddingPx ?? 8,
    radius_px: highlight.bounds ? Math.min(12, Math.max(4, highlight.radiusPx * 0.18)) : highlight.radiusPx,
    stroke_px: highlight.strokePx ?? 2,
    glow_px: highlight.glowPx ?? 16,
    color: hexToRgba(highlight.color, { r: 255, g: 255, b: 255, a: 229 }),
    opacity: highlight.opacity ?? 0.72,
  };
}

function audioNodes(clip: SoundClip): AudioNode[] {
  if (!clip.path) return [];
  const sourceId = deterministicNodeId(clip.id, "audio");
  const nodes: AudioNode[] = [
    {
      type: "audio-source",
      id: sourceId,
      path: clip.path,
      pts_offset_ms: clip.startMs,
    },
  ];
  const gain = clip.gain ?? 1;
  if (Number.isFinite(gain) && gain !== 1) {
    nodes.push({
      type: "volume",
      id: deterministicNodeId(clip.id, "volume"),
      input_label: audioNodeLabel(sourceId),
      volume: Math.max(0, gain),
    });
  }
  return nodes;
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
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function clipsByStart<C extends Clip>(clips: readonly C[]): C[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
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
export function computeGraph(state: ComputeGraphInput): Graph {
  const { tracks, exportForm } = state;
  const px = outputPixels(state);

  const video: VideoNode[] = [];

  const sortedVideoClips = clipsByStart(tracks.video);
  const sourceVideoClips = sortedVideoClips.filter((clip) => clip.sourcePath);

  for (const clip of sourceVideoClips) {
    const n = videoSource(clip);
    if (n) video.push(n);
  }
  for (const clip of clipsByStart(tracks.zoom)) {
    video.push(zoomPan(clip, px.w, px.h));
  }
  const bg = exportForm.frameMode === "framed" ? backgroundNode(readEditorBackground(state)) : null;
  if (bg) video.push(bg);
  const sortedAnnotations = clipsByStart(tracks.annotations);
  const zoomSampleCache = new Map<number, ReturnType<typeof sampleZoom>>();
  const zoomAt = (playheadMs: number): ReturnType<typeof sampleZoom> => {
    const cached = zoomSampleCache.get(playheadMs);
    if (cached) return cached;
    const next = sampleZoom(tracks.zoom, playheadMs);
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
    audio.push(...audioNodes(clip));
  }

  return {
    schema_version: SCHEMA_VERSION,
    output_width: px.w,
    output_height: px.h,
    output_fps: exportForm.fps,
    video,
    audio,
  };
}

/** True when the graph has at least one renderable video node. */
export function graphIsRenderable(graph: Graph): boolean {
  return graph.video.length > 0;
}

/** Track ids consumed by `computeGraph`. Exported for documentation/tests. */
export const COMPUTED_TRACKS: readonly TrackId[] = [
  "video",
  "zoom",
  "cursor",
  "annotations",
  "sound",
];
