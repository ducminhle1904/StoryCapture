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
// snapshot of the last-saved `.story` source; compared against the live
// CodeMirror doc text to answer `isDirty()` for the Phase 11-04 D-10
// "unsaved changes" warning.
let lastSavedSource: string | null = null;
// 1-indexed step-ordinal lookup (populated by StoryEditor via
// `setStepOrdinalLookup` after each parse). Returns null when the parser
// has not yet produced an ordinal map (e.g. very first render).
type StepOrdinalLookup = (line: number) => number | null;
let stepOrdinalLookup: StepOrdinalLookup | null = null;

export const editorController = {
  /** Register the active view. Called by StoryEditor on mount. */
  setView(view: EditorView | null) {
    currentView = view;
  },
  /** Drop the registered view. Called by StoryEditor on unmount. */
  clearView() {
    currentView = null;
  },
  /** Read the registered view (null when no editor is mounted). */
  getView(): EditorView | null {
    return currentView;
  },
  /** register the absolute path of the open `.story` file. */
  setStoryPath(path: string | null) {
    currentStoryPath = path;
  },
  /** read the currently open `.story` path (may be null). */
  getStoryPath(): string | null {
    return currentStoryPath;
  },
  /**
   * Record the source string that was most-recently persisted to disk.
   * Called by the editor shell after a successful autosave / manual save.
   * Phase 11-04 `PreviewPickerButton` diffs this against the live doc
   * text to surface the D-10 unsaved-changes warning.
   */
  markSaved(source: string): void {
    lastSavedSource = source;
  },
  /**
   * True iff the live CodeMirror doc differs from the last-saved
   * snapshot (or no save has yet been recorded). Returns false when no
   * view is mounted (nothing to compare).
   */
  isDirty(): boolean {
    const v = currentView;
    if (!v) return false;
    if (lastSavedSource === null) return false;
    return v.state.doc.toString() !== lastSavedSource;
  },
  /**
   * True iff a view is registered. */
  isReady(): boolean {
    return currentView !== null;
  },
  /**
   * Return the 1-indexed line number of the primary cursor, or null
   * when no view is mounted. Phase 11-04 `PreviewPickerButton` feeds
   * this to `picker_start_author_impl` so navigate-replay knows which
   * Navigate verbs to replay.
   */
  getCursorLine(): number | null {
    const v = currentView;
    if (!v) return null;
    const head = v.state.selection.main.head;
    return v.state.doc.lineAt(head).number;
  },
  /**
   * Register / clear the step-ordinal lookup driven by the most recent
   * parse. Called by StoryEditor whenever the AST updates.
   */
  setStepOrdinalLookup(lookup: StepOrdinalLookup | null): void {
    stepOrdinalLookup = lookup;
  },
  /**
   * 1-indexed step ordinal (among the flattened command list, across
   * scenes) for a given 1-indexed line number; null when the line is
   * not a command row or the parser has not yet populated the map.
   * Phase 11-04 uses this for the UI-SPEC re-pick toast
   * `Updated fallback for step {N}`.
   */
  getStepOrdinalForLine(line: number): number | null {
    return stepOrdinalLookup?.(line) ?? null;
  },
  /** Text of the line under the primary cursor (no trailing newline). */
  getCursorLineText(): string | null {
    const v = currentView;
    if (!v) return null;
    const head = v.state.selection.main.head;
    return v.state.doc.lineAt(head).text;
  },
  /**
   * Move the primary cursor to the start of `lineNumber` (1-indexed) and
   * focus the editor. No-op when out of range.
   */
  jumpToLine(lineNumber: number): boolean {
    const v = currentView;
    if (!v) return false;
    if (lineNumber < 1 || lineNumber > v.state.doc.lines) return false;
    const line = v.state.doc.line(lineNumber);
    v.dispatch({ selection: { anchor: line.from } });
    v.focus();
    return true;
  },
  /**
   * Replace the line under the primary cursor with `text`. Single dispatch
   * → single undo entry. Returns the line number of the replacement.
   */
  replaceCursorLine(
    text: string,
  ):
    | { ok: true; lineNumber: number }
    | { ok: false; reason: "no-view" } {
    const v = currentView;
    if (!v) return { ok: false, reason: "no-view" };
    const line = v.state.doc.lineAt(v.state.selection.main.head);
    v.dispatch({
      changes: { from: line.from, to: line.to, insert: text },
      selection: { anchor: line.from + text.length },
      userEvent: "input.pick",
    });
    v.focus();
    return { ok: true, lineNumber: line.number };
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
