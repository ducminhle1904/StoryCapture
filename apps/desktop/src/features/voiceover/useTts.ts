/**
 * Hook for TTS operations.
 *
 * Wires to Plan 11 Tauri commands: tts_generate, tts_voice_list,
 * tts_regenerate_clip. Provides voice preview via HTMLAudioElement.
 */

import { invoke } from "@tauri-apps/api/core";

import { frontendLog } from "@/lib/log";

import { useVoiceoverStore, type VoicePreset } from "./voiceoverStore";

export interface VoiceInfo {
  id: string;
  name: string;
  locale: string | null;
  premium: boolean;
}

export interface TtsGenerateResult {
  file_path: string;
  audio_duration_ms: number;
  cost_usd: number;
  cache_hit: boolean;
}

export function useTts(projectId: string) {
  const store = useVoiceoverStore();

  const listVoices = (provider: string): Promise<VoiceInfo[]> =>
    invoke<VoiceInfo[]>("tts_voice_list", { provider });

  const generate = (
    stepId: string,
    scriptText: string,
    preset: VoicePreset,
    model: string,
  ): Promise<TtsGenerateResult> =>
    invoke<TtsGenerateResult>("tts_generate", {
      projectId,
      stepId,
      scriptText,
      provider: preset.provider,
      voiceId: preset.id,
      model,
    });

  const regenerate = (
    stepId: string,
    scriptText: string,
    preset: VoicePreset,
    model: string,
  ): Promise<TtsGenerateResult> =>
    invoke<TtsGenerateResult>("tts_regenerate_clip", {
      projectId,
      stepId,
      scriptText,
      provider: preset.provider,
      voiceId: preset.id,
      model,
    });

  const preview = async (preset: VoicePreset): Promise<void> => {
    const result = await generate(
      "preview",
      "This is a sample narration.",
      preset,
      preset.provider === "elevenlabs"
        ? "eleven_multilingual_v2"
        : "tts-1",
    );
    const audio = new Audio(result.file_path);
    audio.onerror = () => {
      // Browser audio decoder sandboxed; play failure caught
      frontendLog.error("useTts.preview", "audio playback failed", {
        fields: {
          file_path: result.file_path,
          provider: preset.provider,
          voice_id: preset.id,
          media_error_code: audio.error?.code ?? null,
          media_error_message: audio.error?.message ?? null,
        },
      });
    };
    await audio.play();
  };

  return {
    listVoices,
    generate,
    regenerate,
    preview,
    store,
  };
}
