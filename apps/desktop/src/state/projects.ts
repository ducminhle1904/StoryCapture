/**
 * Dashboard client-side UI state (search query, filter tags, sort).
 * Server state lives in TanStack Query (see `ipc/projects.ts`).
 */

import { create } from "zustand";

export type SortMode = "recent" | "name";

interface DashboardState {
  searchQuery: string;
  filterTags: string[];
  sortMode: SortMode;
  setSearchQuery: (q: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  setSortMode: (m: SortMode) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  searchQuery: "",
  filterTags: [],
  sortMode: "recent",
  setSearchQuery: (q) => set({ searchQuery: q }),
  toggleTag: (tag) =>
    set((s) => ({
      filterTags: s.filterTags.includes(tag)
        ? s.filterTags.filter((t) => t !== tag)
        : [...s.filterTags, tag],
    })),
  clearTags: () => set({ filterTags: [] }),
  setSortMode: (m) => set({ sortMode: m }),
}));
