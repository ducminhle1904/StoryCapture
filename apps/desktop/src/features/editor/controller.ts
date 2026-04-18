/**
 * editorController — module-level singleton bridge between the picker
 * UI and the active CodeMirror EditorView (Plan 07-03b).
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

export const editorController = {
  /** Register the active view. Called by StoryEditor on mount. */
  setView(view: EditorView | null) {
    currentView = view;
  },
  /** Drop the registered view. Called by StoryEditor on unmount. */
  clearView() {
    currentView = null;
  },
  /** True iff a view is registered. */
  isReady(): boolean {
    return currentView !== null;
  },
  /**
   * Insert `text` at the current cursor (snap to line-end if mid-line).
   * Single dispatch — single undo entry. Returns `{ ok: false, reason: "no-view" }`
   * without throwing when no view is registered (e.g. user invoked the
   * picker before the editor mounted).
   */
  insertAtCursor(
    text: string,
  ): { ok: true } | { ok: false; reason: "no-view" } {
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
    return { ok: true };
  },
};

export type EditorController = typeof editorController;
