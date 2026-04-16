/**
 * Per-step TTS script editor (Plan 03-19).
 *
 * States: empty, generating, generated, edited-not-regenerated, regen-in-progress, error.
 * Shows char count, cost estimate, and Sinh loi thoai / Tao lai audio buttons.
 */

import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVoiceoverStore } from "./voiceoverStore";

export interface TtsScriptEditorProps {
  projectId: string;
  stepId: string;
}

/** ElevenLabs rate: $0.30 per 1K chars */
const COST_RATE_PER_1K = 0.30;
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
  const costEstimate = (charCount * COST_RATE_PER_1K) / 1000;

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
      console.error("TTS generation failed:", err);
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
      console.error("TTS regeneration failed:", err);
    } finally {
      setGenerating(stepId, false);
    }
  }, [projectId, stepId, script, selectedPreset, setClip, setGenerating, setEditedAfterGen]);

  // Empty state
  if (!script && !clip) {
    return (
      <div
        data-testid="tts-script-editor"
        className="flex flex-col items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-6"
      >
        <p className="text-sm text-[var(--muted-foreground)]">
          {`Ch\u01b0a c\u00f3 l\u1eddi tho\u1ea1i cho b\u01b0\u1edbc n\u00e0y`}
        </p>
        <p className="text-xs text-[var(--muted-foreground)]">
          {`Sinh t\u1ef1 \u0111\u1ed9ng t\u1eeb n\u1ed9i dung DSL, ho\u1eb7c vi\u1ebft tay b\u00ean d\u01b0\u1edbi.`}
        </p>
        <button
          type="button"
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent)]/90"
          aria-label={`Sinh l\u1eddi tho\u1ea1i`}
          onClick={handleGenerate}
        >
          {`Sinh l\u1eddi tho\u1ea1i`}
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="tts-script-editor"
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
    >
      {/* Textarea */}
      <textarea
        className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        value={script}
        onChange={handleTextChange}
        placeholder={`Vi\u1EBFt l\u1EDDi tho\u1EA1i cho b\u01B0\u1EDBc n\u00E0y...`}
        rows={3}
        role="textbox"
      />

      {/* Stale warning chip */}
      {isEditedAfterGen && clip && (
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-[var(--warning)]/15 px-2 py-0.5 text-xs font-medium text-[var(--warning)]">
            {`\u0110\u00e3 s\u1eeda, ch\u01b0a t\u1ea1o l\u1ea1i audio`}
          </span>
        </div>
      )}

      {/* Footer row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Char count */}
          <span
            className={`font-mono text-xs ${
              charCount >= WARNING_THRESHOLD
                ? "text-[var(--warning)]"
                : "text-[var(--muted-foreground)]"
            }`}
          >
            {charCount} / {SOFT_LIMIT}
          </span>
          {/* Cost estimate */}
          <span
            data-testid="cost-estimate"
            className="font-mono text-xs text-[var(--muted-foreground)]"
            style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "12px" }}
          >
            {charCount} {`k\u00fd t\u1ef1`} {"\u00d7"} ${COST_RATE_PER_1K}/1K {"\u2248"} ${costEstimate.toFixed(4)}
          </span>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          {!clip && (
            <button
              type="button"
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent)]/90 disabled:opacity-50"
              onClick={handleGenerate}
              disabled={isGenerating || !script.trim()}
              aria-label={`Sinh l\u1eddi tho\u1ea1i`}
            >
              {isGenerating ? `\u0110ang sinh...` : `Sinh l\u1eddi tho\u1ea1i`}
            </button>
          )}
          {clip && (
            <button
              type="button"
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent)]/90 disabled:opacity-50"
              onClick={handleRegenerate}
              disabled={isGenerating || !script.trim()}
            >
              {isGenerating ? `\u0110ang t\u1ea1o l\u1ea1i...` : `T\u1ea1o l\u1ea1i audio`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
