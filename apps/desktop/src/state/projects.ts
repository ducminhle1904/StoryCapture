/**
 * Dashboard client-side UI state (search query, filter tags, sort).
 * Server state lives in TanStack Query (see `ipc/projects.ts`).
 */

import { create } from "zustand";
import type { OnboardingProjectDraft } from "@/features/dashboard/project-draft";

export type SortMode = "recent" | "name";

interface DashboardState {
  searchQuery: string;
  filterTags: string[];
  sortMode: SortMode;
  newProjectRequested: boolean;
  newProjectDraft: OnboardingProjectDraft | null;
  paletteOpen: boolean;
  setSearchQuery: (q: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  setSortMode: (m: SortMode) => void;
  requestNewProject: (draft?: OnboardingProjectDraft) => void;
  consumeNewProjectRequest: () => void;
  clearNewProjectDraft: () => void;
  setPaletteOpen: (open: boolean) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  searchQuery: "",
  filterTags: [],
  sortMode: "recent",
  newProjectRequested: false,
  newProjectDraft: null,
  paletteOpen: false,
  setSearchQuery: (q) => set({ searchQuery: q }),
  toggleTag: (tag) =>
    set((s) => ({
      filterTags: s.filterTags.includes(tag)
        ? s.filterTags.filter((t) => t !== tag)
        : [...s.filterTags, tag],
    })),
  clearTags: () => set({ filterTags: [] }),
  setSortMode: (m) => set({ sortMode: m }),
  requestNewProject: (draft) => set({ newProjectRequested: true, newProjectDraft: draft ?? null }),
  consumeNewProjectRequest: () => set({ newProjectRequested: false }),
  clearNewProjectDraft: () => set({ newProjectDraft: null }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
}));
