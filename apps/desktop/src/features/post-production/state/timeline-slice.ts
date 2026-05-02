/**
 * Timeline slice. Owns the 5 fixed tracks (video / cursor / zoom / sound /
 * annotations), the playhead in ms, magnetic-snap config, and total
 * duration. The 5 tracks are baked into the shape — users cannot add
 * or remove them.
 *
 * Magnetic snap is ON by default. Snap targets are:
 *   1. the current playhead,
 *   2. scene boundaries (provided by the caller as an optional param),
 *   3. neighbour clip edges on the same track.
 *
 * The snap threshold is expressed in **pixels**; callers pass a
 * `pxPerMs` scaling factor so the slice stays display-independent.
 *
 * Holding Alt while dragging surfaces at the UI layer as
 * `moveClip(..., { altHeld: true })`, bypassing the snap logic for that
 * single call without flipping the persistent `snapEnabled` flag.
 *
 * `Clip` is a discriminated union keyed on `trackId` so producer +
 * consumer share a schema. Each variant carries its own typed payload at
 * the top level — there is no opaque `metadata` bag.
 */

import type { StateCreator } from "zustand";

/**
 * The 5 fixed track ids. Adding or renaming these is a schema-level
 * change and requires a plan.
 */
export const TRACK_IDS = ["video", "cursor", "zoom", "sound", "annotations"] as const;
export type TrackId = (typeof TRACK_IDS)[number];

/** Snap threshold in pixels. 10 px is the default tolerance. */
export const SNAP_THRESHOLD_PX = 10;

// ---------------------------------------------------------------------------
// Shared shapes used by clip variants. Mirrors of the Rust-side AST shapes
// in `crates/effects/src/ast/`. Defined here (not in `compute-graph.ts`) so
// `timeline-slice.ts` is the single source of truth for editor state.
// ---------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

export type ZoomTarget =
  | { kind: "cursor" }
  | { kind: "fixed-region"; top_left: Vec2; size: Vec2 }
  | { kind: "element"; selector: string };

export type CursorSkin = "mac-default" | "win-default" | "dark" | "light" | "big-arrow";

export const CURSOR_MOTION_PRESETS = ["natural", "snappy", "cinematic"] as const;
export type CursorMotionPreset = (typeof CURSOR_MOTION_PRESETS)[number];

export function normalizeCursorMotionPreset(
  preset: CursorMotionPreset | undefined,
): CursorMotionPreset {
  return preset ?? "natural";
}

export type ZoomPreset = "DYNAMIC" | "CALM" | "SUBTLE";

export type SoundKind = "bgm" | "sfx" | "voiceover";

export const XFADE_KINDS = [
  "fade",
  "fade-black",
  "fade-white",
  "dissolve",
  "wipe-left",
  "wipe-right",
  "wipe-up",
  "wipe-down",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "circle-open",
  "circle-close",
] as const;

export type XfadeKind = (typeof XFADE_KINDS)[number];

