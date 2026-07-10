/**
 * Undo slice. Owns:
 *   - A single `HistoryBuffer` instance (cap 50)
 *   - A single `Coalescer` instance (idle 500 ms)
 *   - `canUndo` / `canRedo` booleans kept in sync after every mutation
 *     so React components can subscribe cheaply
 *   - `pushAction` / `undo` / `redo` / `clearHistory` actions
 *
 * The buffer and coalescer are plain class instances; intentionally NOT
 * tracked by Zustand's shallow comparison — components should subscribe
 * to `canUndo` / `canRedo` or to the slice data actions mutate, never
 * to the buffer itself.
 *
 * Replays (undo/redo) go through `applyAction` which bypasses slice
 * setters, so snap logic does not re-mutate replayed values. The
 * coalescer is reset after every undo/redo so a post-undo action
 * cannot accidentally collapse into a pre-undo entry.
 */

import type { StateCreator } from "zustand";

import { applyAction, invertAction, type UndoableAction } from "../undo/actions";
import { Coalescer } from "../undo/coalesce";
import { HistoryBuffer } from "../undo/history-buffer";

export interface UndoSlice {
  /** Ring-buffer instance. Not reactive — subscribe to canUndo/canRedo. */
  history: HistoryBuffer;
  /** Coalescer instance. Not reactive. */
  coalescer: Coalescer;
  canUndo: boolean;
  canRedo: boolean;

  pushAction: (action: UndoableAction) => void;
  undo: () => void;
  redo: () => void;
  clearHistory: () => void;
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * Apply the inverse of a given action. The taxonomy is fully
 * round-trippable via `applyAction(invertAction(...))`; no special
 * cases.
 */
function applyInverse(action: UndoableAction): void {
  applyAction(invertAction(action));
}

export const createUndoSlice: StateCreator<UndoSlice, [], [], UndoSlice> = (set, get) => ({
  history: new HistoryBuffer(50),
  coalescer: new Coalescer(500),
  canUndo: false,
  canRedo: false,

  pushAction: (action) => {
    const { history, coalescer } = get();
    const result = coalescer.feed(action, nowMs());
    if (result.kind === "coalesced") {
      history.replaceTop(result.entry);
    } else {
      history.push(result.entry);
    }
    // Apply the action to the live state.
    applyAction(action);
    set({ canUndo: history.canUndo(), canRedo: history.canRedo() });
  },

  undo: () => {
    const { history, coalescer } = get();
    const entry = history.popUndo();
    if (!entry) return;
    applyInverse(entry.action);
    coalescer.reset();
    set({ canUndo: history.canUndo(), canRedo: history.canRedo() });
  },

  redo: () => {
    const { history, coalescer } = get();
    const entry = history.popRedo();
    if (!entry) return;
    applyAction(entry.action);
    coalescer.reset();
    set({ canUndo: history.canUndo(), canRedo: history.canRedo() });
  },

  clearHistory: () => {
    const { history, coalescer } = get();
    history.clear();
    coalescer.reset();
    set({ canUndo: false, canRedo: false });
  },
});
