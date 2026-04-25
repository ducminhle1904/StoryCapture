/**
 * Per-step TTS script editor.
 *
 * States: empty, generating, generated, edited-not-regenerated, regen-in-progress, error.
 * Keeps the writing surface spare and focused on the line itself.
 */

import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

import { frontendLog } from "@/lib/log";

import { useVoiceoverStore } from "./voiceoverStore";

export interface TtsScriptEditorProps {
  projectId: string;
  stepId: string;
}

/** Soft char limit for warning */
const SOFT_LIMIT = 800;
const WARNING_THRESHOLD = 700;

export function TtsScriptEditor({ projectId, stepId }: TtsScriptEditorProps) {
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
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
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
        model:
          selectedPreset.provider === "elevenlabs"
            ? "eleven_multilingual_v2"
            : "tts-1",
      });
      setClip(stepId, {
        filePath: result.file_path,
        durationMs: result.audio_duration_ms,
        costUsd: result.cost_usd,
      });
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
  }, [projectId, stepId, script, selectedPreset, setClip, setGenerating, setEditedAfterGen]);

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
        model:
          selectedPreset.provider === "elevenlabs"
            ? "eleven_multilingual_v2"
            : "tts-1",
      });
      setClip(stepId, {
        filePath: result.file_path,
        durationMs: result.audio_duration_ms,
        costUsd: result.cost_usd,
      });
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
  }, [projectId, stepId, script, selectedPreset, setClip, setGenerating, setEditedAfterGen]);

  return (
    <div data-testid="tts-script-editor" className="flex flex-col gap-4">
      {!script && !clip ? (
        <div className="text-sm leading-relaxed text-[var(--muted-foreground)]">
          Write the line, then render a take.
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
            Narration
          </div>
          <div className="mt-1 truncate text-xs text-[var(--muted-foreground)]">
            {selectedPreset ? selectedPreset.name : "No voice selected"}
          </div>
        </div>

        {charCount >= WARNING_THRESHOLD ? (
          <span className="font-mono text-[11px] tabular-nums text-[var(--warning)]">
            {charCount} / {SOFT_LIMIT}
          </span>
        ) : null}
      </div>

      {/* Textarea */}
      <textarea
        className="font-serif min-h-[172px] w-full resize-none rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--background)] px-4 py-3.5 text-[14px] leading-6 text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        value={script}
        onChange={handleTextChange}
        placeholder="Write the narration for this step..."
        rows={6}
        role="textbox"
      />

      {/* Stale warning chip */}
      {isEditedAfterGen && clip && (
        <div className="text-xs text-[var(--warning)]">
          The script changed since the last take.
        </div>
      )}

      {/* Footer row */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-[var(--muted-foreground)]">
          {clip
            ? "A take is ready for this step."
            : selectedPreset
              ? "Ready to render."
              : "Choose a voice to continue."}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          {!clip && (
            <button
              type="button"
              className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg-primary)] transition-colors hover:bg-[var(--accent)]/90 disabled:opacity-50"
              onClick={handleGenerate}
              disabled={isGenerating || !script.trim() || !selectedPreset}
              aria-label="Generate audio"
            >
              {isGenerating ? "Generating..." : "Generate audio"}
            </button>
          )}
          {clip && (
            <button
              type="button"
              className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--foreground)]/5 disabled:opacity-50"
              onClick={handleRegenerate}
              disabled={isGenerating || !script.trim() || !selectedPreset}
            >
              {isGenerating ? "Regenerating..." : "Regenerate audio"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