export interface TransitionSpec {
  kind: XfadeKind;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Clip discriminated union
// ---------------------------------------------------------------------------

interface ClipBase {
  id: string;
  startMs: number;
  durationMs: number;
  /** Optional human-readable name. Falls back to `id` in the UI. */
  label?: string;
}

export interface VideoClip extends ClipBase {
  trackId: "video";
  /** Absolute or `convertFileSrc`-resolvable path to the source recording. */
  sourcePath: string;
  /** Optional transition from this clip into the next video clip. */
  outgoingTransition?: TransitionSpec;
}

export interface CursorClip extends ClipBase {
  trackId: "cursor";
  /** Cursor sidecar path or generated PNG-sequence directory. */
  trajectoryDir: string;
  trajectoryKind?: "actions" | "trajectory" | "png-sequence";
  trajectoryFps: number;
  trajectoryFrameCount: number;
  skin: CursorSkin;
  motionPreset?: CursorMotionPreset;
  /** Multiplier on the cursor's render size. 1.0 = native. */
  sizeScale: number;
  colorTint?: string | null;
}

export interface ZoomClip extends ClipBase {
  trackId: "zoom";
  target: ZoomTarget;
  scale: number;
  center: Vec2;
  preset?: ZoomPreset;
  easing?: string;
}

export interface SoundClip extends ClipBase {
  trackId: "sound";
  path: string;
  kind: SoundKind;
  gain?: number;
}

export interface AnnotationClip extends ClipBase {
  trackId: "annotations";
  text: string;
  pos: Vec2;
  sizePt: number;
  color?: string;
  highlight?: {
    center: Vec2;
    radiusPx: number;
    color?: string;
    durationMs?: number;
  };
}

export type Clip = VideoClip | CursorClip | ZoomClip | SoundClip | AnnotationClip;

/** Clips for a given track id, narrowed to the matching variant. */
export type ClipFor<K extends TrackId> = Extract<Clip, { trackId: K }>;

export interface MoveClipOpts {
  /** When true, bypass snap for this move even if `snapEnabled === true`. */
  altHeld?: boolean;
  /**
   * Optional external snap targets (scene boundaries). Measured in ms.
   * Callers typically pass scene-break timestamps from the parsed story.
   */
  extraSnapTargetsMs?: number[];
  /** Pixels-per-ms scale for converting the threshold. Defaults to 1 (1 px = 1 ms). */
  pxPerMs?: number;
}

export interface TimelineSlice {
  tracks: {
    video: VideoClip[];
    cursor: CursorClip[];
    zoom: ZoomClip[];
    sound: SoundClip[];
    annotations: AnnotationClip[];
  };
  playheadMs: number;
  snapEnabled: boolean;
  durationMs: number;

  setPlayhead: (ms: number) => void;
  setDuration: (ms: number) => void;
  toggleSnap: () => void;
  setSnapEnabled: (on: boolean) => void;
  /** Bulk track replacement. Untouched tracks are preserved. */
  setTracks: (patch: Partial<TimelineSlice["tracks"]>) => void;

  // Per-variant typed adders. Producers should prefer these over hand-built
  // generic Clip objects so the discriminator stays consistent.
  addVideoClip: (clip: Omit<VideoClip, "trackId"> & { trackId?: "video" }) => void;
  addCursorClip: (clip: Omit<CursorClip, "trackId"> & { trackId?: "cursor" }) => void;
  addZoomClip: (clip: Omit<ZoomClip, "trackId"> & { trackId?: "zoom" }) => void;
  addSoundClip: (clip: Omit<SoundClip, "trackId"> & { trackId?: "sound" }) => void;
  addAnnotationClip: (clip: Omit<AnnotationClip, "trackId"> & { trackId?: "annotations" }) => void;

