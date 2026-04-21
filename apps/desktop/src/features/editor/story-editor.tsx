import { useEffect, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";

import { storyEditorExtensions } from "./codemirror-setup";
import { editorController } from "./controller";
import { SelectorValidatorOverlay } from "./SelectorValidatorOverlay";
import { useEditorStore } from "@/state/editor";
import { parseStory } from "@/ipc/parse";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";

export interface EditorJumpTarget {
  offset: number;
  nonce: number;
}

interface StoryEditorProps {
  onAutosave?: (source: string) => void;
  jumpTarget?: EditorJumpTarget | null;
  /**
   * absolute project directory used to locate the
   * `.story.snapshots/` cache. When `null` the author-time validator
   * stays idle (no IPC calls).
   */
  projectDir?: string | null;
}

/**
 * Controlled CodeMirror editor wired to the DSL language pack + diagnostics
 * linter (UI-02). Autosave callback debounced 5s after last change; also
 * fires on blur.
 */
export function StoryEditor({ onAutosave, jumpTarget, projectDir }: StoryEditorProps) {
  const source = useEditorStore((s) => s.source);
  const setSource = useEditorStore((s) => s.setSource);
  const setLastParse = useEditorStore((s) => s.setLastParse);

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const autosave = useDebouncedCallback(
    (value: string) => onAutosave?.(value),
    5000,
  );

  const extensions = useMemo(() => storyEditorExtensions(), []);

  // Parse on every change so the timeline panel can re-render from AST.
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      parseStory(source)
        .then((r) => {
          if (!cancelled) setLastParse(r);
        })
        .catch(() => {
          /* ignored — linter displays the error */
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [source, setLastParse]);

  const handleChange = (value: string) => {
    setSource(value);
    if (onAutosave) autosave.run(value);
  };

  const handleBlur = () => {
    if (onAutosave) onAutosave(source);
  };

  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view || !jumpTarget) return;

    const pos = Math.max(0, Math.min(jumpTarget.offset, view.state.doc.length));
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }, [jumpTarget]);

  // register the active CodeMirror view with the
  // editorController singleton so the picker UI can insert at the
  // cursor. Cleared on unmount.
  useEffect(() => {
    editorController.setView(cmRef.current?.view ?? null);
    return () => {
      editorController.clearView();
    };
  }, [cmRef.current?.view]);

  return (
    <div
      className="h-full w-full overflow-hidden bg-transparent [&_.cm-editor]:h-full [&_.cm-editor]:bg-transparent [&_.cm-gutters]:border-r-0 [&_.cm-gutters]:bg-transparent [&_.cm-scroller]:font-mono [&_.cm-activeLine]:bg-[color-mix(in_oklch,var(--sc-accent-400)_8%,transparent)] [&_.cm-activeLineGutter]:bg-[color-mix(in_oklch,var(--sc-accent-400)_8%,transparent)] [&_.cm-cursor]:border-l-[var(--sc-accent-400)] [&_.cm-content]:py-5 [&_.cm-line]:px-2 [&_.cm-selectionBackground]:bg-[color-mix(in_oklch,var(--sc-accent-400)_22%,transparent)]"
      onBlur={handleBlur}
    >
      <CodeMirror
        ref={cmRef}
        value={source}
        height="100%"
        extensions={extensions}
        onChange={handleChange}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false, // provided by our own extension
          foldGutter: true,
        }}
        aria-label="Story DSL editor"
      />
      {/* author-time selector validator. Renders nothing
          visible; writes validation state into useSelectorValidation
          for the gutter markers + Preview panel bbox overlay. */}
      <SelectorValidatorOverlay projectDir={projectDir ?? null} />
    </div>
  );
}
