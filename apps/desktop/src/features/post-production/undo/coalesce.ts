/**
 * Coalescer. Sequential actions that share a "coalesce key" (kind + id)
 * and land within COALESCE_IDLE_MS of each other collapse into a single
 * history entry. A drag that fires 60 pointermove events is one undo
 * step; 5 keystrokes in a text field within 500 ms idle are one undo
 * step; a 600 ms gap starts a new entry.
 *
 * Discrete actions (delete-clip, apply-preset, add-sound-clip,
 * change-background, revert-preset) NEVER coalesce — each is its own
 * step.
 *
 * The Coalescer does not own the history buffer. It returns a
 * `{ kind: 'coalesced' | 'new', entry }` discriminator so the caller
 * (the undo slice) knows whether to replace the buffer's top entry or
 * push a new one.
 */

import type { HistoryEntry } from "./history-buffer";
import type { UndoableAction } from "./actions";

export const COALESCE_IDLE_MS = 500;

export type CoalesceKey = string;

/**
 * Compute the coalesce key for an action, or `null` if the action is
 * discrete (never coalesces).
 */
export function coalesceKey(a: UndoableAction): CoalesceKey | null {
  switch (a.kind) {
    case "move-clip":
      return `move-clip:${a.trackId}:${a.clipId}`;
    case "trim-clip":
      return `trim-clip:${a.trackId}:${a.clipId}`;
    case "set-effect-param":
      return `set-effect-param:${a.nodePath}:${a.field}`;
    case "edit-text-overlay":
      return `edit-text-overlay:${a.overlayId}`;
    case "delete-clip":
    case "add-sound-clip":
    case "apply-preset":
    case "revert-preset":
    case "change-background":
      return null;
  }
}

/**
 * Merge two actions that share a coalesce key. Keeps the `from`/`prev`
 * values from the older action and the `to`/`next` values from the
 * newer action, so undo of the merged entry reverts the ENTIRE gesture
 * (not just the last delta).
 */
export function mergeActions(prev: UndoableAction, next: UndoableAction): UndoableAction {
  if (prev.kind !== next.kind) {
    // Should not happen when coalesceKey matches — defensive return.
    return next;
  }
  switch (next.kind) {
    case "move-clip": {
      const prevMv = prev as Extract<UndoableAction, { kind: "move-clip" }>;
      return {
        kind: "move-clip",
        trackId: next.trackId,
        clipId: next.clipId,
        fromMs: prevMv.fromMs,
        toMs: next.toMs,
      };
    }
    case "trim-clip": {
      const prevTr = prev as Extract<UndoableAction, { kind: "trim-clip" }>;
      return {
        kind: "trim-clip",
        trackId: next.trackId,
        clipId: next.clipId,
        fromRange: prevTr.fromRange,
        toRange: next.toRange,
      };
    }
    case "set-effect-param": {
      const prevSp = prev as Extract<UndoableAction, { kind: "set-effect-param" }>;
      return {
        kind: "set-effect-param",
        nodePath: next.nodePath,
        field: next.field,
        prev: prevSp.prev,
        next: next.next,
      };
    }
    case "edit-text-overlay": {
      const prevTx = prev as Extract<UndoableAction, { kind: "edit-text-overlay" }>;
      return {
        kind: "edit-text-overlay",
        overlayId: next.overlayId,
        prev: prevTx.prev,
        next: next.next,
      };
    }
    // Discrete kinds don't reach here (coalesceKey returns null).
    default:
      return next;
  }
}

export interface CoalesceResult {
  kind: "coalesced" | "new";
  entry: HistoryEntry;
}

export class Coalescer {
  private last: { key: CoalesceKey; entry: HistoryEntry } | null = null;

  constructor(private idleMs: number = COALESCE_IDLE_MS) {}

  /**
   * Feed a new action. Returns `coalesced` if the action extends an
   * open coalesce window, `new` otherwise.
   */
  feed(action: UndoableAction, now: number): CoalesceResult {
    const key = coalesceKey(action);
    if (
      key !== null &&
      this.last !== null &&
      this.last.key === key &&
      now - this.last.entry.appliedAt <= this.idleMs
    ) {
      const merged = mergeActions(this.last.entry.action, action);
      const entry: HistoryEntry = { action: merged, appliedAt: now };
      this.last = { key, entry };
      return { kind: "coalesced", entry };
    }
    const entry: HistoryEntry = { action, appliedAt: now };
    this.last = key !== null ? { key, entry } : null;
    return { kind: "new", entry };
  }

  /**
   * Reset the coalesce window. Called after undo/redo/clear so the next
   * action can't accidentally collapse into a pre-undo entry.
   */
  reset(): void {
    this.last = null;
  }
}
