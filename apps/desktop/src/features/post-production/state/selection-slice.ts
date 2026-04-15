/**
 * Selection slice (Plan 02-12a).
 *
 * Tracks which clip / preset is currently selected and which inspector
 * tab is active. Kept small + non-persisted: reloading the editor
 * always starts with nothing selected and the 'presets' tab active.
 */

import type { StateCreator } from "zustand";

export type InspectorTab = "presets" | "effects" | "sound";

export interface SelectionSlice {
  selectedClipId: string | null;
  selectedPresetId: string | null;
  selectedTab: InspectorTab;

  setSelectedClipId: (id: string | null) => void;
  setSelectedPresetId: (id: string | null) => void;
  setSelectedTab: (tab: InspectorTab) => void;
}

export const createSelectionSlice: StateCreator<
  SelectionSlice,
  [],
  [],
  SelectionSlice
> = (set) => ({
  selectedClipId: null,
  selectedPresetId: null,
  selectedTab: "presets",

  setSelectedClipId: (id) => set({ selectedClipId: id }),
  setSelectedPresetId: (id) => set({ selectedPresetId: id }),
  setSelectedTab: (tab) => set({ selectedTab: tab }),
});
