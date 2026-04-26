/**
 * History ring buffer. In-memory ring capped at 50 entries. When the
 * buffer is full and a new entry is pushed, the oldest entry is evicted.
 * Pushing a new action after one or more undos truncates the forward
 * (redo) branch — standard redo-stack semantics.
 *
 * Not persisted to SQLite. Reloading the project resets history.
 */

import type { UndoableAction } from "./actions";

export const HISTORY_CAP = 50;

export interface HistoryEntry {
  action: UndoableAction;
  appliedAt: number;
}

export class HistoryBuffer {
  private entries: HistoryEntry[] = [];
  /** Index of the last APPLIED entry. -1 when empty. */
  private cursor = -1;

  constructor(private cap: number = 50) {}

  push(entry: HistoryEntry): void {
    // Truncate redo branch — any entries after the cursor are discarded
    // when a new action lands post-undo.
    if (this.cursor < this.entries.length - 1) {
      this.entries = this.entries.slice(0, this.cursor + 1);
    }
    this.entries.push(entry);
    // Evict oldest if over cap. Cursor is recomputed from length.
    if (this.entries.length > this.cap) {
      this.entries.shift();
    }
    this.cursor = this.entries.length - 1;
  }

  /**
   * Replace the top (current cursor) entry in-place. Used by the
   * Coalescer when a follow-up action extends the active coalesce
   * window. No cursor change, no redo-branch truncation.
   */
  replaceTop(entry: HistoryEntry): void {
    if (this.cursor < 0 || this.cursor >= this.entries.length) return;
    this.entries[this.cursor] = entry;
  }

  canUndo(): boolean {
    return this.cursor >= 0;
  }

  canRedo(): boolean {
    return this.cursor < this.entries.length - 1;
  }

  /**
   * Return the current undo entry and move the cursor back one.
   * Returns null when there is nothing to undo.
   */
  popUndo(): HistoryEntry | null {
    if (!this.canUndo()) return null;
    const entry = this.entries[this.cursor];
    this.cursor -= 1;
    return entry ?? null;
  }

  /**
   * Move the cursor forward one and return the now-current entry.
   * Returns null when there is nothing to redo.
   */
  popRedo(): HistoryEntry | null {
    if (!this.canRedo()) return null;
    this.cursor += 1;
    return this.entries[this.cursor] ?? null;
  }

  get length(): number {
    return this.entries.length;
  }

  get cursorPosition(): number {
    return this.cursor;
  }

  clear(): void {
    this.entries = [];
    this.cursor = -1;
  }

  /** Test-only: snapshot current entries (shallow copy). */
  snapshot(): readonly HistoryEntry[] {
    return this.entries.slice();
  }
}
