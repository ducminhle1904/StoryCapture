import { create } from "zustand";
import type { Diagnostic, ParseResult, Story } from "@/ipc/parse";

export type PreviewViewport = "desktop" | "tablet" | "mobile";

export const VIEWPORT_SIZES: Record<
  PreviewViewport,
  { w: number; h: number }
> = {
  desktop: { w: 1280, h: 800 },
  tablet: { w: 768, h: 1024 },
  mobile: { w: 375, h: 667 },
};

interface EditorState {
  source: string;
  splitRatio: number;
  previewViewport: PreviewViewport;
  lastParse: ParseResult | null;
  // Most recent parse with zero error diagnostics. Survives transient parse errors so
  // scene-list-panel can keep showing the last-valid tree instead of blanking.
  lastValidStoryAst: Story | null;
  previewEnabled: boolean;
  previewStreamId: string | null;
  setSource: (s: string) => void;
  setSplitRatio: (r: number) => void;
  setViewport: (v: PreviewViewport) => void;
  setLastParse: (r: ParseResult) => void;
  setPreviewEnabled: (v: boolean) => void;
  setPreviewStreamId: (id: string | null) => void;
  diagnostics: () => Diagnostic[];
  resetProjectState: () => void;
}

function pickValidAst(parse: ParseResult, prev: Story | null): Story | null {
  const hasError = parse.diagnostics.some((d) => d.severity === "error");
  if (!hasError && parse.ast) return parse.ast;
  return prev;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  source: "",
  splitRatio: 60,
  previewViewport: "desktop",
  lastParse: null,
  lastValidStoryAst: null,
  previewEnabled: false,
  previewStreamId: null,
  setSource: (s) => set({ source: s }),
  setSplitRatio: (r) => set({ splitRatio: Math.max(20, Math.min(80, r)) }),
  setViewport: (v) => {
    if (get().previewViewport === v) return;
    set({ previewViewport: v });
  },
  setLastParse: (r) =>
    set((s) => ({ lastParse: r, lastValidStoryAst: pickValidAst(r, s.lastValidStoryAst) })),
  setPreviewEnabled: (v) => {
    if (get().previewEnabled === v) return;
    set({ previewEnabled: v });
  },
  setPreviewStreamId: (id) => {
    if (get().previewStreamId === id) return;
    set({ previewStreamId: id });
  },
  diagnostics: () => get().lastParse?.diagnostics ?? [],
  // Clear per-project fields so navigating A→B doesn't flash A's content.
  resetProjectState: () =>
    set({
      source: "",
      lastParse: null,
      lastValidStoryAst: null,
      previewStreamId: null,
      previewEnabled: false,
    }),
}));
