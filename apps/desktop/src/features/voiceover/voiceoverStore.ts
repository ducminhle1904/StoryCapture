/**
 * Zustand store for Voiceover UI state (Plan 03-19).
 *
 * Tracks selected voice preset, catalog modal state, filters,
 * per-step TTS clips, and generation progress.
 */

import { create } from "zustand";

export interface VoicePreset {
  id: string;
  name: string;
  locale?: string;
  premium: boolean;
  provider: "elevenlabs" | "openai_tts";
  featured?: boolean;
}

export interface TtsClip {
  filePath: string;
  durationMs: number;
  costUsd: number;
}

export interface VoiceoverStore {
  selectedPreset: VoicePreset | null;
  catalogOpen: boolean;
  catalogMode: "curated" | "expanded";
  filter: { locale?: string; premium?: boolean };
  clipByStepId: Record<string, TtsClip>;
  generating: Set<string>;
  // Script editor state
  scriptByStepId: Record<string, string>;
  editedAfterGenByStepId: Record<string, boolean>;
  // Actions
  setSelectedPreset: (preset: VoicePreset | null) => void;
  setCatalogOpen: (open: boolean) => void;
  setCatalogMode: (mode: "curated" | "expanded") => void;
  setFilter: (filter: { locale?: string; premium?: boolean }) => void;
  setClip: (stepId: string, clip: TtsClip) => void;
  setGenerating: (stepId: string, active: boolean) => void;
  setScript: (stepId: string, text: string) => void;
  setEditedAfterGen: (stepId: string, edited: boolean) => void;
}

export const useVoiceoverStore = create<VoiceoverStore>((set) => ({
  selectedPreset: null,
  catalogOpen: false,
  catalogMode: "curated",
  filter: {},
  clipByStepId: {},
  generating: new Set(),
  scriptByStepId: {},
  editedAfterGenByStepId: {},

  setSelectedPreset: (preset) => set({ selectedPreset: preset }),

  setCatalogOpen: (open) => set({ catalogOpen: open }),

  setCatalogMode: (mode) => set({ catalogMode: mode }),

  setFilter: (filter) => set({ filter }),

  setClip: (stepId, clip) =>
    set((s) => ({
      clipByStepId: { ...s.clipByStepId, [stepId]: clip },
    })),

  setGenerating: (stepId, active) =>
    set((s) => {
      const next = new Set(s.generating);
      if (active) {
        next.add(stepId);
      } else {
        next.delete(stepId);
      }
      return { generating: next };
    }),

  setScript: (stepId, text) =>
    set((s) => ({
      scriptByStepId: { ...s.scriptByStepId, [stepId]: text },
    })),

  setEditedAfterGen: (stepId, edited) =>
    set((s) => ({
      editedAfterGenByStepId: { ...s.editedAfterGenByStepId, [stepId]: edited },
    })),
}));
