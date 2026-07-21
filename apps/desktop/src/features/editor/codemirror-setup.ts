/**
 * Assemble CodeMirror 6 extensions for the Story DSL editor.
 * Consumed by `story-editor.tsx`. Font/colors come from the global
 * CSS tokens (see `packages/ui/src/tokens.css`).
 */

import { toggleLineComment } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { search } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { storyDiagnosticsLinter } from "@/features/editor/diagnostics-bridge";
import { storyAutocomplete } from "@/features/editor/dsl-autocomplete";
import { dslHoverTooltip } from "@/features/editor/dsl-hover";
import { storyDsl } from "@/features/editor/dsl-language";
import { triggerPickFromEditor } from "@/features/editor/PreviewPickerButton";
import {
  simulatorDecorationField,
  simulatorDecorationTheme,
  simulatorFailedStepField,
  simulatorFailedStepHover,
} from "@/features/editor/simulator-decoration";
import {
  createSimulatorKeymap,
  type SimulatorKeymapContext,
} from "@/features/editor/simulator-keymap";

/**
 * Pick-element keymap — Cmd-Shift-P on macOS / Ctrl-Shift-P elsewhere.
 * Dispatches through the module-level `triggerPickFromEditor` which the
 * mounted `PreviewPickerButton` registers, sharing one implementation
 * with the click handler.
 *
 * Not a global `document.addEventListener('keydown')`: the CodeMirror
 * keymap ensures the shortcut only fires when the editor has focus and
 * composes cleanly with Prec priorities.
 */
const pickKeymap = Prec.high(
  keymap.of([
    {
      key: "Mod-Shift-p",
      preventDefault: true,
      run: () => {
        triggerPickFromEditor();
        return true;
      },
    },
  ]),
);

const commentKeymap = keymap.of([{ key: "Mod-/", run: toggleLineComment, preventDefault: true }]);

export function storyEditorExtensions(simulatorCtx?: SimulatorKeymapContext): Extension[] {
  return [
    storyDsl(),
    storyDiagnosticsLinter,
    storyAutocomplete,
    dslHoverTooltip,
    simulatorDecorationField,
    simulatorFailedStepField,
    simulatorFailedStepHover,
    simulatorDecorationTheme,
    ...(simulatorCtx ? [createSimulatorKeymap(simulatorCtx)] : []),
    search({ top: true }),
    pickKeymap,
    commentKeymap,
    indentUnit.of("  "),
    EditorView.theme({
      "&": {
        height: "100%",
        backgroundColor: "var(--color-background-surface)",
        color: "var(--color-text-primary)",
      },
      ".cm-content": {
        fontFamily: "var(--font-family-code)",
        fontSize: "13px",
        caretColor: "var(--color-accent)",
        lineHeight: "1.5",
        padding: "20px 0",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--color-text-disabled)",
        borderRight: "1px solid var(--color-border-emphasized)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "36px",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in oklch, var(--color-accent) 8%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in oklch, var(--color-accent) 16%, transparent)",
        color: "var(--color-text-primary)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--color-accent)",
        borderLeftWidth: "1.5px",
      },
      ".cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "color-mix(in oklch, var(--color-accent) 22%, transparent) !important",
      },
      ".cm-scroller": {
        backgroundColor: "var(--color-background-surface)",
        fontFamily: "var(--font-family-code)",
      },
      ".cm-panels": {
        backgroundColor: "var(--color-background-card)",
        borderColor: "var(--color-border)",
        color: "var(--color-text-primary)",
      },
      ".cm-search.cm-panel": {
        padding: "6px 8px",
        borderBottom: "1px solid var(--color-border-emphasized)",
      },
      ".cm-search.cm-panel input, .cm-search.cm-panel button": {
        backgroundColor: "var(--color-background-surface)",
        color: "var(--color-text-primary)",
        border: "1px solid var(--color-border-emphasized)",
        borderRadius: "var(--radius-element)",
        padding: "2px 6px",
        fontFamily: "var(--font-family-code)",
        fontSize: "12px",
      },
      ".cm-search.cm-panel button:hover": {
        backgroundColor: "var(--color-overlay-hover)",
      },
      ".cm-search.cm-panel label": {
        color: "var(--color-text-secondary)",
        fontSize: "11px",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in oklch, var(--color-warning) 24%, transparent)",
        outline: "1px solid color-mix(in oklch, var(--color-warning) 40%, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in oklch, var(--color-accent) 28%, transparent)",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: "color-mix(in oklch, var(--color-accent) 16%, transparent)",
        outline: "1px solid color-mix(in oklch, var(--color-accent) 35%, transparent)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--color-background-card)",
        borderColor: "var(--color-border-emphasized)",
        color: "var(--color-text-primary)",
        boxShadow: "var(--shadow-high)",
      },
      ".cm-tooltip-keyword": {
        padding: "8px 10px",
        maxWidth: "320px",
        fontFamily: "var(--font-family-code)",
      },
      ".cm-tooltip-keyword .kw": {
        fontWeight: 600,
        fontSize: "12px",
        color: "var(--color-accent)",
      },
      ".cm-tooltip-keyword .desc": {
        marginTop: "2px",
        fontSize: "11.5px",
        color: "var(--color-text-secondary)",
        fontFamily: "var(--font-family-body, inherit)",
      },
      ".cm-tooltip-keyword .ex": {
        marginTop: "6px",
        padding: "4px 6px",
        background: "var(--color-background-surface)",
        border: "1px solid var(--color-border-emphasized)",
        borderRadius: "4px",
        fontSize: "11px",
        color: "var(--color-text-primary)",
        whiteSpace: "pre-wrap",
        margin: "6px 0 0",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "color-mix(in oklch, var(--color-accent) 18%, transparent)",
        color: "var(--color-text-primary)",
      },
      ".cm-diagnostic-error": {
        borderLeftColor: "var(--story-recording)",
      },
      ".cm-diagnostic-warning": {
        borderLeftColor: "var(--color-warning)",
      },
      "&.cm-focused": {
        outline: "none",
      },
      "&.cm-focused .cm-gutters": {
        color: "var(--color-text-secondary)",
      },
    }),
  ];
}
