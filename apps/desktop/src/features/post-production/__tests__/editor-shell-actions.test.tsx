import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditorShell } from "../editor-shell";
import { useEditorStore } from "../state/store";
import { COALESCE_IDLE_MS, Coalescer } from "../undo/coalesce";
import { HISTORY_CAP, HistoryBuffer } from "../undo/history-buffer";

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(() => Promise.reject(new Error("not loaded in toolbar tests"))),
}));

vi.mock("@/ipc/projects", () => ({
  fetchProjectFolder: vi.fn(() => Promise.reject(new Error("not loaded"))),
  useProjectRecordings: vi.fn(() => ({
    data: [],
    isSuccess: true,
    isError: false,
  })),
}));

vi.mock("@/ipc/parse", () => ({
  parseStory: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/ipc/actions", () => ({
  useRecordingActions: vi.fn(() => ({ data: null, isLoading: false, isSuccess: true })),
}));

vi.mock("@/ipc/trajectory", () => ({
  useRecordingStepTiming: vi.fn(() => ({ data: null, isLoading: false })),
  useRecordingTrajectory: vi.fn(() => ({ data: null, isLoading: false })),
}));

vi.mock("@/components/preview-surface", () => ({
  PreviewSurface: () => <div data-testid="preview-surface" />,
}));

vi.mock("@/features/voiceover/VoiceCatalogDialog", () => ({
  VoiceCatalogDialog: () => null,
}));

vi.mock("../render-queue/queue-widget", () => ({
  QueueWidget: () => null,
}));

vi.mock("../sound-browser/sound-drawer", () => ({
  SoundDrawer: () => null,
}));

vi.mock("../export-modal/export-modal", () => ({
  ExportModal: () => null,
}));

vi.mock("../hooks/use-hotkeys", () => ({
  useEditorHotkeys: () => undefined,
}));

function resetStore() {
  useEditorStore.setState({
    tracks: { video: [], cursor: [], zoom: [], sound: [], annotations: [] },
    playheadMs: 2_500,
    snapEnabled: true,
    durationMs: 10_000,
    selectedClipId: null,
    selectedPresetId: null,
    selectedTab: "effects",
    soundDrawerOpen: false,
    exportModalOpen: false,
    activeJobs: {},
    progressByJobId: {},
    history: new HistoryBuffer(HISTORY_CAP),
    coalescer: new Coalescer(COALESCE_IDLE_MS),
    canUndo: false,
    canRedo: false,
  });
}

beforeEach(() => {
  resetStore();
});

describe("EditorShell toolbar actions", () => {
  it("adds a default zoom clip at the current playhead", () => {
    render(
      <MemoryRouter>
        <EditorShell storyId="story-1" videoSrc="/recording.mp4" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add zoom clip" }));

    const state = useEditorStore.getState();
    expect(state.tracks.zoom).toHaveLength(1);
    expect(state.tracks.zoom[0]).toMatchObject({
      trackId: "zoom",
      startMs: 2_500,
      durationMs: 1_000,
      label: "Zoom 1.5x",
      target: { kind: "cursor" },
      scale: 1.5,
      center: { x: 0.5, y: 0.5 },
      preset: "DYNAMIC",
    });
    expect(state.selectedClipId).toBe(state.tracks.zoom[0]?.id);
    expect(state.selectedTab).toBe("effects");
    expect(state.canUndo).toBe(true);

    state.undo();
    expect(useEditorStore.getState().tracks.zoom).toHaveLength(0);
  });

  it("adds a default text annotation clip at the current playhead", () => {
    render(
      <MemoryRouter>
        <EditorShell storyId="story-1" videoSrc="/recording.mp4" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add text clip" }));

    const state = useEditorStore.getState();
    expect(state.tracks.annotations).toHaveLength(1);
    expect(state.tracks.annotations[0]).toMatchObject({
      trackId: "annotations",
      startMs: 2_500,
      durationMs: 1_000,
      label: "Title",
      text: "Title",
      pos: { x: 0.5, y: 0.9 },
      sizePt: 24,
      color: "#ffffff",
    });
    expect(state.selectedClipId).toBe(state.tracks.annotations[0]?.id);
    expect(state.selectedTab).toBe("effects");
    expect(state.canUndo).toBe(true);

    state.undo();
    expect(useEditorStore.getState().tracks.annotations).toHaveLength(0);
  });

  it("opens fine tune and selects the target clip from a review fix item", () => {
    useEditorStore.setState((state) => ({
      tracks: {
        ...state.tracks,
        zoom: Array.from({ length: 11 }, (_, index) => ({
          id: `zoom-${index}`,
          trackId: "zoom" as const,
          startMs: 1_000 + index * 100,
          durationMs: 900,
          label: "Script zoom",
          target: { kind: "cursor" as const },
          scale: 1.5,
          center: { x: 0.5, y: 0.5 },
          preset: "DYNAMIC" as const,
        })),
      },
    }));

    render(
      <MemoryRouter>
        <EditorShell storyId="story-1" videoSrc="/recording.mp4" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("Dense zoom pacing"));

    const state = useEditorStore.getState();
    expect(state.selectedClipId).toBe("zoom-0");
    expect(state.selectedTab).toBe("effects");
    expect(state.playheadMs).toBe(1_000);
  });
});
