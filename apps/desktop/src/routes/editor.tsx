import { invoke } from "@tauri-apps/api/core";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  ArrowLeft,
  Mic2,
  Sparkles,
  Video,
  Terminal,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ScButton } from "@storycapture/ui";

import previewBackdrop from "@/assets/gradients/warm-sunset.png";
import { PageContentTransition } from "@/components/page-content-transition";
import { PreviewPanel } from "@/features/editor/preview-panel";
import { SceneListPanel } from "@/features/editor/scene-list-panel";
import {
  StoryEditor,
  type EditorJumpTarget,
} from "@/features/editor/story-editor";
import { TimelinePanel } from "@/features/editor/timeline-panel";
import { TtsClipInspector } from "@/features/voiceover/TtsClipInspector";
import { TtsScriptEditor } from "@/features/voiceover/TtsScriptEditor";
import { VoiceCatalogDialog } from "@/features/voiceover/VoiceCatalogDialog";
import { useVoiceoverStore } from "@/features/voiceover/voiceoverStore";
import {
  parseStory,
  type Command,
  type SelectorOrText,
  type Story,
} from "@/ipc/parse";
import { fetchProjectFolder, type ProjectFolderInfo } from "@/ipc/projects";
import { useEditorStore } from "@/state/editor";

const EMPTY_DIAGNOSTICS: never[] = [];

/* Voiceover helpers */

interface VoiceoverStep {
  id: string;
  label: string;
  suggestedScript: string;
  verb: Command["verb"];
  sceneIndex: number;
  sceneLabel: string;
  commandIndex: number;
  spanStart: number;
}

function summariseScript(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "No line yet";
  return compact.length > 56 ? `${compact.slice(0, 56)}...` : compact;
}

function describeTarget(target: SelectorOrText | undefined): string {
  if (!target) return "the highlighted UI";
  return target.value;
}

function buildSuggestedScript(cmd: Command, sceneName: string): string {
  const scenePrefix = sceneName ? `${sceneName}: ` : "";
  switch (cmd.verb) {
    case "navigate":
      return `${scenePrefix}Open ${cmd.url} and frame the starting state of the flow.`;
    case "click":
      return `${scenePrefix}Click ${describeTarget(cmd.target)} to move to the next step.`;
    case "type":
      return `${scenePrefix}Type ${cmd.text} into ${describeTarget(cmd.target)}.`;
    case "scroll":
      return `${scenePrefix}Scroll ${cmd.direction} to reveal the next part of the interface.`;
    case "hover":
      return `${scenePrefix}Hover over ${describeTarget(cmd.target)} to expose the available action.`;
    case "drag":
      return `${scenePrefix}Drag from ${describeTarget(cmd.from)} to ${describeTarget(cmd.to)}.`;
    case "select":
      return `${scenePrefix}Select ${cmd.value} in ${describeTarget(cmd.target)}.`;
    case "upload":
      return `${scenePrefix}Upload ${cmd.path} through ${describeTarget(cmd.target)}.`;
    case "wait":
      return `${scenePrefix}Pause briefly so the interface can settle before the next move.`;
    case "wait-for":
      return `${scenePrefix}Wait for ${describeTarget(cmd.target)} to appear before continuing.`;
    case "assert":
      return `${scenePrefix}Confirm that ${describeTarget(cmd.target)} is visible and correct.`;
    case "screenshot":
      return `${scenePrefix}Capture the state named ${cmd.name} for reference.`;
    case "pause":
      return `${scenePrefix}Hold here for emphasis before continuing the story.`;
    default:
      return `${scenePrefix}Continue the story with a clean transition into the next UI step.`;
  }
}

