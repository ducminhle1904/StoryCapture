/**
 * editorController — module-level singleton bridge between the picker
 * UI and the active CodeMirror EditorView.
 *
 * NOT a React context, NOT in Zustand. React refs in Zustand are an
 * anti-pattern (don't trigger re-renders, leak imperative state into
 * the store surface). A module singleton is the right seam for a
 * one-of-a-kind imperative target.
 *
 * Insertion semantics (CONTEXT.md §Tier 2 MVP §Insertion semantics):
 *   - Single `view.dispatch({ changes, selection, userEvent: "input.pick" })`
 *     — atomic on the undo stack.
 *   - Snap mid-line cursors to line-end before insertion.
 *   - Caller appends `"\n"` to the emitted DSL (we don't double-newline).
 *   - Cursor lands at `from + text.length` (just past inserted text).
 */

import type { EditorView } from "@codemirror/view";

let currentView: EditorView | null = null;
// the on-disk path of the story currently edited, used by
// `picker_stamp_step_id` to locate the sibling `.story.targets.json`.
// Null when the editor is showing unsaved / in-memory content.
let currentStoryPath: string | null = null;

export const editorController = {
  /** Register the active view. Called by StoryEditor on mount. */
  setView(view: EditorView | null) {
    currentView = view;
  },
  /** Drop the registered view. Called by StoryEditor on unmount. */
  clearView() {
    currentView = null;
  },
  /** register the absolute path of the open `.story` file. */
  setStoryPath(path: string | null) {
    currentStoryPath = path;
  },
  /** read the currently open `.story` path (may be null). */
  getStoryPath(): string | null {
    return currentStoryPath;
  },
  /** True iff a view is registered. */
  isReady(): boolean {
    return currentView !== null;
  },
  /**
   * Insert `text` at the current cursor (snap to line-end if mid-line).
   * Single dispatch — single undo entry.
   *
   * on success returns `{ ok: true, lineNumber }` where
   * `lineNumber` is 1-indexed and identifies the line the inserted DSL
   * now lives on (i.e. the line of the first character of the inserted
   * text, NOT the snap-origin). Callers use this to invoke
   * `picker_stamp_step_id` so the UUIDv7 is stamped on the correct row.
   */
  insertAtCursor(
    text: string,
  ):
    | { ok: true; lineNumber: number }
    | { ok: false; reason: "no-view" } {
    const v = currentView;
    if (!v) return { ok: false, reason: "no-view" };

    const sel = v.state.selection.main;
    const line = v.state.doc.lineAt(sel.head);
    // Snap mid-line cursors to line-end before insertion.
    const from = sel.head === line.to ? sel.head : line.to;

    v.dispatch({
      changes: { from, insert: text },
      selection: { anchor: from + text.length },
      userEvent: "input.pick",
    });
    v.focus();
    // After insertion, the inserted DSL's first character sits at `from`
    // on the NEW document. `lineAt(from)` now points at the inserted row.
    // If `from` was at the end of a pre-existing line (common case — we
    // snap to line-end), the insert begins on a fresh line when the
    // previous document had no trailing newline; otherwise it replaces
    // the next line's leading boundary. Either way, lineAt(from) names
    // the row where the new text begins.
    const insertedLine = v.state.doc.lineAt(from).number;
    return { ok: true, lineNumber: insertedLine };
  },
};

export type EditorController = typeof editorController;
