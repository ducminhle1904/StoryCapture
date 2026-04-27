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
  ZoomClip,
  ZoomTarget,
} from "./timeline-slice";
import type { ExportFormState } from "./export-slice";
import type { ExportResolution } from "../../../ipc/export";

/**
 * Minimal slice of the editor store that `computeGraph` reads. Narrowing
 * the input lets callers subscribe to just these fields and avoids
 * spurious re-renders when unrelated slices (selection, panels, queue)
 * change.
 */
export interface ComputeGraphInput {
  tracks: TimelineSlice["tracks"];
  exportForm: ExportFormState;
}

// ---------------------------------------------------------------------------
// Local Graph types — mirror Rust shape, but use `number` instead of `bigint`
// for u64 fields so JSON.stringify works. Drift guard: any change here MUST
// match a corresponding change in `crates/effects/src/ast/`.
//
// Vec2, ZoomTarget, CursorSkin are re-exported from timeline-slice so the
// editor's store shape and the wire format share a single definition.
// ---------------------------------------------------------------------------

export type { Vec2, ZoomTarget, CursorSkin };

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

export interface TextBox {
  t_start_ms: number;
  t_end_ms: number;
  text: string;
  pos: Vec2;
  font: FontChoice;
  size_pt: number;
  color: Rgba;
  box_style: null;
  anim_in: TextAnim;
  anim_out: TextAnim;
}

export type VideoNode =
  | { type: "source"; id: string; path: string; pts_offset_ms: number }
  | { type: "zoom-pan"; id: string; target: ZoomTarget; keyframes: ZoomKeyframe[] }
  | {
      type: "cursor-overlay";
      id: string;
      skin: CursorSkin;
      size_scale: number;
      color_tint: Rgba | null;
      trajectory: TrajectoryRef;
    }
  | { type: "text-overlay"; id: string; boxes: TextBox[] };

export type AudioNode =
  | { type: "audio-source"; id: string; path: string; pts_offset_ms: number };

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
  "720p": { w: 1280, h: 720 },
  "1080p": { w: 1920, h: 1080 },
  "4k": { w: 3840, h: 2160 },
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
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
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

function videoSource(clip: VideoClip): VideoNode | null {
  if (!clip.sourcePath) return null;
  return {
    type: "source",
    id: deterministicNodeId(clip.id, "source"),
    path: clip.sourcePath,
    pts_offset_ms: clip.startMs,
  };
}

function zoomPan(clip: ZoomClip): VideoNode {
  const keyframes: ZoomKeyframe[] = [
    {
      t_ms: clip.startMs,
      center: clip.center,
      scale: 1.0,
      easing: "ease-in-out-cubic",
    },
    {
      t_ms: clip.startMs + clip.durationMs,
      center: clip.center,
      scale: clip.scale,
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

function cursorOverlay(clip: CursorClip): VideoNode | null {
  if (!clip.trajectoryDir) return null;
  return {
    type: "cursor-overlay",
    id: deterministicNodeId(clip.id, "cursor"),
    skin: clip.skin,
    size_scale: clip.sizeScale,
    color_tint: null,
    trajectory: {
      png_sequence_dir: clip.trajectoryDir,
      fps: clip.trajectoryFps,
      frame_count: clip.trajectoryFrameCount,
    },
  };
}

function textBox(clip: AnnotationClip): TextBox | null {
  if (!clip.text) return null;
  return {
    t_start_ms: clip.startMs,
    t_end_ms: clip.startMs + clip.durationMs,
    text: clip.text,
    pos: clip.pos,
    font: { kind: "system-default" },
    size_pt: clip.sizePt,
    color: { r: 255, g: 255, b: 255, a: 255 },
    box_style: null,
    anim_in: "fade",
    anim_out: "fade",
  };
}

function audioSource(clip: SoundClip): AudioNode | null {
  if (!clip.path) return null;
  return {
    type: "audio-source",
    id: deterministicNodeId(clip.id, "audio"),
    path: clip.path,
    pts_offset_ms: clip.startMs,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function clipsByStart<C extends Clip>(clips: readonly C[]): C[] {
  return [...clips].sort(
    (a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id),
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
export function computeGraph(state: ComputeGraphInput): Graph {
  const { tracks, exportForm } = state;
  const px =
    RESOLUTION_PX[exportForm.resolution as ExportResolution] ??
    RESOLUTION_PX["1080p"];

  const video: VideoNode[] = [];

  for (const clip of clipsByStart(tracks.video)) {
    const n = videoSource(clip);
    if (n) video.push(n);
  }
  for (const clip of clipsByStart(tracks.zoom)) {
    video.push(zoomPan(clip));
  }
  for (const clip of clipsByStart(tracks.cursor)) {
    const n = cursorOverlay(clip);
    if (n) video.push(n);
  }
  const boxes: TextBox[] = [];
  const sortedAnnotations = clipsByStart(tracks.annotations);
  for (const clip of sortedAnnotations) {
    const b = textBox(clip);
    if (b) boxes.push(b);
  }
  if (boxes.length > 0) {
    const seedId = sortedAnnotations[0]!.id;
    video.push({
      type: "text-overlay",
      id: deterministicNodeId(seedId, "text"),
      boxes,
    });
  }

  const audio: AudioNode[] = [];
  for (const clip of clipsByStart(tracks.sound)) {
    const n = audioSource(clip);
    if (n) audio.push(n);
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
