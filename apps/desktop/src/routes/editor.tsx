import { invoke } from "@tauri-apps/api/core";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Mic2,
  Settings,
  Sparkles,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import previewBackdrop from "@/assets/gradients/warm-sunset.png";
import { BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { PreviewPanel } from "@/features/editor/preview-panel";
import { StoryEditor } from "@/features/editor/story-editor";
import { TimelinePanel } from "@/features/editor/timeline-panel";
import { ChatPanel } from "@/features/nl-mode/ChatPanel";
import { TtsClipInspector } from "@/features/voiceover/TtsClipInspector";
import { TtsScriptEditor } from "@/features/voiceover/TtsScriptEditor";
import { VoiceCatalogDialog } from "@/features/voiceover/VoiceCatalogDialog";
import { useVoiceoverStore } from "@/features/voiceover/voiceoverStore";
import { type Command, type SelectorOrText, type Story } from "@/ipc/parse";
import { fetchProjectFolder, type ProjectFolderInfo } from "@/ipc/projects";
import { useEditorStore } from "@/state/editor";

interface VoiceoverStep {
  id: string;
  label: string;
  suggestedScript: string;
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
    })),
  );
}

function MetricChip({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-full border border-white/8 bg-white/4 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
      <span>{label}</span>
      <span className="ml-2 text-[var(--color-fg-primary)]">{value}</span>
    </div>
  );
}

