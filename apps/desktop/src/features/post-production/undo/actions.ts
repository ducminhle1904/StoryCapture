/**
 * Undoable action taxonomy + apply/invert helpers. Every post-production
 * surface that can be undone is represented here. The DSL editor's own
 * history (CodeMirror) is intentionally NOT covered — it has its own
 * per-buffer history.
 *
 * Design:
 *   - Actions are self-contained value types. `applyAction` mutates the
 *     store via its exposed slice setters; `invertAction` produces the
 *     reverse action WITHOUT touching the store (pure function).
 *   - Move/trim store `fromMs`/`toMs` + `fromRange`/`toRange` so they can
 *     be coalesced by keeping `fromX` of the first event and `toX` of
 *     the latest.
 *   - `delete-clip` stores the full `Clip` snapshot so undo can restore
 *     the clip exactly — including metadata for cursor/zoom/annotation
 *     coverage.
 *   - `apply-preset` / `revert-preset` round-trip a `GraphSnapshot`
 *     opaque payload (we just store whatever the inspector hands us).
 *   - `edit-text-overlay` and `change-background` carry full `prev`/
 *     `next` snapshots so undo is O(1).
 *
 * Direct store manipulation uses `useEditorStore.setState` rather than
 * each slice's setter because the setters (e.g. `moveClip`) re-apply
 * snap logic. Undo/redo must be pixel-perfect replays of the original
 * value, so we bypass setters entirely.
 */

import type { Clip, TrackId } from "../state/timeline-slice";
import { useEditorStore } from "../state/store";

export type GraphSnapshot = Record<string, unknown>;
export type TextOverlay = Record<string, unknown>;
export type BackgroundKind = Record<string, unknown>;

export type ActionKind =
  | "move-clip"
  | "trim-clip"
  | "delete-clip"
  | "add-clip"
  | "add-sound-clip"
  | "set-effect-param"
  | "apply-preset"
  | "revert-preset"
  | "edit-text-overlay"
  | "change-background";

export type UndoableAction =
  | {
      kind: "move-clip";
      trackId: TrackId;
      clipId: string;
      fromMs: number;
      toMs: number;
    }
  | {
      kind: "trim-clip";
      trackId: TrackId;
      clipId: string;
      /** [startMs, durationMs] */
      fromRange: [number, number];
      /** [startMs, durationMs] */
      toRange: [number, number];
    }
  | {
      kind: "delete-clip";
      trackId: TrackId;
      clipId: string;
      /** Full snapshot so undo can restore exactly. */
      snapshot: Clip;
      /**
       * Index the clip occupied in its track before deletion. Captured
       * by `applyAction` if not provided, so the inverse `add-clip`
       * restores the clip at its original position.
       */
      atIndex?: number;
    }
  | {
      kind: "add-clip";
      trackId: TrackId;
      clip: Clip;
      /** Insertion index. If omitted, clip is appended. */
      atIndex?: number;
    }
  | {
      kind: "add-sound-clip";
      trackId: "sound";
      clip: Clip;
    }
  | {
      kind: "set-effect-param";
      /** dot-path into the store, e.g. "tracks.cursor[0].metadata.scale" */
      nodePath: string;
      field: string;
      prev: unknown;
      next: unknown;
    }
  | {
      kind: "apply-preset";
      prevGraphSnapshot: GraphSnapshot;
      nextPresetId: string;
    }
  | {
      kind: "revert-preset";
      prevPresetId: string;
      nextGraphSnapshot: GraphSnapshot;
    }
  | {
      kind: "edit-text-overlay";
      overlayId: string;
      prev: TextOverlay;
      next: TextOverlay;
    }
  | {
      kind: "change-background";
      prev: BackgroundKind;
      next: BackgroundKind;
    };

// ---------------------------------------------------------------------------
// External state surface for preset / overlay / background support.
// graphSnapshot, textOverlays, and background are stashed on a private
// `_undoExtras` bag inside the store until dedicated slices land; the
// action schema stays stable.
// ---------------------------------------------------------------------------

export interface UndoExtras {
  graphSnapshot: GraphSnapshot;
  textOverlays: Record<string, TextOverlay>;
  background: BackgroundKind;
}

export const DEFAULT_UNDO_EXTRAS: UndoExtras = {
  graphSnapshot: {},
  textOverlays: {},
  background: { kind: "transparent" },
};

function readExtras(): UndoExtras {
  const s = useEditorStore.getState() as unknown as {
    _undoExtras?: UndoExtras;
  };
  return s._undoExtras ?? DEFAULT_UNDO_EXTRAS;
}

