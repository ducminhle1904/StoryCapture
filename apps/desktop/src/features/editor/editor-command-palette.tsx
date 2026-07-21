import {
  CommandPalette as AstryxCommandPalette,
  CommandPaletteInput,
} from "@astryxdesign/core/CommandPalette";
import { Kbd as AstryxKbd } from "@astryxdesign/core/Kbd";
import { createStaticSource, type SearchableItem } from "@astryxdesign/core/Typeahead";
import { toggleLineComment } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
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
import { useCallback, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import type { Story } from "@/ipc/parse";
import { simulatorCancel } from "@/ipc/simulator";
import { notifications } from "@/lib/notifications";
import { useSimulatorStore } from "@/state/simulator-store";

import { editorController } from "./controller";
import { normalizeForSave } from "./normalize-source";
import { triggerPickFromEditor } from "./PreviewPickerButton";
import { useProblemsPanelStore } from "./problems-panel";
import { buildOrdinalLineMap } from "./simulator-decoration";
import { runOrStepTo } from "./simulator-keymap";

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

interface EditorPaletteSearchData {
  group: string;
  icon: React.ReactNode;
  kbd?: string;
  run: () => void;
}

type EditorPaletteSearchItem = SearchableItem<EditorPaletteSearchData>;

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

export function EditorCommandPalette(props: EditorCommandPaletteProps) {
  const [open, setOpen] = useState(false);
  useHotkeys(
    "mod+shift+k",
    (e) => {
      e.preventDefault();
      setOpen((v) => !v);
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  );
  if (!open) return null;
  return <PaletteBody {...props} onClose={() => setOpen(false)} />;
}

interface PaletteBodyProps extends EditorCommandPaletteProps {
  onClose: () => void;
}

function PaletteBody({
  story,
  projectFolder,
  storyPath,
  streamId,
  onJumpToOffset,
  onClose,
}: PaletteBodyProps) {
  const [mode, setMode] = useState<Mode>("root");
  const [lineInput, setLineInput] = useState("");
  const keepOpenForModeChange = useRef(false);

  const enterMode = useCallback((nextMode: Mode) => {
    keepOpenForModeChange.current = true;
    setLineInput("");
    setMode(nextMode);
    queueMicrotask(() => {
      keepOpenForModeChange.current = false;
    });
  }, []);

  const close = useCallback(() => {
    setMode("root");
    setLineInput("");
    onClose();
  }, [onClose]);

  const runState = useSimulatorStore((s) => s.runState);
  const sessionId = useSimulatorStore((s) => s.sessionId);
  const toggleProblems = useProblemsPanelStore((s) => s.toggle);
  const simRunning = runState === "running";

  const startSim = useCallback(
    (stopAfterOrdinal?: number) => {
      const ok = runOrStepTo(stopAfterOrdinal, { streamId, projectFolder, storyPath });
      if (!ok) notifications.warning("Live Preview not ready — open the preview first");
    },
    [streamId, projectFolder, storyPath],
  );

  const runToCursor = useCallback(() => {
    const view = editorController.getView();
    if (!view || !story) {
      notifications.warning("No editor or story available");
      return;
    }
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const { lineToOrdinal } = buildOrdinalLineMap(
      story as unknown as { scenes: Array<{ commands: Array<{ span: { line: number } }> }> },
    );
    const ord = lineToOrdinal(line);
    if (ord == null) {
      notifications.warning("Cursor is not on an executable step");
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
        run: () => enterMode("scene"),
      },
      {
        id: "nav-step",
        label: "Go to Step…",
        group: "Navigate",
        icon: <ListOrdered size={13} />,
        when: () => Boolean(story && story.scenes.some((s) => s.commands.length > 0)),
        run: () => enterMode("step"),
      },
      {
        id: "nav-line",
        label: "Go to Line…",
        group: "Navigate",
        icon: <Hash size={13} />,
        run: () => enterMode("line"),
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
        id: "edit-find",
        label: "Find / Replace…",
        group: "Edit",
        icon: <Search size={13} />,
        kbd: "⌘F",
        when: () => editorController.getView() != null,
        run: () => {
          const view = editorController.getView();
          if (!view) return;
          openSearchPanel(view);
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
    enterMode,
    close,
  ]);

  const flatSteps = useMemo(() => (story ? flattenSteps(story) : []), [story]);

  const searchItems = useMemo<EditorPaletteSearchItem[]>(() => {
    if (mode === "root") {
      return rootCommands.map((command) => ({
        id: command.id,
        label: command.label,
        auxiliaryData: {
          group: command.group,
          icon: command.icon,
          kbd: command.kbd,
          run: command.run,
        },
      }));
    }

    if (mode === "scene" && story) {
      return story.scenes.map((scene, index) => {
        const label = scene.name?.trim().length ? scene.name : `Scene ${index + 1}`;
        return {
          id: `scene-${index}`,
          label,
          auxiliaryData: {
            group: "Scenes",
            icon: <GitBranch size={13} />,
            kbd: `Ln ${scene.span.line}`,
            run: () => {
              onJumpToOffset(scene.span.start);
              close();
            },
          },
        };
      });
    }

    if (mode === "step") {
      return flatSteps.map((step) => ({
        id: `step-${step.globalOrdinal}`,
        label: `${step.sceneName} › Step ${step.stepIndex + 1} (${step.verb})`,
        auxiliaryData: {
          group: "Steps",
          icon: <SkipForward size={13} />,
          kbd: `#${step.globalOrdinal}`,
          run: () => {
            onJumpToOffset(step.offset);
            close();
          },
        },
      }));
    }

    return [];
  }, [close, flatSteps, mode, onJumpToOffset, rootCommands, story]);

  const searchSource = useMemo(
    () =>
      createStaticSource(searchItems, {
        keywords: (item) => [item.id],
      }),
    [searchItems],
  );

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

  return (
    <AstryxCommandPalette<EditorPaletteSearchItem>
      key={mode}
      isOpen
      onOpenChange={(nextOpen) => {
        if (nextOpen) return;
        if (mode !== "root") {
          setLineInput("");
          setMode("root");
          return;
        }
        if (keepOpenForModeChange.current) {
          keepOpenForModeChange.current = false;
          return;
        }
        close();
      }}
      searchSource={searchSource}
      onValueChange={(itemId) =>
        searchItems.find((item) => item.id === itemId)?.auxiliaryData?.run()
      }
      label="Editor command palette"
      width={640}
      maxHeight={480}
      emptySearchText="No commands found."
      emptyBootstrapText={
        mode === "line" ? "Press Enter to jump to that line." : "No commands found."
      }
      input={
        <CommandPaletteInput
          placeholder={placeholder}
          value={mode === "line" ? lineInput : undefined}
          onValueChange={mode === "line" ? setLineInput : undefined}
          endContent={<AstryxKbd keys={mode === "root" ? "Esc" : "Esc · back"} />}
          onKeyDown={(event) => {
            if (event.key === "Escape" && mode !== "root") {
              event.preventDefault();
              enterMode("root");
              return;
            }
            if (event.key !== "Enter" || mode !== "line") return;
            event.preventDefault();
            const view = editorController.getView();
            const line = Number.parseInt(lineInput, 10);
            if (view && Number.isFinite(line) && line >= 1 && line <= view.state.doc.lines) {
              onJumpToOffset(view.state.doc.line(line).from);
              close();
            }
          }}
        />
      }
      renderItem={(item) => {
        const data = item.auxiliaryData;
        if (!data) return item.label;
        return (
          <div className="flex w-full items-center gap-2.5">
            <span className="w-4 text-[var(--color-text-secondary)]">{data.icon}</span>
            <span className="flex-1">{item.label}</span>
            {data.kbd ? <AstryxKbd keys={data.kbd} /> : null}
          </div>
        );
      }}
    />
  );
}
