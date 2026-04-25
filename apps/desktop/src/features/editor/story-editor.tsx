import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { parseStory } from "@/ipc/parse";
import { simulatorCancel } from "@/ipc/simulator";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";
import { useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulator-store";
import { storyEditorExtensions } from "./codemirror-setup";
import { editorController } from "./controller";
import { SelectorValidatorOverlay } from "./SelectorValidatorOverlay";
import { buildOrdinalLineMap, setActiveFrame } from "./simulator-decoration";

function trimTrailingWhitespace(s: string): string {
  return s.replace(/[ \t]+$/gm, "");
}

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
  onCursorChange?: (pos: { line: number; col: number } | null) => void;
}

export function StoryEditor({
  onAutosave,
  jumpTarget,
  projectDir,
  projectFolder,
  storyPath,
  streamId,
  onCursorChange,
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
  const sourceRef = useRef(source);
  const simulatorActiveRef = useRef(simulatorActive);
  const saveSourceRef = useRef<(value: string) => void>(() => {});
  const projectFolderRef = useRef(projectFolder);
  const storyPathRef = useRef(storyPath);
  const streamIdRef = useRef(streamId);
  sourceRef.current = source;
  simulatorActiveRef.current = simulatorActive;
  saveSourceRef.current = (value) => onAutosave?.(trimTrailingWhitespace(value));
  projectFolderRef.current = projectFolder;
  storyPathRef.current = storyPath;
  streamIdRef.current = streamId;
  const autosave = useDebouncedCallback((value: string) => saveSourceRef.current(value), 5000);
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;

  // These CodeMirror extensions are created once, so callbacks read fresh
  // prop/store values through refs.
  const extensions = useMemo(
    () =>
      storyEditorExtensions({
        getProjectFolder: () => projectFolderRef.current ?? null,
        getStoryPath: () => storyPathRef.current ?? null,
        getStreamId: () => streamIdRef.current ?? null,
      }),
    [],
  );
  const blurAutosaveExtension = useMemo(
    () =>
      EditorView.domEventHandlers({
        blur: () => {
          if (!simulatorActiveRef.current) {
            autosaveRef.current.cancel();
            saveSourceRef.current(sourceRef.current);
          }
        },
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
    return () => editorController.clearView();
  }, []);
  const handleCreateEditor = useCallback((view: EditorView) => {
    editorController.setView(view);
  }, []);

  const readOnlyCompartment = useMemo(() => new Compartment(), []);
  const allExtensions = useMemo(
    () => [
      ...extensions,
      blurAutosaveExtension,
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
    ],
    [extensions, blurAutosaveExtension, readOnlyCompartment],
  );

  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(simulatorActive)),
    });
  }, [simulatorActive, readOnlyCompartment]);

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

      <div className="h-full w-full flex-1 overflow-hidden">
        <CodeMirror
          ref={cmRef}
          value={source}
          height="100%"
          theme="none"
          className="h-full"
          indentWithTab
          extensions={allExtensions}
          onCreateEditor={handleCreateEditor}
          onChange={handleChange}
          onUpdate={(v) => {
            if (!onCursorChange) return;
            if (!v.selectionSet && !v.docChanged) return;
            const head = v.state.selection.main.head;
            const line = v.state.doc.lineAt(head);
            onCursorChange({ line: line.number, col: head - line.from + 1 });
          }}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
            foldGutter: true,
            searchKeymap: true,
          }}
          aria-label="Story DSL editor"
        />
        <SelectorValidatorOverlay projectDir={projectDir ?? null} />
      </div>
    </div>
  );
}
