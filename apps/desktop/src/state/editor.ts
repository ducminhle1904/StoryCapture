import { create } from "zustand";
import type { Diagnostic, ParseResult } from "@/ipc/parse";

export type PreviewViewport = "desktop" | "tablet" | "mobile";

interface EditorState {
  source: string;
  splitRatio: number;
  previewViewport: PreviewViewport;
  lastParse: ParseResult | null;
  setSource: (s: string) => void;
  setSplitRatio: (r: number) => void;
  setViewport: (v: PreviewViewport) => void;
  setLastParse: (r: ParseResult) => void;
  diagnostics: () => Diagnostic[];
}

export const useEditorStore = create<EditorState>((set, get) => ({
  source: "",
  splitRatio: 60,
  previewViewport: "desktop",
  lastParse: null,
  setSource: (s) => set({ source: s }),
  setSplitRatio: (r) => set({ splitRatio: Math.max(20, Math.min(80, r)) }),
  setViewport: (v) => set({ previewViewport: v }),
  setLastParse: (r) => set({ lastParse: r }),
  diagnostics: () => get().lastParse?.diagnostics ?? [],
}));
