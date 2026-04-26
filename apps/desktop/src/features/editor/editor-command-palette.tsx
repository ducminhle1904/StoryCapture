import { toggleLineComment } from "@codemirror/commands";
import { ScKbd } from "@storycapture/ui";
import { Command } from "cmdk";
import {
  AlertTriangle,
  Crosshair,
  Eraser,
  GitBranch,
  Hash,
  ListOrdered,
  MessageSquare,
  Play,
  Search,
  SkipForward,
  StepForward,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { toast } from "sonner";

import type { Story } from "@/ipc/parse";
import {
  simulatorCancel,
  simulatorStart,
  simulatorStepTo,
} from "@/ipc/simulator";
import { useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulator-store";

import { editorController } from "./controller";
import { normalizeForSave } from "./normalize-source";
import { triggerPickFromEditor } from "./PreviewPickerButton";
import { useProblemsPanelStore } from "./problems-panel";
import { buildOrdinalLineMap } from "./simulator-decoration";

type Mode = "root" | "scene" | "step" | "line";

interface PaletteCommand {
  id: string;
  label: string;
  group: "Navigate" | "Edit" | "Run" | "View";
  icon: React.ReactNode;
  kbd?: string;
  when?: () => boolean;
  run: () => void;
}

interface EditorCommandPaletteProps {
  story: Story | null;
  projectFolder: string | null;
  storyPath: string | null;
  streamId: string | null;
  onJumpToOffset: (offset: number) => void;
}

function flattenSteps(story: Story): Array<{
  sceneIndex: number;
  sceneName: string;
  stepIndex: number;
  globalOrdinal: number;
  verb: string;
  offset: number;
}> {
  const out: ReturnType<typeof flattenSteps> = [];
  let ord = 0;
  story.scenes.forEach((scene, sceneIndex) => {
    scene.commands.forEach((cmd, stepIndex) => {
      ord += 1;
      out.push({
        sceneIndex,
        sceneName: scene.name?.trim().length ? scene.name : `Scene ${sceneIndex + 1}`,
        stepIndex,
        globalOrdinal: ord,
        verb: cmd.verb,
        offset: cmd.span.start,
      });
    });
  });
  return out;
}

export function EditorCommandPalette({
  story,
  projectFolder,
  storyPath,
  streamId,
  onJumpToOffset,
}: EditorCommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("root");
  const [lineInput, setLineInput] = useState("");

  const close = useCallback(() => {
    setOpen(false);
    setMode("root");
    setLineInput("");
  }, []);

  useHotkeys(
    "mod+shift+k",
    (e) => {
      e.preventDefault();
      setOpen((v) => {
        if (v) {
          setMode("root");
          setLineInput("");
        }
        return !v;
      });
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  );

  const runState = useSimulatorStore((s) => s.runState);
  const sessionId = useSimulatorStore((s) => s.sessionId);
  const toggleProblems = useProblemsPanelStore((s) => s.toggle);
  const simRunning = runState === "running";

  const startSim = useCallback(
    (stopAfterOrdinal?: number) => {
      if (!streamId || !projectFolder || !storyPath) {
        toast.warning("Live Preview not ready — open the preview first");
        return;
      }
      const storySource = useEditorStore.getState().source;
      if (runState === "paused" && sessionId && stopAfterOrdinal != null) {
        void simulatorStepTo(sessionId, stopAfterOrdinal);
        return;
      }
      void simulatorStart(
        { projectFolder, storySource, storyPath, streamId, stopAfterOrdinal },
        (ev) => useSimulatorStore.getState().handleEvent(ev),
      );
    },
    [streamId, projectFolder, storyPath, runState, sessionId],
  );

  const runToCursor = useCallback(() => {
    const view = editorController.getView();
    if (!view || !story) {
      toast.warning("No editor or story available");
      return;
    }
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const { lineToOrdinal } = buildOrdinalLineMap(
      story as unknown as { scenes: Array<{ commands: Array<{ span: { line: number } }> }> },
    );
    const ord = lineToOrdinal(line);
    if (ord == null) {
      toast.warning("Cursor is not on an executable step");
      return;
    }
    startSim(ord);
  }, [story, startSim]);

  const cancelSim = useCallback(() => {
    if (sessionId) void simulatorCancel(sessionId);
  }, [sessionId]);

  const toggleComment = useCallback(() => {
    const view = editorController.getView();
    if (!view) return;
    toggleLineComment(view);
    view.focus();
  }, []);

  const formatDoc = useCallback(() => {
    const view = editorController.getView();
    if (!view) return;
    const current = view.state.doc.toString();
    const next = normalizeForSave(current);
    if (next === current) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
      userEvent: "format",
    });
    view.focus();
  }, []);

  const rootCommands: PaletteCommand[] = useMemo(() => {
    const all: PaletteCommand[] = [
      {
        id: "nav-scene",
        label: "Go to Scene…",
        group: "Navigate",
        icon: <GitBranch size={13} />,
        when: () => Boolean(story && story.scenes.length > 0),
        run: () => setMode("scene"),
      },
      {
        id: "nav-step",
        label: "Go to Step…",
        group: "Navigate",
        icon: <ListOrdered size={13} />,
        when: () => Boolean(story && story.scenes.some((s) => s.commands.length > 0)),
        run: () => setMode("step"),
      },
      {
        id: "nav-line",
        label: "Go to Line…",
        group: "Navigate",
        icon: <Hash size={13} />,
        run: () => setMode("line"),
      },
      {
        id: "edit-comment",
        label: "Toggle Line Comment",
        group: "Edit",
        icon: <MessageSquare size={13} />,
        kbd: "⌘/",
        when: () => editorController.getView() != null && !simRunning,
        run: () => {
          toggleComment();
          close();
        },
      },
      {
        id: "edit-format",
        label: "Format / Normalize Whitespace",
        group: "Edit",
        icon: <Eraser size={13} />,
        when: () => editorController.getView() != null && !simRunning,
        run: () => {
          formatDoc();
          close();
        },
      },
      {
        id: "run-all",
        label: "Run Simulator from Top",
        group: "Run",
        icon: <Play size={13} />,
        kbd: "⌘⇧.",
        when: () => !simRunning,
        run: () => {
          startSim(undefined);
          close();
        },
      },
      {
        id: "run-cursor",
        label: "Run to Cursor",
        group: "Run",
        icon: <StepForward size={13} />,
        kbd: "⌘.",
        when: () => !simRunning,
        run: () => {
          runToCursor();
          close();
        },
      },
      {
        id: "run-cancel",
        label: "Cancel Simulator",
        group: "Run",
        icon: <X size={13} />,
        when: () => sessionId != null && (runState === "running" || runState === "paused"),
        run: () => {
          cancelSim();
          close();
        },
      },
      {
        id: "view-pick",
        label: "Pick Element from Browser",
        group: "View",
        icon: <Crosshair size={13} />,
        kbd: "⌘⇧P",
        run: () => {
          triggerPickFromEditor();
          close();
        },
      },
      {
        id: "view-problems",
        label: "Toggle Problems Panel",
        group: "View",
        icon: <AlertTriangle size={13} />,
        kbd: "⌘⇧M",
        run: () => {
          toggleProblems();
          close();
        },
      },
    ];
    return all.filter((c) => !c.when || c.when());
  }, [
    story,
    simRunning,
    sessionId,
    runState,
    startSim,
    runToCursor,
    cancelSim,
    toggleComment,
    formatDoc,
    toggleProblems,
    close,
  ]);

  const groups = useMemo(() => {
    const map = new Map<string, PaletteCommand[]>();
    for (const c of rootCommands) {
      const list = map.get(c.group) ?? [];
      list.push(c);
      map.set(c.group, list);
    }
    return Array.from(map.entries());
  }, [rootCommands]);

  const flatSteps = useMemo(() => (story ? flattenSteps(story) : []), [story]);

  const placeholder = ((): string => {
    switch (mode) {
      case "scene":
        return "Filter scenes…";
      case "step":
        return "Filter steps…";
      case "line":
        return "Line number…";
      default:
        return "Type a command…";
    }
  })();

  const handleSubModeKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (mode !== "root") {
        setMode("root");
        setLineInput("");
        return;
      }
      close();
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        role="presentation"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18 }}
        onClick={close}
        className="fixed inset-0 z-[200] grid place-items-center backdrop-blur-md"
        style={{ background: "rgba(0,0,0,0.4)" }}
      >
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          onClick={(e) => e.stopPropagation()}
          className="sc-palette w-[640px] max-w-[90%] overflow-hidden"
          style={{
            background: "var(--sc-surface)",
            border: "1px solid var(--sc-border-2)",
            borderRadius: "var(--sc-r-xl)",
            boxShadow: "var(--sc-sh-pop)",
          }}
        >
          <Command
            label="Editor command palette"
            shouldFilter={mode !== "line"}
            onKeyDownCapture={handleSubModeKey}
          >
            <div
              className="flex items-center gap-[10px] px-4 py-3"
              style={{ borderBottom: "1px solid var(--sc-border)" }}
            >
              <Search size={15} style={{ color: "var(--sc-text-4)" }} />
              {mode === "line" ? (
                <input
                  autoFocus
                  type="number"
                  min={1}
                  value={lineInput}
                  onChange={(e) => setLineInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const view = editorController.getView();
                      const n = parseInt(lineInput, 10);
                      if (view && Number.isFinite(n) && n >= 1 && n <= view.state.doc.lines) {
                        const offset = view.state.doc.line(n).from;
                        onJumpToOffset(offset);
                        close();
                      }
                    }
                  }}
                  placeholder={placeholder}
                  className="flex-1 bg-transparent text-sm outline-none"
                  style={{ color: "var(--sc-text)" }}
                  aria-label="Line number"
                />
              ) : (
                <Command.Input
                  autoFocus
                  placeholder={placeholder}
                  className="flex-1 bg-transparent text-sm outline-none"
                  style={{ color: "var(--sc-text)" }}
                />
              )}
              <span className="sc-kbd">{mode === "root" ? "esc" : "↩ back"}</span>
            </div>

            <Command.List className="max-h-[440px] overflow-y-auto p-1.5">
              {mode === "root" && (
                <>
                  <Command.Empty
                    className="px-4 py-8 text-center text-xs"
                    style={{ color: "var(--sc-text-4)" }}
                  >
                    No commands found.
                  </Command.Empty>
                  {groups.map(([group, items]) => (
                    <Command.Group
                      key={group}
                      heading={group}
                      className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em]"
                      style={{ ["--cmdk-group-heading-color" as string]: "var(--sc-text-4)" }}
                    >
                      {items.map((c) => (
                        <Command.Item
                          key={c.id}
                          value={`${c.label} ${c.id}`}
                          onSelect={() => c.run()}
                          className="flex cursor-default items-center gap-2.5 rounded-[var(--sc-r-md)] px-2.5 py-2 text-[12.5px] data-[selected=true]:bg-[var(--sc-hover)]"
                          style={{ color: "var(--sc-text)" }}
                        >
                          <span className="w-4" style={{ color: "var(--sc-text-3)" }}>
                            {c.icon}
                          </span>
                          <span className="flex-1">{c.label}</span>
                          {c.kbd ? <ScKbd>{c.kbd}</ScKbd> : null}
                        </Command.Item>
                      ))}
                    </Command.Group>
                  ))}
                </>
              )}

              {mode === "scene" && story && (
                <Command.Group heading="Scenes">
                  {story.scenes.map((scene, i) => {
                    const label = scene.name?.trim().length ? scene.name : `Scene ${i + 1}`;
                    return (
                      <Command.Item
                        key={`scene-${i}`}
                        value={`${label} scene ${i + 1}`}
                        onSelect={() => {
                          onJumpToOffset(scene.span.start);
                          close();
                        }}
                        className="flex cursor-default items-center gap-2.5 rounded-[var(--sc-r-md)] px-2.5 py-2 text-[12.5px] data-[selected=true]:bg-[var(--sc-hover)]"
                        style={{ color: "var(--sc-text)" }}
                      >
                        <span className="w-4" style={{ color: "var(--sc-text-3)" }}>
                          <GitBranch size={13} />
                        </span>
                        <span className="flex-1">{label}</span>
                        <ScKbd>Ln {scene.span.line}</ScKbd>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              {mode === "step" && (
                <Command.Group heading="Steps">
                  {flatSteps.map((s) => (
                    <Command.Item
                      key={`step-${s.globalOrdinal}`}
                      value={`${s.sceneName} step ${s.stepIndex + 1} ${s.verb}`}
                      onSelect={() => {
                        onJumpToOffset(s.offset);
                        close();
                      }}
                      className="flex cursor-default items-center gap-2.5 rounded-[var(--sc-r-md)] px-2.5 py-2 text-[12.5px] data-[selected=true]:bg-[var(--sc-hover)]"
                      style={{ color: "var(--sc-text)" }}
                    >
                      <span className="w-4" style={{ color: "var(--sc-text-3)" }}>
                        <SkipForward size={13} />
                      </span>
                      <span className="flex-1">
                        <span style={{ color: "var(--sc-text-3)" }}>{s.sceneName} ›</span>{" "}
                        <span>
                          Step {s.stepIndex + 1} ({s.verb})
                        </span>
                      </span>
                      <ScKbd>#{s.globalOrdinal}</ScKbd>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {mode === "line" && (
                <div
                  className="px-4 py-3 text-xs"
                  style={{ color: "var(--sc-text-3)" }}
                >
                  Press ↩ to jump to that line.
                </div>
              )}
            </Command.List>

            <div
              className="flex items-center gap-3.5 px-3.5 py-2 text-[10.5px]"
              style={{ borderTop: "1px solid var(--sc-border)", color: "var(--sc-text-4)" }}
            >
              <span>
                <span className="sc-kbd">↑↓</span> navigate
              </span>
              <span>
                <span className="sc-kbd">↵</span> select
              </span>
              <span className="ml-auto">{mode === "root" ? "Editor commands" : `Mode: ${mode}`}</span>
            </div>
          </Command>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
