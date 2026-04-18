/**
 * editorController vitest.
 *
 * Constructs a real CodeMirror EditorView (with `history()` extension)
 * inside happy-dom and asserts the singleton's contract:
 *   1. isReady() reflects setView/clearView
 *   2. insertAtCursor returns { ok: false, reason: "no-view" } without throwing
 *      when no view is registered
 *   3. snap-to-line-end semantics on a mid-line cursor
 *   4. SINGLE undo entry — undo() restores the doc to its pre-insert state
 *      (proves the userEvent: "input.pick" + single dispatch is atomic)
 *   5. two consecutive inserts produce two undo entries (last-in undone first)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap, undo } from "@codemirror/commands";

import { editorController } from "./controller";

function makeView(doc = "abc\ndef"): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [history(), keymap.of(historyKeymap)],
  });
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  return new EditorView({ state, parent: dom });
}

describe("editorController", () => {
  let view: EditorView | null = null;

  beforeEach(() => {
    editorController.clearView();
  });

  afterEach(() => {
    editorController.clearView();
    if (view) {
      view.destroy();
      view = null;
    }
  });

  it("isReady() is false when no view is registered", () => {
    expect(editorController.isReady()).toBe(false);
  });

  it("insertAtCursor returns no-view without throwing when not ready", () => {
    const r = editorController.insertAtCursor("click testid \"x\"\n");
    expect(r).toEqual({ ok: false, reason: "no-view" });
  });

  it("snaps a mid-line cursor to line-end before inserting", () => {
    view = makeView("abc\ndef");
    editorController.setView(view);
    // Cursor at offset 0 (start of "abc") — mid-line.
    view.dispatch({ selection: { anchor: 0 } });

    const r = editorController.insertAtCursor("X");
    // lineNumber is now returned so `pickerStampStepId`
    // can stamp the UUIDv7 on the correct row; line 1 is where the
    // snap-to-end-of-line insertion lands.
    expect(r).toEqual({ ok: true, lineNumber: 1 });
    // Snapped to end of line 1 (offset 3), then "X" inserted.
    expect(view.state.doc.toString()).toBe("abcX\ndef");
    // Cursor lands at from + text.length = 3 + 1 = 4.
    expect(view.state.selection.main.head).toBe(4);
  });

  it("produces a SINGLE undo entry — undo() restores original doc", () => {
    view = makeView("abc\ndef");
    editorController.setView(view);
    view.dispatch({ selection: { anchor: 0 } });

    const original = view.state.doc.toString();
    editorController.insertAtCursor('click button "Save"\n');
    expect(view.state.doc.toString()).not.toBe(original);

    // Single undo must restore the doc — proves the dispatch was ONE
    // history entry (no split between change + selection).
    undo(view);
    expect(view.state.doc.toString()).toBe(original);
  });

  it("two inserts produce two undo entries (LIFO)", () => {
    view = makeView("abc\ndef");
    editorController.setView(view);
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    editorController.insertAtCursor("ONE");
    const afterFirst = view.state.doc.toString();
    editorController.insertAtCursor("TWO");
    expect(view.state.doc.toString()).not.toBe(afterFirst);

    undo(view);
    expect(view.state.doc.toString()).toBe(afterFirst);
  });
});
