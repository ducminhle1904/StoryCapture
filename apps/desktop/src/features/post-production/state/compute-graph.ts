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
 */

import type { Clip, TimelineSlice, TrackId } from "./timeline-slice";
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
// ---------------------------------------------------------------------------

export interface Vec2 { x: number; y: number }
export interface Rgba { r: number; g: number; b: number; a: number }

export type EasingKind =
  | "linear" | "ease-in" | "ease-out" | "ease-in-out"
  | "ease-in-out-cubic" | "ease-out-quad";

export interface ZoomKeyframe {
  t_ms: number;
  center: Vec2;
  scale: number;
  easing: EasingKind;
}

export type ZoomTarget =
  | { kind: "cursor" }
  | { kind: "fixed-region"; top_left: Vec2; size: Vec2 }
  | { kind: "element"; selector: string };

export type CursorSkin =
  | "mac-default" | "win-default" | "dark" | "light" | "big-arrow";

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
// Per-track projections
// ---------------------------------------------------------------------------

function readString(meta: Record<string, unknown> | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readNumber(
  meta: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const v = meta?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readVec2(
  meta: Record<string, unknown> | undefined,
  key: string,
  fallback: Vec2,
): Vec2 {
  const v = meta?.[key] as { x?: unknown; y?: unknown } | undefined;
  if (v && typeof v.x === "number" && typeof v.y === "number") {
    return { x: v.x, y: v.y };
  }
  return fallback;
}

function videoSource(clip: Clip): VideoNode | null {
  const path = readString(clip.metadata, "sourcePath");
  if (!path) return null;
  return {
    type: "source",
    id: deterministicNodeId(clip.id, "source"),
    path,
    pts_offset_ms: clip.startMs,
  };
}

function zoomPan(clip: Clip): VideoNode {
  const meta = clip.metadata;
  const target = (meta?.target as ZoomTarget | undefined) ?? { kind: "cursor" };
  const scale = readNumber(meta, "scale", 1.5);
  const center = readVec2(meta, "center", { x: 0.5, y: 0.5 });
  const keyframes: ZoomKeyframe[] = [
    { t_ms: clip.startMs, center, scale: 1.0, easing: "ease-in-out-cubic" },
    {
      t_ms: clip.startMs + clip.durationMs,
      center,
      scale,
      easing: "ease-in-out-cubic",
    },
  ];
  return {
    type: "zoom-pan",
    id: deterministicNodeId(clip.id, "zoom"),
    target,
    keyframes,
  };
}

function cursorOverlay(clip: Clip): VideoNode | null {
  const dir = readString(clip.metadata, "trajectoryDir");
  if (!dir) return null;
  const fps = readNumber(clip.metadata, "trajectoryFps", 60);
  const frameCount = readNumber(clip.metadata, "trajectoryFrameCount", 0);
  const skin = (clip.metadata?.skin as CursorSkin | undefined) ?? "mac-default";
  return {
    type: "cursor-overlay",
    id: deterministicNodeId(clip.id, "cursor"),
    skin,
    size_scale: readNumber(clip.metadata, "sizeScale", 1.0),
    color_tint: null,
    trajectory: { png_sequence_dir: dir, fps, frame_count: frameCount },
  };
}

function textBox(clip: Clip): TextBox | null {
  const text = readString(clip.metadata, "text");
  if (!text) return null;
  return {
    t_start_ms: clip.startMs,
    t_end_ms: clip.startMs + clip.durationMs,
    text,
    pos: readVec2(clip.metadata, "pos", { x: 0.5, y: 0.9 }),
    font: { kind: "system-default" },
    size_pt: readNumber(clip.metadata, "sizePt", 24),
    color: { r: 255, g: 255, b: 255, a: 255 },
    box_style: null,
    anim_in: "fade",
    anim_out: "fade",
  };
}

function audioSource(clip: Clip): AudioNode | null {
  const path = readString(clip.metadata, "path");
  if (!path) return null;
  return {
    type: "audio-source",
    id: deterministicNodeId(clip.id, "audio"),
    path,
    pts_offset_ms: clip.startMs,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function clipsByStart(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) =>
    a.startMs - b.startMs || a.id.localeCompare(b.id),
  );
}

/**
 * Project the timeline state into a Graph. Pure: no side effects, no IO.
 * The output is JSON-serializable (no bigints, no functions) and stable
 * across calls with equal input.
 *
 * Empty tracks ⇒ empty `video`/`audio` arrays. Clips whose metadata is
 * missing required fields (e.g. video without `sourcePath`, sound without
 * `path`) are skipped silently — the Export modal's `graphAvailable` flag
 * gates submission when nothing usable was produced.
 */
export function computeGraph(state: ComputeGraphInput): Graph {
  const { tracks, exportForm } = state;
  const px = RESOLUTION_PX[exportForm.resolution as ExportResolution] ?? RESOLUTION_PX["1080p"];

  const video: VideoNode[] = [];

  // Source nodes (one per video clip).
  for (const clip of clipsByStart(tracks.video)) {
    const n = videoSource(clip);
    if (n) video.push(n);
  }
  // ZoomPan nodes.
  for (const clip of clipsByStart(tracks.zoom)) {
    video.push(zoomPan(clip));
  }
  // Cursor overlays.
  for (const clip of clipsByStart(tracks.cursor)) {
    const n = cursorOverlay(clip);
    if (n) video.push(n);
  }
  // Text overlays — collapsed into a single TextOverlay node per Rust shape.
  const boxes: TextBox[] = [];
  for (const clip of clipsByStart(tracks.annotations)) {
    const b = textBox(clip);
    if (b) boxes.push(b);
  }
  if (boxes.length > 0) {
    // Use the first annotation clip id to keep the node id deterministic.
    const seedId = clipsByStart(tracks.annotations)[0]!.id;
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