function writeExtras(patch: Partial<UndoExtras>): void {
  const current = readExtras();
  useEditorStore.setState({
    _undoExtras: { ...current, ...patch },
  } as unknown as Partial<ReturnType<typeof useEditorStore.getState>>);
}

// ---------------------------------------------------------------------------
// Nested setter for `set-effect-param` (no immer; plain structural update).
// ---------------------------------------------------------------------------

/**
 * Parse a dot-path like `tracks.cursor[0].metadata.scale` into an array
 * of keys (numeric indexes for the `[n]` segments). Simple + sufficient
 * for inspector field paths; not a full JSON-Pointer implementation.
 */
export function parseNodePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /[^.[\]]+|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) out.push(Number(m[1]));
    else out.push(m[0]);
  }
  return out;
}

/**
 * Structural update at `path + field`. Returns a new root. Arrays are
 * cloned (via slice) and records via spread so React sees new refs.
 */
export function setAtPath(
  root: unknown,
  path: (string | number)[],
  field: string,
  value: unknown,
): unknown {
  if (path.length === 0) {
    if (typeof root !== "object" || root === null) return { [field]: value };
    if (Array.isArray(root)) return root; // ill-formed path, bail
    return { ...(root as Record<string, unknown>), [field]: value };
  }
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const idx = Number(head);
    const copy = root.slice();
    copy[idx] = setAtPath(copy[idx], rest, field, value);
    return copy;
  }
  if (typeof root === "object" && root !== null) {
    const rec = root as Record<string, unknown>;
    return { ...rec, [head as string]: setAtPath(rec[head as string], rest, field, value) };
  }
  // Non-indexable → initialise a fresh record.
  return { [head as string]: setAtPath(undefined, rest, field, value) };
}

// ---------------------------------------------------------------------------
// apply / invert
// ---------------------------------------------------------------------------

/**
 * Apply an action to the store. Mutates via `setState` directly —
 * bypasses slice setters so snap/normalisation logic doesn't mutate
 * replayed values.
 */
export function applyAction(action: UndoableAction): void {
  switch (action.kind) {
    case "move-clip": {
      useEditorStore.setState((s) => ({
        tracks: {
          ...s.tracks,
          [action.trackId]: s.tracks[action.trackId].map((c) =>
            c.id === action.clipId ? { ...c, startMs: action.toMs } : c,
          ),
        },
      }));
      return;
    }
    case "trim-clip": {
      useEditorStore.setState((s) => ({
        tracks: {
          ...s.tracks,
          [action.trackId]: s.tracks[action.trackId].map((c) =>
            c.id === action.clipId
              ? { ...c, startMs: action.toRange[0], durationMs: action.toRange[1] }
              : c,
          ),
        },
      }));
      return;
    }
    case "delete-clip": {
      // Capture the original index before splicing so the inverse
      // `add-clip` restores the clip at its exact prior position.
      if (action.atIndex === undefined) {
        const idx = useEditorStore
          .getState()
          .tracks[action.trackId].findIndex((c) => c.id === action.clipId);
        if (idx >= 0) action.atIndex = idx;
      }
      useEditorStore.setState((s) => ({
        tracks: {
          ...s.tracks,
          [action.trackId]: s.tracks[action.trackId].filter(
            (c) => c.id !== action.clipId,
          ),
        },
      }));
      return;
    }
    case "add-clip": {
      useEditorStore.setState((s) => {
        const track = s.tracks[action.trackId];
        const next = track.slice();
        const idx =
          action.atIndex !== undefined
            ? Math.max(0, Math.min(action.atIndex, next.length))
            : next.length;
        next.splice(idx, 0, action.clip);
        return {
          tracks: { ...s.tracks, [action.trackId]: next },
        };
      });
      return;
    }
    case "add-sound-clip": {
      useEditorStore.setState((s) => ({
        tracks: {
          ...s.tracks,
          sound: [...s.tracks.sound, action.clip],
        },
      }));
      return;
    }
    case "set-effect-param": {
      const path = parseNodePath(action.nodePath);
      useEditorStore.setState((s) => {
        // Apply structurally. If the path targets `tracks.*`, we update
        // `tracks`; otherwise we write into `_undoExtras` (graph/overlay
        // settings live there until dedicated slices land).
        if (path[0] === "tracks") {
          const nextTracks = setAtPath(
            s.tracks,
            path.slice(1),
            action.field,
            action.next,
          ) as typeof s.tracks;
          return { tracks: nextTracks };
        }
        const extras = (s as unknown as { _undoExtras?: UndoExtras })
          ._undoExtras ?? DEFAULT_UNDO_EXTRAS;
        const nextExtras = setAtPath(
          extras,
          path,
          action.field,
          action.next,
        ) as UndoExtras;
        return {
          _undoExtras: nextExtras,
        } as unknown as Partial<ReturnType<typeof useEditorStore.getState>>;
      });
      return;
    }
    case "apply-preset": {
      // For redo we re-apply the forward transition. We don't own the
      // preset→graph resolution; for the initial apply we just mark
      // the preset id as active. The graph snapshot follows via the
      // next action on the ring (the inspector pairs a
      // `set-effect-param` or direct graph mutation).
      useEditorStore.setState((s) => ({
        selectedPresetId: action.nextPresetId,
        _undoExtras: {
          ...((s as unknown as { _undoExtras?: UndoExtras })._undoExtras ??
            DEFAULT_UNDO_EXTRAS),
          // Keep prev graph — caller will replace via a separate action
          // if the preset changes graph contents.
        },
      }) as unknown as Partial<ReturnType<typeof useEditorStore.getState>>);
      return;
    }
    case "revert-preset": {
      useEditorStore.setState((s) => ({
        selectedPresetId: action.prevPresetId,
        _undoExtras: {
          ...((s as unknown as { _undoExtras?: UndoExtras })._undoExtras ??
            DEFAULT_UNDO_EXTRAS),
          graphSnapshot: action.nextGraphSnapshot,
        },
      }) as unknown as Partial<ReturnType<typeof useEditorStore.getState>>);
      return;
    }
    case "edit-text-overlay": {
      const extras = readExtras();
      writeExtras({
        textOverlays: { ...extras.textOverlays, [action.overlayId]: action.next },
      });
      return;
    }
    case "change-background": {
      writeExtras({ background: action.next });
      return;
    }
  }
}

