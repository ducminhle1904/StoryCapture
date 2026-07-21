/**
 * Per-step TTS script editor.
 *
 * States: empty, generating, generated, edited-not-regenerated, regen-in-progress, error.
 * Keeps the writing surface spare and focused on the line itself.
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { TextArea as AstryxTextArea } from "@astryxdesign/core/TextArea";
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import type { VoiceoverStepBinding } from "@/features/post-production/state/voiceover-timeline";
import { frontendLog } from "@/lib/log";

import { useVoiceoverStore } from "./voiceoverStore";

export interface TtsScriptEditorProps {
  projectId: string;
  stepId: string;
  stepBinding?: VoiceoverStepBinding;
}

/** Soft char limit for warning */
const SOFT_LIMIT = 800;
const WARNING_THRESHOLD = 700;

export function TtsScriptEditor({ projectId, stepId, stepBinding }: TtsScriptEditorProps) {
  const {
    selectedPreset,
    scriptByStepId,
    clipByStepId,
    generating,
    editedAfterGenByStepId,
    setScript,
    setClip,
    setGenerating,
    setEditedAfterGen,
  } = useVoiceoverStore();

  const script = scriptByStepId[stepId] ?? "";
  const clip = clipByStepId[stepId];
  const isGenerating = generating.has(stepId);
  const isEditedAfterGen = editedAfterGenByStepId[stepId] ?? false;
  const charCount = script.length;

  const handleTextChange = useCallback(
    (newText: string) => {
      setScript(stepId, newText);
      if (clip) {
        setEditedAfterGen(stepId, true);
      }
    },
    [stepId, clip, setScript, setEditedAfterGen],
  );

  const handleGenerate = useCallback(async () => {
    if (!selectedPreset || !script.trim()) return;
    setGenerating(stepId, true);
    try {
      const result = await invoke<{
        file_path: string;
        audio_duration_ms: number;
        cost_usd: number;
        cache_hit: boolean;
      }>("tts_generate", {
        projectId,
        stepId,
        scriptText: script,
        provider: selectedPreset.provider,
        voiceId: selectedPreset.id,
        model: selectedPreset.provider === "elevenlabs" ? "eleven_multilingual_v2" : "tts-1",
      });
      setClip(
        stepId,
        {
          filePath: result.file_path,
          durationMs: result.audio_duration_ms,
          costUsd: result.cost_usd,
        },
        stepBinding,
      );
      setEditedAfterGen(stepId, false);
    } catch (err) {
      frontendLog.error("TtsScriptEditor", "tts_generate IPC failed", {
        error: err,
        fields: {
          project_id: projectId,
          step_id: stepId,
          provider: selectedPreset.provider,
          voice_id: selectedPreset.id,
        },
      });
    } finally {
      setGenerating(stepId, false);
    }
  }, [
    projectId,
    stepId,
    stepBinding,
    script,
    selectedPreset,
    setClip,
    setGenerating,
    setEditedAfterGen,
  ]);

  const handleRegenerate = useCallback(async () => {
    if (!selectedPreset || !script.trim()) return;
    setGenerating(stepId, true);
    try {
      const result = await invoke<{
        file_path: string;
        audio_duration_ms: number;
        cost_usd: number;
        cache_hit: boolean;
      }>("tts_regenerate_clip", {
        projectId,
        stepId,
        scriptText: script,
        provider: selectedPreset.provider,
        voiceId: selectedPreset.id,
        model: selectedPreset.provider === "elevenlabs" ? "eleven_multilingual_v2" : "tts-1",
      });
      setClip(
        stepId,
        {
          filePath: result.file_path,
          durationMs: result.audio_duration_ms,
          costUsd: result.cost_usd,
        },
        stepBinding,
      );
      setEditedAfterGen(stepId, false);
    } catch (err) {
      frontendLog.error("TtsScriptEditor", "tts_regenerate_clip IPC failed", {
        error: err,
        fields: {
          project_id: projectId,
          step_id: stepId,
          provider: selectedPreset.provider,
          voice_id: selectedPreset.id,
        },
      });
    } finally {
      setGenerating(stepId, false);
    }
  }, [
    projectId,
    stepId,
    stepBinding,
    script,
    selectedPreset,
    setClip,
    setGenerating,
    setEditedAfterGen,
  ]);

  return (
    <div data-testid="tts-script-editor" className="flex flex-col gap-4">
      {!script && !clip ? (
        <div className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
          Write the line, then render a take.
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
            Narration
          </div>
          <div className="mt-1 truncate text-xs text-[var(--color-text-secondary)]">
            {selectedPreset ? selectedPreset.name : "No voice selected"}
          </div>
        </div>

        {charCount >= WARNING_THRESHOLD ? (
          <span className="font-mono text-[11px] tabular-nums text-[var(--color-warning)]">
            {charCount} / {SOFT_LIMIT}
          </span>
        ) : null}
      </div>

      {/* Textarea */}
      <AstryxTextArea
        label="Narration script"
        isLabelHidden
        className="font-serif"
        value={script}
        onChange={handleTextChange}
        placeholder="Write the narration for this step..."
        rows={6}
        width="100%"
      />

      {/* Stale warning chip */}
      {isEditedAfterGen && clip && (
        <div className="text-xs text-[var(--color-warning)]">
          The script changed since the last take.
        </div>
      )}

      {/* Footer row */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-[var(--color-text-secondary)]">
          {clip
            ? "A take is ready for this step."
            : selectedPreset
              ? "Ready to render."
              : "Choose a voice to continue."}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          {!clip && (
            <AstryxButton
              variant="primary"
              size="sm"
              onClick={handleGenerate}
              isDisabled={isGenerating || !script.trim() || !selectedPreset}
              label="Generate audio"
            >
              {isGenerating ? "Generating..." : "Generate audio"}
            </AstryxButton>
          )}
          {clip && (
            <AstryxButton
              variant="secondary"
              size="sm"
              onClick={handleRegenerate}
              isDisabled={isGenerating || !script.trim() || !selectedPreset}
              label="Regenerate audio"
            >
              {isGenerating ? "Regenerating..." : "Regenerate audio"}
            </AstryxButton>
          )}
        </div>
      </div>
    </div>
  );
}
