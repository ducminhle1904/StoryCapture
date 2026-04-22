import { AnimatePresence, motion } from "motion/react";
import { Play } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { storyEditorExtensions } from "./codemirror-setup";
import { editorController } from "./controller";
import { SelectorValidatorOverlay } from "./SelectorValidatorOverlay";
import {
  buildOrdinalLineMap,
  setActiveFrame,
} from "./simulator-decoration";
import { simulatorCancel } from "@/ipc/simulator";
import { useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulatorStore";
import { parseStory } from "@/ipc/parse";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";

export interface EditorJumpTarget {
  offset: number;
  nonce: number;
}

interface StoryEditorProps {
  onAutosave?: (source: string) => void;
  jumpTarget?: EditorJumpTarget | null;
  projectDir?: string | null;
  projectFolder?: string | null;
  storyPath?: string | null;
  streamId?: string | null;
}

export function StoryEditor({
  onAutosave,
  jumpTarget,
  projectDir,
  projectFolder,
  storyPath,
  streamId,
}: StoryEditorProps) {
  const source = useEditorStore((s) => s.source);
  const setSource = useEditorStore((s) => s.setSource);
  const setLastParse = useEditorStore((s) => s.setLastParse);

  const runState = useSimulatorStore((s) => s.runState);
  const currentOrd = useSimulatorStore((s) => s.currentFrameOrdinal);
  const totalSteps = useSimulatorStore((s) => s.totalSteps);
  const sessionId = useSimulatorStore((s) => s.sessionId);
  const simulatorActive = runState === "running";

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const autosave = useDebouncedCallback(
    (value: string) => onAutosave?.(value),
    5000,
  );

  // Keep latest prop/store values in refs so simulator keymap (which captures
  // these once at extension build time) always reads fresh data.
  const projectFolderRef = useRef(projectFolder);
  const storyPathRef = useRef(storyPath);
  const streamIdRef = useRef(streamId);
  projectFolderRef.current = projectFolder;
  storyPathRef.current = storyPath;
  streamIdRef.current = streamId;

  const extensions = useMemo(
    () =>
      storyEditorExtensions({
        getProjectFolder: () => projectFolderRef.current ?? null,
        getStoryPath: () => storyPathRef.current ?? null,
        getStreamId: () => streamIdRef.current ?? null,
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      parseStory(source)
        .then((r) => {
          if (!cancelled) setLastParse(r);
        })
        .catch(() => {
          /* linter reports */
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [source, setLastParse]);

  // Sync CodeMirror line decoration with currentFrameOrdinal.
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const ast = useEditorStore.getState().lastParse?.ast ?? null;
    if (!ast) {
      view.dispatch({ effects: setActiveFrame.of(null) });
      return;
    }
    const { ordinalToLine } = buildOrdinalLineMap(
      ast as unknown as { scenes: Array<{ commands: Array<{ span: { line: number } }> }> },
    );
    view.dispatch({
      effects: setActiveFrame.of({ ordinal: currentOrd, ordinalToLine }),
    });
  }, [currentOrd]);

  const handleChange = (value: string) => {
    if (simulatorActive) return;
    setSource(value);
    if (onAutosave) autosave.run(value);
  };

  const handleBlur = () => {
    if (!simulatorActive && onAutosave) onAutosave(source);
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

  useEffect(() => {
    editorController.setView(cmRef.current?.view ?? null);
    return () => {
      editorController.clearView();
    };
  }, [cmRef.current?.view]);

  // Dynamic readOnly compartment via EditorState.readOnly facet:
  // feed through extensions array, re-assigning on run state change.
  const readOnlyExtensions = useMemo(
    () => [...extensions, EditorState.readOnly.of(simulatorActive)],
    [extensions, simulatorActive],
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <AnimatePresence>
        {runState === "running" && (
          <motion.div
            key="simulator-banner"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            role="status"
            aria-live="polite"
            className="sticky top-0 z-10 flex h-8 items-center justify-between bg-[var(--color-surface-300)] px-3 text-[13px] font-medium text-[var(--color-fg-primary)]"
          >
            <span className="flex items-center gap-2">
              <Play size={14} aria-hidden="true" />
              {`Simulator running — edits paused · Step ${currentOrd ?? "—"} / ${totalSteps}`}
            </span>
            <button
              type="button"
              onClick={() => sessionId && void simulatorCancel(sessionId)}
              aria-label="Cancel simulator run"
              className="rounded-[var(--radius-xs)] px-2 py-0.5 text-xs hover:bg-[var(--color-danger)]/12"
            >
              Cancel
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className="h-full w-full flex-1 overflow-hidden bg-transparent [&_.cm-editor]:h-full [&_.cm-editor]:bg-transparent [&_.cm-gutters]:border-r-0 [&_.cm-gutters]:bg-transparent [&_.cm-scroller]:font-mono [&_.cm-activeLine]:bg-[color-mix(in_oklch,var(--sc-accent-400)_8%,transparent)] [&_.cm-activeLineGutter]:bg-[color-mix(in_oklch,var(--sc-accent-400)_8%,transparent)] [&_.cm-cursor]:border-l-[var(--sc-accent-400)] [&_.cm-content]:py-5 [&_.cm-line]:px-2 [&_.cm-selectionBackground]:bg-[color-mix(in_oklch,var(--sc-accent-400)_22%,transparent)]"
        onBlur={handleBlur}
      >
        <CodeMirror
          ref={cmRef}
          value={source}
          height="100%"
          extensions={readOnlyExtensions}
          onChange={handleChange}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
            foldGutter: true,
          }}
          aria-label="Story DSL editor"
        />
        <SelectorValidatorOverlay projectDir={projectDir ?? null} />
      </div>
    </div>
  );
}
