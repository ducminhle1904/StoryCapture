/**
 * Selection slice. Tracks which clip / preset is currently selected and
 * which inspector tab is active. Non-persisted: reloading the editor
 * always starts with nothing selected and the 'presets' tab active.
 */

import type { StateCreator } from "zustand";

export type InspectorTab = "presets" | "effects" | "background" | "sound";

export interface SelectionSlice {
  selectedClipId: string | null;
  selectedPresetId: string | null;
  selectedTab: InspectorTab;

  setSelectedClipId: (id: string | null) => void;
  setSelectedPresetId: (id: string | null) => void;
  setSelectedTab: (tab: InspectorTab) => void;
}

export const createSelectionSlice: StateCreator<SelectionSlice, [], [], SelectionSlice> = (
  set,
  get,
) => ({
  selectedClipId: null,
  selectedPresetId: null,
  selectedTab: "presets",

  setSelectedClipId: (id) => {
    const state = get();
    const nextTab = id ? "effects" : state.selectedTab;
    if (state.selectedClipId === id && state.selectedTab === nextTab) return;
    set({ selectedClipId: id, selectedTab: nextTab });
  },
  setSelectedPresetId: (id) => {
    if (get().selectedPresetId === id) return;
    set({ selectedPresetId: id });
  },
  setSelectedTab: (tab) => {
    if (get().selectedTab === tab) return;
    set({ selectedTab: tab });
  },
});
