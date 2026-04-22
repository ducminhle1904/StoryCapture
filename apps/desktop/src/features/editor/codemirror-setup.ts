/**
 * Assemble CodeMirror 6 extensions for the Story DSL editor (UI-02).
 *
 * Consumed by `story-editor.tsx` via `@uiw/react-codemirror`'s `extensions`
 * prop. Font/colors pulled from the global CSS tokens (see
 * `packages/ui/src/tokens.css`).
 */

import { indentUnit } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { storyDsl } from "@/features/editor/dsl-language";
import { storyDiagnosticsLinter } from "@/features/editor/diagnostics-bridge";
import { storyAutocomplete } from "@/features/editor/dsl-autocomplete";

export function storyEditorExtensions(): Extension[] {
  return [
    storyDsl(),
    storyDiagnosticsLinter,
    storyAutocomplete,
    indentUnit.of("  "),
    EditorView.theme({
      "&": {
        height: "100%",
        backgroundColor: "var(--sc-surface)",
        color: "var(--sc-text)",
      },
      ".cm-content": {
        fontFamily: "var(--sc-font-mono)",
        fontSize: "13px",
        caretColor: "var(--sc-accent-400)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--sc-surface)",
        color: "var(--sc-text-4)",
        borderRight: "1px solid var(--sc-border)",
      },
      ".cm-activeLine": {
        backgroundColor: "var(--sc-surface-2)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--sc-surface-3)",
      },
      ".cm-diagnostic-error": {
        borderLeftColor: "var(--sc-record)",
      },
      ".cm-diagnostic-warning": {
        borderLeftColor: "var(--sc-warn)",
      },
      "&.cm-focused": {
        outline: "none",
      },
    }),
  ];
}
