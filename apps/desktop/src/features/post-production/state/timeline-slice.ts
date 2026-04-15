/**
 * Timeline slice (Plan 02-12a, D-12 + D-13).
 *
 * Owns the 5 fixed tracks (video / cursor / zoom / sound / annotations),
 * the playhead in ms, magnetic-snap configuration, and the total
 * duration. Users cannot add or remove tracks — the 5 tracks are baked
 * into the shape (D-12).
 *
 * Magnetic snap is ON by default (D-13). Snap targets are:
 *   1. the current playhead,
 *   2. scene boundaries (provided by the caller as an optional param),
 *   3. neighbour clip edges on the same track.
 *
 * The snap threshold is expressed in **pixels**; callers pass a
 * `pxPerMs` scaling factor so the slice stays display-independent.
 *
 * Holding Alt while dragging is surfaced at the UI layer as
 * `moveClip(..., { altHeld: true })`, which bypasses the snap logic for
 * that single call without flipping the persistent `snapEnabled` flag.
 */

import type { StateCreator } from "zustand";

/**
 * The 5 fixed track ids. Matches D-12 exactly — adding or renaming
 * these is a schema-level change and requires a plan.
 */
export const TRACK_IDS = ["video", "cursor", "zoom", "sound", "annotations"] as const;
export type TrackId = (typeof TRACK_IDS)[number];

/** Snap threshold in pixels (D-13). 10 px is the default tolerance. */
export const SNAP_THRESHOLD_PX = 10;

export interface Clip {
  id: string;
  trackId: TrackId;
  startMs: number;
  durationMs: number;
  /** Opaque payload the renderer/compositor interprets (asset id, label, etc). */
  metadata?: Record<string, unknown>;
}

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
  tracks: { video: Clip[]; cursor: Clip[]; zoom: Clip[]; sound: Clip[]; annotations: Clip[] };
  playheadMs: number;
  snapEnabled: boolean;
  durationMs: number;

  setPlayhead: (ms: number) => void;
  setDuration: (ms: number) => void;
  toggleSnap: () => void;
  setSnapEnabled: (on: boolean) => void;
  addSoundClip: (clip: Omit<Clip, "trackId"> & { trackId?: "sound" }) => void;
  moveClip: (
    trackId: TrackId,
    clipId: string,
    newStartMs: number,
    opts?: MoveClipOpts,
  ) => void;
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

export const createTimelineSlice: StateCreator<
  TimelineSlice,
  [],
  [],
  TimelineSlice
> = (set, get) => ({
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

  addSoundClip: (clip) =>
    set((s) => ({
      tracks: {
        ...s.tracks,
        sound: [...s.tracks.sound, { ...clip, trackId: "sound" } as Clip],
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
      tracks: {
        ...s.tracks,
        [trackId]: s.tracks[trackId].map((c) =>
          c.id === clipId ? { ...c, startMs: targetMs } : c,
        ),
      },
    }));
  },

  trimClip: (trackId, clipId, patch) =>
    set((s) => ({
      tracks: {
        ...s.tracks,
        [trackId]: s.tracks[trackId].map((c) =>
          c.id === clipId
            ? {
                ...c,
                startMs: patch.startMs !== undefined ? Math.max(0, patch.startMs) : c.startMs,
                durationMs:
                  patch.durationMs !== undefined
                    ? Math.max(0, patch.durationMs)
                    : c.durationMs,
              }
            : c,
        ),
      },
    })),

  deleteClip: (trackId, clipId) =>
    set((s) => ({
      tracks: {
        ...s.tracks,
        [trackId]: s.tracks[trackId].filter((c) => c.id !== clipId),
      },
    })),
});
