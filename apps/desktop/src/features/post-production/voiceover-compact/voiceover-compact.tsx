import { invoke } from "@tauri-apps/api/core";
import { Mic2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { TtsClipInspector } from "@/features/voiceover/TtsClipInspector";
import { TtsScriptEditor } from "@/features/voiceover/TtsScriptEditor";
import { useVoiceoverStore } from "@/features/voiceover/voiceoverStore";
import type { Command, SelectorOrText, Story } from "@/ipc/parse";

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
  switch (target.kind) {
    case "text":
    case "selector":
    case "test_id":
    case "aria":
    case "label":
    case "text_exact":
      return target.value;
    case "role":
      return `${target.value.role} ${target.value.name}`;
  }
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

type StepStatus = "regenerating" | "out-of-sync-with-script" | "generated";

function computeStepStatus(
  stepId: string | null,
  generating: Set<string>,
  editedAfterGen: Record<string, boolean>,
): StepStatus {
  if (!stepId) return "generated";
  if (generating.has(stepId)) return "regenerating";
  if (editedAfterGen[stepId]) return "out-of-sync-with-script";
  return "generated";
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

/* Voiceover panel */

function VoiceoverHeader({
  onCatalogOpen,
  preset,
}: {
  onCatalogOpen?: () => void;
  preset?: { name: string } | null;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-3 py-1.5">
      <div className="flex items-center gap-2">
        <Mic2 size={11} className="text-[var(--sc-text-4)]" />
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
          Voiceover
        </span>
      </div>
      {onCatalogOpen ? (
        <button
          type="button"
          onClick={onCatalogOpen}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2 py-0.5 text-[10px] text-[var(--sc-text-2)] transition-colors hover:bg-[var(--sc-surface-3)] hover:text-[var(--sc-text)]"
        >
          <Sparkles size={10} />
          {preset ? preset.name : "Choose voice"}
        </button>
      ) : null}
    </div>
  );
}

export function VoiceoverCompact({
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
  const editedAfterGenByStepId = useVoiceoverStore((s) => s.editedAfterGenByStepId);
  const setCatalogOpen = useVoiceoverStore((s) => s.setCatalogOpen);
  const setScript = useVoiceoverStore((s) => s.setScript);
  const setClip = useVoiceoverStore((s) => s.setClip);
  const setGenerating = useVoiceoverStore((s) => s.setGenerating);
  const setEditedAfterGen = useVoiceoverStore((s) => s.setEditedAfterGen);

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
      current && sceneSteps.some((step) => step.id === current) ? current : sceneSteps[0].id,
    );
  }, [sceneSteps]);

  useEffect(() => {
    for (const step of steps) {
      if (!(step.id in scriptByStepId)) {
        setScript(step.id, step.suggestedScript);
      }
    }
  }, [scriptByStepId, steps, setScript]);

  const selectedStep = sceneSteps.find((step) => step.id === selectedStepId) ?? null;
  const selectedClip = selectedStep ? clipByStepId[selectedStep.id] : null;
  const selectedScript = selectedStep ? (scriptByStepId[selectedStep.id] ?? "") : "";
  const selectedStatus = computeStepStatus(
    selectedStep?.id ?? null,
    generating,
    editedAfterGenByStepId,
  );

  const handleRegenerate = useCallback(async () => {
    const preset = useVoiceoverStore.getState().selectedPreset;
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
        model: preset.provider === "elevenlabs" ? "eleven_multilingual_v2" : "tts-1",
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
  }, [projectId, selectedScript, selectedStep, setClip, setEditedAfterGen, setGenerating]);

  if (steps.length === 0) {
    return (
      <div className="flex h-full flex-col bg-[var(--sc-surface)]">
        <VoiceoverHeader />
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-[var(--sc-text-4)]">
          Parse a story to start attaching voiceover clips.
        </div>
      </div>
    );
  }

  if (sceneSteps.length === 0) {
    return (
      <div className="flex h-full flex-col bg-[var(--sc-surface)]">
        <VoiceoverHeader onCatalogOpen={() => setCatalogOpen(true)} preset={selectedPreset} />
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-[var(--sc-text-4)]">
          The selected scene has no voiceover steps yet.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--sc-surface)]">
      <VoiceoverHeader onCatalogOpen={() => setCatalogOpen(true)} preset={selectedPreset} />

      {story && story.scenes.length > 1 ? (
        <div className="flex gap-1 overflow-x-auto border-b border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2 py-1">
          {story.scenes.map((scene, sceneIndex) => {
            const isSelected = sceneIndex === activeSceneIndex;
            const label = scene.name || `Scene ${sceneIndex + 1}`;
            const voiceSteps = steps.filter((step) => step.sceneIndex === sceneIndex);
            const clipCount = voiceSteps.filter((step) => clipByStepId[step.id]).length;
            return (
              <button
                key={`voice-scene-${scene.span.start}`}
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
          <div className="truncate text-sm font-semibold text-[var(--sc-text)]">{sceneLabel}</div>
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
              const linePreview = summariseScript(scriptByStepId[step.id] ?? step.suggestedScript);

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
                  <div className="mt-1 text-xs text-[var(--sc-text-2)]">{selectedStep.label}</div>
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