function VoiceoverWorkbench({
  projectId,
  story,
}: {
  projectId: string;
  story: Story | null;
}) {
  const steps = useMemo(() => buildVoiceoverSteps(story), [story]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const selectedPreset = useVoiceoverStore((s) => s.selectedPreset);
  const clipByStepId = useVoiceoverStore((s) => s.clipByStepId);
  const generating = useVoiceoverStore((s) => s.generating);
  const scriptByStepId = useVoiceoverStore((s) => s.scriptByStepId);
  const editedAfterGenByStepId = useVoiceoverStore(
    (s) => s.editedAfterGenByStepId,
  );
  const setCatalogOpen = useVoiceoverStore((s) => s.setCatalogOpen);
  const setScript = useVoiceoverStore((s) => s.setScript);
  const setClip = useVoiceoverStore((s) => s.setClip);
  const setGenerating = useVoiceoverStore((s) => s.setGenerating);
  const setEditedAfterGen = useVoiceoverStore((s) => s.setEditedAfterGen);
  const generatedCount = useMemo(
    () => steps.filter((step) => Boolean(clipByStepId[step.id])).length,
    [clipByStepId, steps],
  );

  useEffect(() => {
    if (steps.length === 0) {
      setSelectedStepId(null);
      return;
    }

    setSelectedStepId((current) =>
      current && steps.some((step) => step.id === current)
        ? current
        : steps[0].id,
    );
  }, [steps]);

  useEffect(() => {
    for (const step of steps) {
      if (!(step.id in scriptByStepId)) {
        setScript(step.id, step.suggestedScript);
      }
    }
  }, [scriptByStepId, setScript, steps]);

  const selectedStep =
    steps.find((step) => step.id === selectedStepId) ?? null;
  const selectedClip = selectedStep ? clipByStepId[selectedStep.id] : null;
  const selectedScript = selectedStep
    ? scriptByStepId[selectedStep.id] ?? ""
    : "";
  const selectedStatus = selectedStep
    ? generating.has(selectedStep.id)
      ? "regenerating"
      : editedAfterGenByStepId[selectedStep.id]
        ? "out-of-sync-with-script"
        : "generated"
    : "generated";

  const handleRegenerate = useCallback(async () => {
    if (!selectedStep || !selectedPreset || !selectedScript.trim()) return;

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
        provider: selectedPreset.provider,
        voiceId: selectedPreset.id,
        model:
          selectedPreset.provider === "elevenlabs"
            ? "eleven_multilingual_v2"
            : "tts-1",
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
    selectedPreset,
    selectedScript,
    selectedStep,
    setClip,
    setEditedAfterGen,
    setGenerating,
  ]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[26px] border border-white/8 bg-[linear-gradient(180deg,rgba(21,26,34,0.92),rgba(15,18,25,0.96))] shadow-[0_22px_80px_rgba(0,0,0,0.26)]">
      <div className="flex items-start justify-between gap-5 border-b border-white/6 px-5 py-4">
        <div className="max-w-xl">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-[var(--color-fg-muted)]">
            <Mic2 size={12} aria-hidden="true" />
            Voiceover
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--color-fg-secondary)]">
            Shape narration clip by clip while the story structure is still open.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-3">
          <div className="flex items-center gap-2">
            <MetricChip label="steps" value={String(steps.length)} />
            <MetricChip label="clips" value={String(generatedCount)} />
          </div>
          <Button
            variant={selectedPreset ? "outline" : "default"}
            size="sm"
            onClick={() => setCatalogOpen(true)}
            className="shrink-0"
          >
            <Sparkles className="h-4 w-4" />
            {selectedPreset ? "Change voice" : "Choose voice"}
          </Button>
        </div>
      </div>

      {steps.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--color-fg-muted)]">
          Parse a story with at least one command to start attaching voiceover clips.
        </div>
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto border-b border-white/6 bg-black/8 px-5 py-4">
            {steps.map((step) => {
              const isSelected = step.id === selectedStepId;
              const hasClip = Boolean(clipByStepId[step.id]);
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setSelectedStepId(step.id)}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    isSelected
                      ? "border-[var(--color-accent-primary)] bg-[var(--color-accent-primary)]/12 text-[var(--color-fg-primary)]"
                      : "border-white/8 bg-white/4 text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)]"
                  }`}
                >
                  <span className="truncate">{step.label}</span>
                  {hasClip ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="grid min-h-0 flex-1 gap-5 overflow-auto p-5 xl:grid-cols-[minmax(0,1.18fr)_330px]">
            <div className="min-w-0 rounded-[24px] bg-black/14 p-4">
              {selectedStep ? (
                <div className="mb-4 border-b border-white/6 pb-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
                    Active segment
                  </div>
                  <div className="mt-2 flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-base font-semibold text-[var(--color-fg-primary)]">
                        {selectedStep.label}
                      </h3>
                      <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--color-fg-secondary)]">
                        Refine the spoken line before generating the take.
                      </p>
                    </div>
                    {selectedPreset ? (
                      <div className="rounded-full border border-white/8 bg-white/4 px-3 py-1 text-xs text-[var(--color-fg-secondary)]">
                        {selectedPreset.name}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {selectedStep ? (
                <TtsScriptEditor projectId={projectId} stepId={selectedStep.id} />
              ) : null}
            </div>

            <div className="space-y-4">
              <div className="rounded-[24px] border border-white/8 bg-[rgba(255,255,255,0.03)] p-4">
                <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
                  Active voice
                </div>
                <div className="mt-3">
                  {selectedPreset ? (
                    <>
                      <p className="text-base font-semibold text-[var(--color-fg-primary)]">
                        {selectedPreset.name}
                      </p>
                      <p className="mt-1 text-sm text-[var(--color-fg-secondary)]">
                        {selectedPreset.provider}
                        {selectedPreset.locale ? ` · ${selectedPreset.locale}` : ""}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-[var(--color-fg-muted)]">
                      No voice selected yet.
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-4"
                  onClick={() => setCatalogOpen(true)}
                >
                  Browse voice catalog
                </Button>
              </div>

              {selectedStep && selectedClip ? (
                <TtsClipInspector
                  stepId={selectedStep.id}
                  projectId={projectId}
                  clip={selectedClip}
                  presetName={selectedPreset?.name ?? "Selected voice"}
                  status={selectedStatus}
                  onRegenerate={() => {
                    void handleRegenerate();
                  }}
                />
              ) : (
                <div className="rounded-[24px] border border-dashed border-white/10 bg-black/14 p-4 text-sm leading-6 text-[var(--color-fg-muted)]">
                  Generate a clip for the selected step to inspect duration, cost, and sync state.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export default function EditorRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const [folder, setFolder] = useState<ProjectFolderInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const setSource = useEditorStore((s) => s.setSource);
  const source = useEditorStore((s) => s.source);
  const story = useEditorStore((s) => s.lastParse?.ast ?? null);
  const diagnostics = useEditorStore((s) => s.lastParse?.diagnostics ?? []);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("nl_get_session_id")
      .then((id) => {
        if (!cancelled) setSessionId(id);
      })
      .catch(() => {
        if (!cancelled) setSessionId("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await fetchProjectFolder(projectId);
        if (cancelled) return;
        setFolder(info);
        const text = await readTextFile(info.story_path);
        if (!cancelled) setSource(text);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, setSource]);

  const autosave = useCallback(
    async (nextSource: string) => {
      if (!folder) return;
      try {
        await writeTextFile(folder.story_path, nextSource);
      } catch {
        /* surfaced in UI elsewhere if we add toast */
      }
    },
    [folder],
  );

  if (loadError) {
    return (
      <main
        id="main-content"
        className="mx-auto max-w-2xl p-8"
        role="alert"
      >
        <div className="flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4 text-sm text-[var(--color-danger)]">
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5" />
          <div>
            <p className="font-medium">Failed to open project</p>
            <p className="mt-1 text-[var(--color-fg-secondary)]">{loadError}</p>
            <Link
              to="/"
              className="mt-3 inline-flex items-center gap-1 text-[var(--color-accent-secondary)] hover:underline"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back to dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;

  return (
    <main
      id="main-content"
      className="flex h-full flex-col bg-[linear-gradient(180deg,#0f1319_0%,#0d1117_100%)]"
    >
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-white/6 bg-black/10 px-4 py-3 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-4">
          <Link
            to="/"
            aria-label="Back to dashboard"
            className="inline-flex items-center gap-1 rounded-md p-1 text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Link>
          <div className="min-w-0">
            <BrandLockup
              size={22}
              muted
              className="gap-2"
              wordmarkClassName="text-sm text-[var(--color-fg-secondary)]"
            />
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
              <span>project</span>
              <span className="text-[var(--color-fg-primary)]">
                {folder?.name ?? "Loading project"}
              </span>
              <span>script.dsl</span>
              <span className={errorCount > 0 ? "text-[var(--color-danger)]" : ""}>
                errors: {errorCount}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/settings"
            className="inline-flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 py-2 text-sm text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <Settings size={14} aria-hidden="true" />
            Settings
          </Link>
          {projectId ? (
            <Link
              to={`/recorder/${projectId}`}
              className="brand-button inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              <Video size={14} aria-hidden="true" />
              Record
            </Link>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
            <aside className="min-h-0 border-r border-white/6 bg-[linear-gradient(180deg,#151a22_0%,#121720_100%)]">
              <div className="flex h-full min-h-0 flex-col">
                <div className="border-b border-white/6 px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
                        Script DSL
                      </div>
                      <p className="mt-2 text-sm leading-6 text-[var(--color-fg-secondary)]">
                        Write the capture sequence directly, then refine timing and narration.
                      </p>
                    </div>
                    <div className="rounded-full border border-white/8 bg-black/14 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
                      lines
                      <span className="ml-2 text-[var(--color-fg-primary)]">
                        {source.split("\n").length}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  <StoryEditor onAutosave={autosave} />
                </div>
              </div>
            </aside>

            <section className="min-h-0 bg-[radial-gradient(circle_at_top,rgba(255,107,115,0.08),transparent_28rem)]">
              <div className="flex h-full min-h-0 flex-col gap-4 p-5">
                <div className="min-h-0 flex-[1.05]">
                  <PreviewPanel thumbnailPath={previewBackdrop} />
                </div>
                {projectId ? (
                  <div className="min-h-0 flex-[0.95]">
                    <VoiceoverWorkbench projectId={projectId} story={story} />
                  </div>
                ) : null}
              </div>
            </section>
          </div>

          <div className="h-52 min-h-0 border-t border-white/6 bg-[linear-gradient(180deg,#121720_0%,#0f141b_100%)]">
            <TimelinePanel />
          </div>
        </div>

        {projectId ? (
          <ChatPanel
            projectId={projectId}
            currentStory={source}
            sessionId={sessionId}
            className="shrink-0"
          />
        ) : null}
      </div>

      {projectId ? <VoiceCatalogDialog projectId={projectId} /> : null}
    </main>
  );
}