  moveClip: (trackId: TrackId, clipId: string, newStartMs: number, opts?: MoveClipOpts) => void;
  trimClip: (
    trackId: TrackId,
    clipId: string,
    patch: { startMs?: number; durationMs?: number },
  ) => void;
  deleteClip: (trackId: TrackId, clipId: string) => void;
}

// ---------------------------------------------------------------------------
// Snap helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Compute the nearest snap target to `candidateMs`. Returns the target
 * if it falls within `threshold` ms, otherwise returns `candidateMs`
 * unchanged.
 */
export function snapToNearest(
  candidateMs: number,
  targetsMs: readonly number[],
  thresholdMs: number,
): number {
  if (targetsMs.length === 0 || thresholdMs <= 0) return candidateMs;
  let best = candidateMs;
  let bestDelta = thresholdMs + 1;
  for (const t of targetsMs) {
    const d = Math.abs(t - candidateMs);
    if (d <= thresholdMs && d < bestDelta) {
      best = t;
      bestDelta = d;
    }
  }
  return best;
}

function neighbourEdges(track: readonly Clip[], excludeId: string): number[] {
  const out: number[] = [];
  for (const c of track) {
    if (c.id === excludeId) continue;
    out.push(c.startMs);
    out.push(c.startMs + c.durationMs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slice factory
// ---------------------------------------------------------------------------

const initialTracks: TimelineSlice["tracks"] = {
  video: [],
  cursor: [],
  zoom: [],
  sound: [],
  annotations: [],
};

/**
 * Patches a clip (matched by id) inside one track. The patch callback
 * receives the narrowed variant and must return the same variant; we
 * cast at the boundary because TypeScript's flow-narrowing doesn't
 * preserve the discriminator across `tracks[trackId]` indexing.
 */
function patchClipInTrack<K extends TrackId>(
  tracks: TimelineSlice["tracks"],
  trackId: K,
  clipId: string,
  patch: (clip: ClipFor<K>) => ClipFor<K>,
): TimelineSlice["tracks"] {
  const next = (tracks[trackId] as ClipFor<K>[]).map((c) => (c.id === clipId ? patch(c) : c));
  return { ...tracks, [trackId]: next } as TimelineSlice["tracks"];
}

export const createTimelineSlice: StateCreator<TimelineSlice, [], [], TimelineSlice> = (
  set,
  get,
) => ({
  tracks: initialTracks,
  playheadMs: 0,
  snapEnabled: true,
  durationMs: 0,

  setPlayhead: (ms) => {
    const next = Math.max(0, ms);
    if (get().playheadMs === next) return;
    set({ playheadMs: next });
  },
  setDuration: (ms) => {
    const next = Math.max(0, ms);
    if (get().durationMs === next) return;
    set({ durationMs: next });
  },
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  setSnapEnabled: (on) => {
    if (get().snapEnabled === on) return;
    set({ snapEnabled: on });
  },
  setTracks: (patch) => set((s) => ({ tracks: { ...s.tracks, ...patch } })),

  addVideoClip: (clip) =>
    set((s) => ({
      tracks: {
        ...s.tracks,
        video: [...s.tracks.video, { ...clip, trackId: "video" }],
      },
    })),

  addCursorClip: (clip) =>
    set((s) => ({
      tracks: {
        ...s.tracks,
        cursor: [...s.tracks.cursor, { ...clip, trackId: "cursor" }],
      },
    })),

  addZoomClip: (clip) =>
    set((s) => ({
      tracks: {
        ...s.tracks,
        zoom: [...s.tracks.zoom, { ...clip, trackId: "zoom" }],
      },
    })),

  addSoundClip: (clip) =>
    set((s) => ({
      tracks: {
        ...s.tracks,
        sound: [...s.tracks.sound, { ...clip, trackId: "sound" }],
      },
    })),

  addAnnotationClip: (clip) =>
    set((s) => ({
      tracks: {
        ...s.tracks,
        annotations: [...s.tracks.annotations, { ...clip, trackId: "annotations" }],
      },
    })),

  moveClip: (trackId, clipId, newStartMs, opts) => {
    const state = get();
    const track = state.tracks[trackId];
    const pxPerMs = opts?.pxPerMs ?? 1;
    const thresholdMs = SNAP_THRESHOLD_PX / Math.max(pxPerMs, Number.EPSILON);

    let targetMs = Math.max(0, newStartMs);
    const useSnap = state.snapEnabled && !opts?.altHeld;
    if (useSnap) {
      const targets: number[] = [
        state.playheadMs,
        ...(opts?.extraSnapTargetsMs ?? []),
        ...neighbourEdges(track, clipId),
      ];
      targetMs = snapToNearest(targetMs, targets, thresholdMs);
    }

    set((s) => ({
      tracks: patchClipInTrack(s.tracks, trackId, clipId, (c) => ({
        ...c,
        startMs: targetMs,
      })),
    }));
  },

  trimClip: (trackId, clipId, patch) =>
    set((s) => ({
      tracks: patchClipInTrack(s.tracks, trackId, clipId, (c) => ({
        ...c,
        startMs: patch.startMs !== undefined ? Math.max(0, patch.startMs) : c.startMs,
        durationMs: patch.durationMs !== undefined ? Math.max(0, patch.durationMs) : c.durationMs,
      })),
    })),

  deleteClip: (trackId, clipId) =>
    set((s) => ({
      tracks: {
        ...s.tracks,
        [trackId]: (s.tracks[trackId] as Clip[]).filter((c) => c.id !== clipId),
      } as TimelineSlice["tracks"],
    })),
});