/**
 * Return the inverse action. Pure — does not touch the store.
 */
export function invertAction(action: UndoableAction): UndoableAction {
  switch (action.kind) {
    case "move-clip":
      return {
        kind: "move-clip",
        trackId: action.trackId,
        clipId: action.clipId,
        fromMs: action.toMs,
        toMs: action.fromMs,
      };
    case "trim-clip":
      return {
        kind: "trim-clip",
        trackId: action.trackId,
        clipId: action.clipId,
        fromRange: action.toRange,
        toRange: action.fromRange,
      };
    case "delete-clip":
      // Reverse of a delete is a generic `add-clip` that restores the
      // snapshot to its original track at its original index. Works
      // uniformly across all tracks (video/cursor/zoom/sound/annotations).
      return {
        kind: "add-clip",
        trackId: action.trackId,
        clip: action.snapshot,
        atIndex: action.atIndex,
      };
    case "add-clip":
      return {
        kind: "delete-clip",
        trackId: action.trackId,
        clipId: action.clip.id,
        snapshot: action.clip,
        atIndex: action.atIndex,
      };
    case "add-sound-clip":
      return {
        kind: "delete-clip",
        trackId: "sound",
        clipId: action.clip.id,
        snapshot: action.clip,
      };
    case "set-effect-param":
      return {
        kind: "set-effect-param",
        nodePath: action.nodePath,
        field: action.field,
        prev: action.next,
        next: action.prev,
      };
    case "apply-preset":
      return {
        kind: "revert-preset",
        prevPresetId: action.nextPresetId,
        nextGraphSnapshot: action.prevGraphSnapshot,
      };
    case "revert-preset":
      return {
        kind: "apply-preset",
        prevGraphSnapshot: action.nextGraphSnapshot,
        nextPresetId: action.prevPresetId,
      };
    case "edit-text-overlay":
      return {
        kind: "edit-text-overlay",
        overlayId: action.overlayId,
        prev: action.next,
        next: action.prev,
      };
    case "change-background":
      return {
        kind: "change-background",
        prev: action.next,
        next: action.prev,
      };
  }
}

/**
 * Correctly invert a `delete-clip` across arbitrary tracks. Because the
 * action taxonomy does not include a generic "add-clip", we special-case
 * non-sound restorations here by writing directly to the store. Callers
 * use `restoreDeletedClip` from within the undo slice when the stored
 * action kind is `delete-clip`.
 */
export function restoreDeletedClip(action: Extract<UndoableAction, { kind: "delete-clip" }>): void {
  useEditorStore.setState((s) => ({
    tracks: {
      ...s.tracks,
      [action.trackId]: [...s.tracks[action.trackId], action.snapshot],
    },
  }));
}
