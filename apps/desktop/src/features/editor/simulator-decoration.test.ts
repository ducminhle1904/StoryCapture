import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  setActiveFrame,
  simulatorDecorationField,
  caretLineToOrdinal,
} from "./simulator-decoration";

function countDecos(view: EditorView): number {
  const set = view.state.field(simulatorDecorationField);
  let n = 0;
  const iter = set.iter();
  while (iter.value) {
    n += 1;
    iter.next();
  }
  return n;
}

describe("simulator-decoration", () => {
  it("adds line decoration when setActiveFrame dispatched", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "line1\nline2\nline3\nline4",
        extensions: [simulatorDecorationField],
      }),
    });

    view.dispatch({
      effects: setActiveFrame.of({
        ordinal: 2,
        ordinalToLine: (ord) => ord,
      }),
    });

    expect(countDecos(view)).toBe(1);
  });

  it("clears decoration when setActiveFrame gets null", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "a\nb\nc",
        extensions: [simulatorDecorationField],
      }),
    });
    view.dispatch({
      effects: setActiveFrame.of({ ordinal: 1, ordinalToLine: () => 1 }),
    });
    expect(countDecos(view)).toBe(1);

    view.dispatch({ effects: setActiveFrame.of(null) });
    expect(countDecos(view)).toBe(0);
  });

  it("caretLineToOrdinal walks scene commands", () => {
    const ast = {
      scenes: [
        {
          commands: [
            { span: { start_line: 1, end_line: 1 } },
            { span: { start_line: 2, end_line: 2 } },
          ],
        },
        {
          commands: [{ span: { start_line: 5, end_line: 5 } }],
        },
      ],
    };
    expect(caretLineToOrdinal(ast, 1)).toBe(1);
    expect(caretLineToOrdinal(ast, 2)).toBe(2);
    expect(caretLineToOrdinal(ast, 5)).toBe(3);
    expect(caretLineToOrdinal(ast, 10)).toBeNull();
  });
});
