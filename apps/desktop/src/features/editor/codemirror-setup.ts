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
        backgroundColor: "var(--color-bg-primary)",
        color: "var(--color-fg-primary)",
      },
      ".cm-content": {
        fontFamily: "var(--font-mono)",
        fontSize: "13px",
        caretColor: "var(--color-accent-primary)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--color-bg-surface)",
        color: "var(--color-fg-muted)",
        borderRight: "1px solid var(--color-border-subtle)",
      },
      ".cm-activeLine": {
        backgroundColor: "var(--color-bg-surface)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--color-bg-elevated)",
      },
      ".cm-diagnostic-error": {
        borderLeftColor: "var(--color-danger)",
      },
      ".cm-diagnostic-warning": {
        borderLeftColor: "var(--color-warning)",
      },
      "&.cm-focused": {
        outline: "none",
      },
    }),
  ];
}
