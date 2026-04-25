import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

export interface SetActiveFramePayload {
  ordinal: number | null;
  ordinalToLine: (ord: number) => number | null;
}

export const setActiveFrame = StateEffect.define<SetActiveFramePayload | null>();

const activeLineMark = Decoration.line({ class: "cm-simulator-active-step" });

export const simulatorDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setActiveFrame)) {
        const v = e.value;
        if (!v || v.ordinal === null) return Decoration.none;
        const line = v.ordinalToLine(v.ordinal);
        if (line === null || line < 1 || line > tr.state.doc.lines) {
          return Decoration.none;
        }
        const from = tr.state.doc.line(line).from;
        return Decoration.set([activeLineMark.range(from)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const simulatorDecorationTheme = EditorView.theme({
  ".cm-simulator-active-step": {
    backgroundColor: "color-mix(in oklch, var(--sc-accent-400) 12%, transparent)",
    borderLeft: "2px solid var(--sc-accent-400)",
  },
});

// Maps 1-based DSL step ordinal to a 1-based editor line number
// by walking the parsed AST's command spans. Returns null when the
// line is not inside any command span.
export function caretLineToOrdinal(
  ast: {
    scenes: Array<{
      commands: Array<{ span: { start_line: number; end_line: number } }>;
    }>;
  },
  line: number,
): number | null {
  let ord = 0;
  for (const scene of ast.scenes) {
    for (const cmd of scene.commands) {
      ord += 1;
      if (cmd.span.start_line <= line && line <= cmd.span.end_line) return ord;
    }
  }
  return null;
}

// Parse.ts Story shape uses `span.line` (single line per command). This
// helper walks the shipped AST directly and returns ordinal->line and
// the reverse mapping used by the CodeMirror decoration + keymap.
export function buildOrdinalLineMap(ast: {
  scenes: Array<{ commands: Array<{ span: { line: number } }> }>;
}): {
  ordinalToLine: (ord: number) => number | null;
  lineToOrdinal: (line: number) => number | null;
} {
  const lines: number[] = [];
  for (const scene of ast.scenes) {
    for (const cmd of scene.commands) lines.push(cmd.span.line);
  }
  return {
    ordinalToLine: (ord) => {
      if (ord < 1 || ord > lines.length) return null;
      return lines[ord - 1];
    },
    lineToOrdinal: (line) => {
      const idx = lines.indexOf(line);
      return idx === -1 ? null : idx + 1;
    },
  };
}
