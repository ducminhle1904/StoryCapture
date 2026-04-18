import { useEffect, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";

import { storyEditorExtensions } from "./codemirror-setup";
import { editorController } from "./controller";
import { useEditorStore } from "@/state/editor";
import { parseStory } from "@/ipc/parse";

export interface EditorJumpTarget {
  offset: number;
  nonce: number;
}

interface StoryEditorProps {
  onAutosave?: (source: string) => void;
  jumpTarget?: EditorJumpTarget | null;
}

/**
 * Controlled CodeMirror editor wired to the DSL language pack + diagnostics
 * linter (UI-02). Autosave callback debounced 5s after last change; also
 * fires on blur.
 */
export function StoryEditor({ onAutosave, jumpTarget }: StoryEditorProps) {
  const source = useEditorStore((s) => s.source);
  const setSource = useEditorStore((s) => s.setSource);
  const setLastParse = useEditorStore((s) => s.setLastParse);

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const autosaveTimer = useRef<number | null>(null);

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
    if (!onAutosave) return;
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => onAutosave(value), 5000);
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

  // Plan 07-03b — register the active CodeMirror view with the
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
      className="h-full w-full overflow-hidden bg-transparent [&_.cm-editor]:h-full [&_.cm-editor]:bg-transparent [&_.cm-gutters]:border-r-0 [&_.cm-gutters]:bg-transparent [&_.cm-scroller]:font-mono [&_.cm-activeLine]:bg-[var(--color-surface-100)] [&_.cm-activeLineGutter]:bg-[var(--color-surface-100)] [&_.cm-cursor]:border-l-[var(--color-accent-primary)] [&_.cm-content]:py-5 [&_.cm-line]:px-2 [&_.cm-selectionBackground]:bg-[rgba(255,107,115,0.22)]"
      onBlur={handleBlur}
    >
      <CodeMirror
        ref={cmRef}
        value={source}
        height="100%"
        theme="dark"
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
    </div>
  );
}
