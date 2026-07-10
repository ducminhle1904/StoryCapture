import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, hoverTooltip } from "@codemirror/view";

export interface SetActiveFramePayload {
  ordinal: number | null;
  ordinalToLine: (ord: number) => number | null;
}

export interface SetFailedStepPayload {
  ordinal: number | null;
  errorMessage: string | null;
  ordinalToLine: (ord: number) => number | null;
}

export const setActiveFrame = StateEffect.define<SetActiveFramePayload | null>();
export const setFailedStep = StateEffect.define<SetFailedStepPayload | null>();

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

interface FailedStepState {
  line: number | null;
  errorMessage: string | null;
}

const failedLineMark = (errorMessage: string | null) =>
  Decoration.line({
    class: "cm-simulator-failed-step",
    attributes: errorMessage ? { "data-sim-error": errorMessage, title: errorMessage } : undefined,
  });

export const simulatorFailedStepField = StateField.define<FailedStepState>({
  create: () => ({ line: null, errorMessage: null }),
  update(state, tr) {
    let next = state;
    for (const e of tr.effects) {
      if (e.is(setFailedStep)) {
        const v = e.value;
        if (!v || v.ordinal === null) {
          next = { line: null, errorMessage: null };
          continue;
        }
        const line = v.ordinalToLine(v.ordinal);
        if (line === null || line < 1 || line > tr.state.doc.lines) {
          next = { line: null, errorMessage: v.errorMessage };
          continue;
        }
        next = { line, errorMessage: v.errorMessage };
      }
    }
    // Drop stale decoration once the user edits the underlying line.
    if (next.line != null && tr.docChanged) {
      if (next.line < 1 || next.line > tr.state.doc.lines) {
        next = { line: null, errorMessage: null };
      }
    }
    return next;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const { line, errorMessage } = state.field(f);
      if (line === null || line < 1 || line > state.doc.lines) {
        return Decoration.none;
      }
      const from = state.doc.line(line).from;
      return Decoration.set([failedLineMark(errorMessage).range(from)]);
    }),
});

export const simulatorFailedStepHover = hoverTooltip((view, pos) => {
  const { line, errorMessage } = view.state.field(simulatorFailedStepField);
  if (line === null || !errorMessage) return null;
  const docLine = view.state.doc.lineAt(pos);
  if (docLine.number !== line) return null;
  return {
    pos: docLine.from,
    end: docLine.to,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-simulator-failed-tooltip";
      dom.textContent = `Last simulator run failed here: ${errorMessage}`;
      return { dom };
    },
  };
});

export const simulatorDecorationTheme = EditorView.theme({
  ".cm-simulator-active-step": {
    backgroundColor: "color-mix(in oklch, var(--sc-accent-400) 12%, transparent)",
    borderLeft: "2px solid var(--sc-accent-400)",
  },
  ".cm-simulator-failed-step": {
    backgroundColor: "color-mix(in oklch, var(--sc-record) 14%, transparent)",
    borderLeft: "2px solid var(--sc-record)",
  },
  ".cm-simulator-failed-tooltip": {
    maxWidth: "420px",
    padding: "6px 8px",
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: "11px",
    color: "var(--sc-text)",
    backgroundColor: "var(--sc-surface-3)",
    border: "1px solid color-mix(in oklch, var(--sc-record) 50%, var(--sc-border))",
    borderRadius: "var(--radius-sm, 4px)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
    whiteSpace: "pre-wrap",
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
