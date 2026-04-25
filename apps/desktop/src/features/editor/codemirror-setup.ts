/**
 * Assemble CodeMirror 6 extensions for the Story DSL editor (UI-02).
 *
 * Consumed by `story-editor.tsx` via `@uiw/react-codemirror`'s `extensions`
 * prop. Font/colors pulled from the global CSS tokens (see
 * `packages/ui/src/tokens.css`).
 */

import { indentUnit } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { storyDiagnosticsLinter } from "@/features/editor/diagnostics-bridge";
import { storyAutocomplete } from "@/features/editor/dsl-autocomplete";
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
 * Phase 11-04 keymap — Cmd-Shift-P on macOS / Ctrl-Shift-P elsewhere.
 * `Mod-Shift-p` is the CodeMirror 6 cross-platform alias. We dispatch
 * through the module-level `triggerPickFromEditor` which the mounted
 * `PreviewPickerButton` registers via `registerPickTrigger` in its
 * mount effect — a single implementation for keymap + click.
 *
 * NOT a global `document.addEventListener('keydown')` (research
 * anti-pattern): the CodeMirror keymap ensures the shortcut only fires
 * when the editor has focus, and composes cleanly with Prec priorities.
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

export function storyEditorExtensions(simulatorCtx?: SimulatorKeymapContext): Extension[] {
  return [
    storyDsl(),
    storyDiagnosticsLinter,
    storyAutocomplete,
    simulatorDecorationField,
    simulatorFailedStepField,
    simulatorFailedStepHover,
    simulatorDecorationTheme,
    ...(simulatorCtx ? [createSimulatorKeymap(simulatorCtx)] : []),
    pickKeymap,
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
        lineHeight: "1.5",
        padding: "20px 0",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--sc-text-4)",
        borderRight: "1px solid var(--sc-border-2)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "36px",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in oklch, var(--sc-accent-400) 8%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in oklch, var(--sc-accent-400) 16%, transparent)",
        color: "var(--sc-text)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--sc-accent-400)",
        borderLeftWidth: "1.5px",
      },
      ".cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "color-mix(in oklch, var(--sc-accent-400) 22%, transparent) !important",
      },
      ".cm-scroller": {
        backgroundColor: "var(--sc-surface)",
        fontFamily: "var(--sc-font-mono)",
      },
      ".cm-panels": {
        backgroundColor: "var(--sc-surface-2)",
        borderColor: "var(--sc-border)",
        color: "var(--sc-text)",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in oklch, var(--sc-warn) 24%, transparent)",
        outline: "1px solid color-mix(in oklch, var(--sc-warn) 40%, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in oklch, var(--sc-accent-400) 28%, transparent)",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: "color-mix(in oklch, var(--sc-accent-400) 16%, transparent)",
        outline: "1px solid color-mix(in oklch, var(--sc-accent-400) 35%, transparent)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--sc-surface-2)",
        borderColor: "var(--sc-border-2)",
        color: "var(--sc-text)",
        boxShadow: "var(--sc-sh-pop)",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "color-mix(in oklch, var(--sc-accent-400) 18%, transparent)",
        color: "var(--sc-text)",
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
      "&.cm-focused .cm-gutters": {
        color: "var(--sc-text-3)",
      },
    }),
  ];
}