function buildVoiceoverSteps(story: Story | null): VoiceoverStep[] {
  if (!story) return [];
  return story.scenes.flatMap((scene, sceneIndex) =>
    scene.commands.map((command, commandIndex) => ({
      id: `scene-${sceneIndex + 1}-step-${commandIndex + 1}`,
      label: `${scene.name || `Scene ${sceneIndex + 1}`} · ${command.verb}`,
      suggestedScript: buildSuggestedScript(command, scene.name),
      verb: command.verb,
      sceneIndex,
      sceneLabel: scene.name || `Scene ${sceneIndex + 1}`,
      commandIndex,
      spanStart: command.span.start,
    })),
  );
}

function findSceneIndexForOffset(story: Story | null, offset: number): number {
  if (!story || story.scenes.length === 0) return 0;
  const idx = story.scenes.findIndex(
    (scene) => offset >= scene.span.start && offset <= scene.span.end,
  );
  return idx >= 0 ? idx : 0;
}

type RailTab = "preview" | "voiceover";

/* Voiceover panel */

function VoiceoverCompact({
  projectId,
  story,
  activeSceneIndex,
  onSelectScene,
  onJumpTo,
}: {
  projectId: string;
  story: Story | null;
  activeSceneIndex: number;
  onSelectScene: (sceneIndex: number) => void;
  onJumpTo?: (byteOffset: number) => void;
}) {
  const steps = useMemo(() => buildVoiceoverSteps(story), [story]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const selectedPreset = useVoiceoverStore((s) => s.selectedPreset);
  const clipByStepId = useVoiceoverStore((s) => s.clipByStepId);
  const scriptByStepId = useVoiceoverStore((s) => s.scriptByStepId);
  const generating = useVoiceoverStore((s) => s.generating);
  const editedAfterGenByStepId = useVoiceoverStore(
    (s) => s.editedAfterGenByStepId,
  );
  const setCatalogOpen = useVoiceoverStore((s) => s.setCatalogOpen);
  const setScript = useVoiceoverStore((s) => s.setScript);
  const setClip = useVoiceoverStore((s) => s.setClip);
  const setGenerating = useVoiceoverStore((s) => s.setGenerating);
  const setEditedAfterGen = useVoiceoverStore((s) => s.setEditedAfterGen);
  const selectedPresetRef = useRef(selectedPreset);
  selectedPresetRef.current = selectedPreset;

  const sceneSteps = useMemo(
    () => steps.filter((step) => step.sceneIndex === activeSceneIndex),
    [activeSceneIndex, steps],
  );
  const sceneGeneratedCount = useMemo(
    () => sceneSteps.filter((step) => Boolean(clipByStepId[step.id])).length,
    [clipByStepId, sceneSteps],
  );
  const sceneLabel =
    sceneSteps[0]?.sceneLabel ??
    story?.scenes[activeSceneIndex]?.name ??
    `Scene ${activeSceneIndex + 1}`;

  useEffect(() => {
    if (sceneSteps.length === 0) {
      setSelectedStepId(null);
      return;
    }
    setSelectedStepId((current) =>
      current && sceneSteps.some((step) => step.id === current)
        ? current
        : sceneSteps[0].id,
    );
  }, [sceneSteps]);

  useEffect(() => {
    for (const step of steps) {
      if (!(step.id in scriptByStepId)) {
        setScript(step.id, step.suggestedScript);
      }
    }
  }, [scriptByStepId, steps, setScript]);

  const selectedStep =
    sceneSteps.find((step) => step.id === selectedStepId) ?? null;
  const selectedClip = selectedStep ? clipByStepId[selectedStep.id] : null;
  const selectedScript = selectedStep
    ? (scriptByStepId[selectedStep.id] ?? "")
    : "";
  const selectedStatus = selectedStep
    ? generating.has(selectedStep.id)
      ? "regenerating"
      : editedAfterGenByStepId[selectedStep.id]
        ? "out-of-sync-with-script"
        : "generated"
    : "generated";

  const handleRegenerate = useCallback(async () => {
    const preset = selectedPresetRef.current;
    if (!selectedStep || !preset || !selectedScript.trim()) return;
    setGenerating(selectedStep.id, true);
    try {
      const result = await invoke<{
        file_path: string;
        audio_duration_ms: number;
        cost_usd: number;
      }>("tts_regenerate_clip", {
        projectId,
        stepId: selectedStep.id,
        scriptText: selectedScript,
        provider: preset.provider,
        voiceId: preset.id,
        model:
          preset.provider === "elevenlabs" ? "eleven_multilingual_v2" : "tts-1",
      });
      setClip(selectedStep.id, {
        filePath: result.file_path,
        durationMs: result.audio_duration_ms,
        costUsd: result.cost_usd,
      });
      setEditedAfterGen(selectedStep.id, false);
    } finally {
      setGenerating(selectedStep.id, false);
    }
  }, [
    projectId,
    selectedScript,
    selectedStep,
    setClip,
    setEditedAfterGen,
    setGenerating,
  ]);

  if (steps.length === 0) {
    return (
      <div className="flex h-full flex-col bg-[var(--sc-surface)]">
        <div className="flex items-center gap-2 border-b border-[var(--sc-border)] px-3 py-1.5">
          <Mic2 size={11} className="text-[var(--sc-text-4)]" />
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
            Voiceover
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-[var(--sc-text-4)]">
          Parse a story to start attaching voiceover clips.
        </div>
      </div>
    );
  }

  if (sceneSteps.length === 0) {
    return (
      <div className="flex h-full flex-col bg-[var(--sc-surface)]">
        <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-3 py-1.5">
          <div className="flex items-center gap-2">
            <Mic2 size={11} className="text-[var(--sc-text-4)]" />
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
              Voiceover
            </span>
          </div>
          <button
            type="button"
            onClick={() => setCatalogOpen(true)}
            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2 py-0.5 text-[10px] text-[var(--sc-text-2)] transition-colors hover:bg-[var(--sc-surface-3)] hover:text-[var(--sc-text)]"
          >
            <Sparkles size={10} />
            {selectedPreset ? selectedPreset.name : "Choose voice"}
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-[var(--sc-text-4)]">
          The selected scene has no voiceover steps yet.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--sc-surface)]">
      {/* Header — compact */}
      <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Mic2 size={11} className="text-[var(--sc-text-4)]" />
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
            Voiceover
          </span>
        </div>
        <button
          type="button"
          onClick={() => setCatalogOpen(true)}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2 py-0.5 text-[10px] text-[var(--sc-text-2)] transition-colors hover:bg-[var(--sc-surface-3)] hover:text-[var(--sc-text)]"
        >
          <Sparkles size={10} />
          {selectedPreset ? selectedPreset.name : "Choose voice"}
        </button>
      </div>

      {story && story.scenes.length > 1 ? (
        <div className="flex gap-1 overflow-x-auto border-b border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2 py-1">
          {story.scenes.map((scene, sceneIndex) => {
            const isSelected = sceneIndex === activeSceneIndex;
            const label = scene.name || `Scene ${sceneIndex + 1}`;
            const voiceSteps = steps.filter((step) => step.sceneIndex === sceneIndex);
            const clipCount = voiceSteps.filter((step) => clipByStepId[step.id]).length;
            return (
              <button
                key={`voice-scene-${sceneIndex}`}
                type="button"
                onClick={() => onSelectScene(sceneIndex)}
                className={`inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-xs)] px-2 py-1 text-[10px] transition-colors ${
                  isSelected
                    ? "bg-[var(--sc-accent-500)]/10 text-[var(--sc-text)]"
                    : "text-[var(--sc-text-4)] hover:text-[var(--sc-text-2)]"
                }`}
              >
                <span className="truncate max-w-[140px]">{label}</span>
                <span className="font-mono tabular-nums text-[9px] text-[var(--sc-text-4)]">
                  {clipCount}/{voiceSteps.length}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex items-center justify-between border-b border-[var(--sc-border)] bg-[var(--sc-surface)] px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--sc-text)]">
            {sceneLabel}
          </div>
          <div className="text-[11px] text-[var(--sc-text-4)]">
            {sceneGeneratedCount === sceneSteps.length
              ? "All takes ready"
              : `${sceneGeneratedCount} of ${sceneSteps.length} ready`}
          </div>
        </div>
        <div className="rounded-[var(--radius-sm)] bg-[var(--sc-surface-2)] px-2 py-1 text-[10px] text-[var(--sc-text-4)]">
          {sceneSteps.length} steps
        </div>
      </div>

      <div className="grid min-h-0 flex-1 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          aria-label="Voiceover step navigation"
          className="min-h-0 overflow-y-auto border-r border-[var(--sc-border)] bg-[var(--sc-surface-2)]"
        >
          <div className="divide-y divide-[var(--sc-border)]">
            {sceneSteps.map((step) => {
              const isSelected = step.id === selectedStepId;
              const hasClip = Boolean(clipByStepId[step.id]);
              const isRegenerating = generating.has(step.id);
              const isDirty = editedAfterGenByStepId[step.id];
              const linePreview = summariseScript(
                scriptByStepId[step.id] ?? step.suggestedScript,
              );

              let toneClass = "bg-[var(--sc-text-4)]/35";
              if (isRegenerating) toneClass = "bg-[var(--sc-accent-500)]";
              else if (isDirty) toneClass = "bg-[var(--sc-warn)]";
              else if (hasClip) toneClass = "bg-[var(--sc-success)]";

              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => {
                    setSelectedStepId(step.id);
                    onSelectScene(step.sceneIndex);
                    onJumpTo?.(step.spanStart);
                  }}
                  className={`flex w-full items-start gap-3 px-3 py-3 text-left transition-colors ${
                    isSelected
                      ? "bg-[var(--sc-accent-500)]/7"
                      : "bg-transparent hover:bg-[var(--sc-surface)]/70"
                  }`}
                >
                  <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-xs)] bg-[var(--sc-surface-3)] font-mono text-[10px] text-[var(--sc-text-2)]">
                    {step.commandIndex + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneClass}`} />
                      <span className="truncate text-xs font-medium text-[var(--sc-text)]">
                        {step.verb}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[11px] leading-relaxed text-[var(--sc-text-4)]">
                      {linePreview}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </nav>

        <div className="min-h-0 overflow-y-auto p-3">
          {selectedStep ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3 border-b border-[var(--sc-border)] pb-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                    Active Step
                  </div>
                  <div className="mt-1 truncate text-sm font-semibold text-[var(--sc-text)]">
                    Step {selectedStep.commandIndex + 1} · {selectedStep.verb}
                  </div>
                  <div className="mt-1 text-xs text-[var(--sc-text-2)]">
                    {selectedStep.label}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onJumpTo?.(selectedStep.spanStart)}
                  className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 py-1 text-[10px] text-[var(--sc-text-2)] transition-colors hover:text-[var(--sc-text)]"
                >
                  Jump to script
                </button>
              </div>

              <TtsScriptEditor projectId={projectId} stepId={selectedStep.id} />

              {selectedClip ? (
                <TtsClipInspector
                  stepId={selectedStep.id}
                  stepLabel={`Step ${selectedStep.commandIndex + 1}`}
                  projectId={projectId}
                  clip={selectedClip}
                  presetName={selectedPreset?.name ?? "Selected voice"}
                  status={selectedStatus}
                  onRegenerate={() => {
                    void handleRegenerate();
                  }}
                />
              ) : (
                <div className="border-t border-[var(--sc-border)] pt-3 text-xs text-[var(--sc-text-4)]">
                  No take yet.
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RailTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      whileTap={reduceMotion ? undefined : { scale: 0.985 }}
      className={`relative rounded-[var(--radius-xs)] px-2 py-1 text-[10px] font-medium transition-colors ${
        active
          ? "text-[var(--sc-text)]"
          : "text-[var(--sc-text-4)] hover:text-[var(--sc-text)]"
      }`}
    >
      {active ? (
        <motion.span
          layoutId="editor-rail-tab-pill"
          className="absolute inset-0 rounded-[var(--radius-xs)] bg-[var(--sc-surface)] shadow-sm"
          transition={
            reduceMotion
              ? { duration: 0.12 }
              : { type: "spring", stiffness: 420, damping: 34 }
          }
        />
      ) : null}
      <span className="relative z-10">{label}</span>
    </motion.button>
  );
}

/* Editor route */

export default function EditorRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const reduceMotion = useReducedMotion();
  const [folder, setFolder] = useState<ProjectFolderInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSceneIndex, setActiveSceneIndex] = useState(0);
  const [railTab, setRailTab] = useState<RailTab>("preview");
  const [editorJumpTarget, setEditorJumpTarget] =
    useState<EditorJumpTarget | null>(null);
  // Only render once store state matches the URL project to avoid a stale scene flash.
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const setSource = useEditorStore((s) => s.setSource);
  const setLastParse = useEditorStore((s) => s.setLastParse);
  const resetProjectState = useEditorStore((s) => s.resetProjectState);
  const source = useEditorStore((s) => s.source);
  const story = useEditorStore((s) => s.lastParse?.ast ?? null);
  const diagnostics =
    useEditorStore((s) => s.lastParse?.diagnostics) ?? EMPTY_DIAGNOSTICS;

  useEffect(() => {
    if (!projectId) return;
    // Reset per-project state before the async load so old scenes never flash.
    resetProjectState();
    setFolder(null);
    setLoadError(null);
    setActiveSceneIndex(0);
    setLoadedProjectId(null);

    let cancelled = false;
    (async () => {
      try {
        const info = await fetchProjectFolder(projectId);
        if (cancelled) return;
        const text = await readTextFile(info.story_path);
        if (cancelled) return;
        // Parse before marking ready so the first paint already has scenes and diagnostics.
        let parsed: Awaited<ReturnType<typeof parseStory>> | null = null;
        try {
          parsed = await parseStory(text);
        } catch {
          /* Render anyway; diagnostics surface elsewhere. */
        }
        if (cancelled) return;
        // Commit folder, source, parse result, and ready flag together.
        setFolder(info);
        setSource(text);
        if (parsed) setLastParse(parsed);
        setLoadedProjectId(projectId);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, setSource, setLastParse, resetProjectState]);

  const ready = loadedProjectId === projectId;

  useEffect(() => {
    if (!story || story.scenes.length === 0) {
      setActiveSceneIndex(0);
      return;
    }

    setActiveSceneIndex((current) =>
      Math.max(0, Math.min(current, story.scenes.length - 1)),
    );
  }, [story]);

  const autosave = useCallback(
    async (nextSource: string) => {
      if (!folder) return;
      try {
        await writeTextFile(folder.story_path, nextSource);
      } catch {
        /* UI handles autosave failure separately. */
      }
    },
    [folder],
  );

  const queueEditorJump = useCallback((offset: number) => {
    setEditorJumpTarget((current) => ({
      offset,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }, []);

  const handleSelectScene = useCallback(
    (sceneIndex: number) => {
      setActiveSceneIndex(sceneIndex);
      const scene = story?.scenes[sceneIndex];
      if (scene) {
        queueEditorJump(scene.span.start);
      }
    },
    [queueEditorJump, story],
  );

  const handleNavigateToOffset = useCallback(
    (offset: number) => {
      setActiveSceneIndex(findSceneIndexForOffset(story, offset));
      queueEditorJump(offset);
    },
    [queueEditorJump, story],
  );

  if (loadError) {
    return (
      <main id="main-content" className="mx-auto max-w-2xl p-8" role="alert">
        <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--sc-record)]/40 bg-[var(--sc-record)]/8 p-4 text-sm text-[var(--sc-record)]">
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5" />
          <div>
            <p className="font-medium">Failed to open project</p>
            <p className="mt-1 text-[var(--sc-text-2)]">{loadError}</p>
            <Link
              to="/"
              className="mt-3 inline-flex items-center gap-1 text-[var(--sc-accent-400)] hover:underline"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back to dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter(
    (d) => d.severity === "warning",
  ).length;
  const sceneCount = story?.scenes.length ?? 0;
  const selectedScene = story?.scenes[activeSceneIndex] ?? null;
  const selectedSceneName = selectedScene
    ? selectedScene.name || `Scene ${activeSceneIndex + 1}`
    : null;
  const selectedSceneMeta = selectedScene
    ? `${selectedScene.commands.length} steps`
    : sceneCount > 0
      ? `${sceneCount} scenes`
      : null;

  return (
    <main
      id="main-content"
      className="relative flex h-full flex-col bg-[var(--sc-bg)]"
    >
      {/* ─── Toolbar ─── */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--sc-border)] bg-[var(--sc-surface)] px-3 py-1.5">
        <div className="flex items-center gap-3">
          {/* Back to dashboard */}
          <Link
            to="/"
            aria-label="Back to projects"
            className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-1 text-[var(--sc-text-2)] transition-colors hover:bg-[var(--sc-surface-3)] hover:text-[var(--sc-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sc-focus-ring)]"
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </Link>

          {/* Project name as breadcrumb */}
          <div className="flex items-center gap-1.5 text-xs text-[var(--sc-text-4)]">
            <Link
              to="/"
              className="transition-colors hover:text-[var(--sc-text)]"
            >
              Projects
            </Link>
            <span>/</span>
            <span className="font-medium text-[var(--sc-text)]">
              {folder?.name ?? "Loading..."}
            </span>
          </div>

          {/* Diagnostics badges */}
          {errorCount > 0 && (
            <span className="rounded-[var(--radius-xs)] bg-[var(--sc-record)]/10 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--sc-record)]">
              {errorCount} {errorCount === 1 ? "error" : "errors"}
            </span>
          )}
          {warningCount > 0 && (
            <span className="rounded-[var(--radius-xs)] bg-[var(--sc-warn)]/10 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--sc-warn)]">
              {warningCount}
            </span>
          )}
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-2">
          {projectId && (
            <>
              <ScButton
                size="sm"
                icon={<Terminal size={12} aria-hidden="true" />}
              >
                Dry run
              </ScButton>
              <Link
                to={`/recorder/${projectId}`}
                className="sc-btn primary sm"
              >
                <Video size={12} aria-hidden="true" />
                Record
              </Link>
            </>
          )}
        </div>
      </header>

      {/* ─── Main workspace ─── */}
      {!ready ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center bg-[var(--sc-bg)]"
          role="status"
          aria-live="polite"
        >
          <span className="text-xs text-[var(--sc-text-4)]">
            Opening project…
          </span>
        </div>
      ) : (
      <PageContentTransition className="min-h-0 flex-1">
        <PanelGroup direction="vertical" className="min-h-0 flex-1">
        {/* Top: scene list + script + preview + voiceover */}
        <Panel defaultSize={75} minSize={45}>
          <PanelGroup direction="horizontal">
            {/* Scene list — narrow left panel */}
            {sceneCount > 0 && (
              <>
                <Panel defaultSize={12} minSize={8} maxSize={18}>
                  <SceneListPanel
                    activeSceneIndex={activeSceneIndex}
                    onSelectScene={handleSelectScene}
                  />
                </Panel>
                <PanelResizeHandle className="group relative w-px bg-[var(--sc-border)] transition-colors hover:bg-[var(--sc-accent-500)]/30 active:bg-[var(--sc-accent-500)]/50" />
              </>
            )}

            {/* Script editor — primary workspace */}
            <Panel defaultSize={sceneCount > 0 ? 54 : 62} minSize={32} maxSize={68}>
              <div className="flex h-full flex-col bg-[var(--sc-surface)]">
                <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-3 py-1.5">
                  <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                    Script
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-[var(--sc-text-4)]">
                    {source.split("\n").length} lines
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <StoryEditor
                    onAutosave={autosave}
                    jumpTarget={editorJumpTarget}
                  />
                </div>
              </div>
            </Panel>

            <PanelResizeHandle className="group relative w-px bg-[var(--sc-border)] transition-colors hover:bg-[var(--sc-accent-500)]/30 active:bg-[var(--sc-accent-500)]/50" />

            {/* Right side: contextual rail */}
            <Panel defaultSize={sceneCount > 0 ? 34 : 38} minSize={24} maxSize={44}>
              <div className="flex h-full flex-col bg-[var(--sc-surface)]">
                {projectId ? (
                  <div className="flex items-center justify-between border-b border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-3 py-1.5">
                    <div
                      role="tablist"
                      aria-label="Editor side rail"
                      className="flex gap-px rounded-[var(--radius-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface-3)] p-px"
                    >
                      <RailTabButton
                        active={railTab === "preview"}
                        label="Preview"
                        onClick={() => setRailTab("preview")}
                      />
                      <RailTabButton
                        active={railTab === "voiceover"}
                        label="Voiceover"
                        onClick={() => setRailTab("voiceover")}
                      />
                    </div>
                    <span className="truncate pl-3 font-mono text-[10px] tabular-nums text-[var(--sc-text-4)]">
                      {selectedSceneName ?? "No scene selected"}
                    </span>
                  </div>
                ) : null}

                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <motion.div
                    aria-hidden={railTab !== "preview"}
                    className="absolute inset-0"
                    animate={
                      railTab === "preview"
                        ? { opacity: 1, x: 0, scale: 1 }
                        : reduceMotion
                          ? { opacity: 0, x: 0, scale: 1 }
                          : { opacity: 0, x: -12, scale: 0.992 }
                    }
                    transition={{
                      duration: reduceMotion ? 0.12 : 0.2,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                    style={{
                      pointerEvents: railTab === "preview" ? "auto" : "none",
                      visibility: railTab === "preview" ? "visible" : "hidden",
                    }}
                  >
                    <PreviewPanel
                      thumbnailPath={previewBackdrop}
                      sceneName={selectedSceneName}
                      sceneMeta={selectedSceneMeta}
                    />
                  </motion.div>

                  {projectId ? (
                    <motion.div
                      aria-hidden={railTab !== "voiceover"}
                      className="absolute inset-0"
                      animate={
                        railTab === "voiceover"
                          ? { opacity: 1, x: 0, scale: 1 }
                          : reduceMotion
                            ? { opacity: 0, x: 0, scale: 1 }
                            : { opacity: 0, x: 12, scale: 0.992 }
                      }
                      transition={{
                        duration: reduceMotion ? 0.12 : 0.2,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                      style={{
                        pointerEvents: railTab === "voiceover" ? "auto" : "none",
                        visibility: railTab === "voiceover" ? "visible" : "hidden",
                      }}
                    >
                      <VoiceoverCompact
                        projectId={projectId}
                        story={story}
                        activeSceneIndex={activeSceneIndex}
                        onSelectScene={(sceneIndex) => {
                          setRailTab("voiceover");
                          handleSelectScene(sceneIndex);
                        }}
                        onJumpTo={handleNavigateToOffset}
                      />
                    </motion.div>
                  ) : null}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        {/* Bottom: Timeline */}
        <PanelResizeHandle className="group relative h-px bg-[var(--sc-border)] transition-colors hover:bg-[var(--sc-accent-500)]/30 active:bg-[var(--sc-accent-500)]/50" />

        <Panel defaultSize={22} minSize={12} maxSize={40}>
          <TimelinePanel onJumpTo={handleNavigateToOffset} />
        </Panel>
        </PanelGroup>
      </PageContentTransition>
      )}

      {projectId ? <VoiceCatalogDialog projectId={projectId} /> : null}
    </main>
  );
}
