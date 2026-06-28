import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditorShell } from "../editor-shell";
import { useEditorStore } from "../state/store";
import { COALESCE_IDLE_MS, Coalescer } from "../undo/coalesce";
import { HISTORY_CAP, HistoryBuffer } from "../undo/history-buffer";

const ipcMocks = vi.hoisted(() => ({
  fetchProjectFolder: vi.fn(),
  timelineLoad: vi.fn(),
  timelineSave: vi.fn(),
  useProjectRecordings: vi.fn(),
  useRecordingActions: vi.fn(),
  useRecordingStepTiming: vi.fn(),
  useRecordingTrajectory: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(() => Promise.resolve(false)),
  readTextFile: vi.fn(() => Promise.reject(new Error("not loaded in toolbar tests"))),
}));

vi.mock("@/ipc/projects", () => ({
  fetchProjectFolder: ipcMocks.fetchProjectFolder,
  useProjectRecordings: ipcMocks.useProjectRecordings,
}));

vi.mock("@/ipc/timeline", () => ({
  timelineLoad: ipcMocks.timelineLoad,
  timelineSave: ipcMocks.timelineSave,
}));

vi.mock("@/ipc/parse", () => ({
  parseStory: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/ipc/actions", () => ({
  useRecordingActions: ipcMocks.useRecordingActions,
}));

vi.mock("@/ipc/trajectory", () => ({
  useRecordingStepTiming: ipcMocks.useRecordingStepTiming,
  useRecordingTrajectory: ipcMocks.useRecordingTrajectory,
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
  ipcMocks.fetchProjectFolder.mockRejectedValue(new Error("not loaded"));
  ipcMocks.timelineLoad.mockResolvedValue(null);
  ipcMocks.timelineSave.mockResolvedValue(undefined);
  ipcMocks.useProjectRecordings.mockReturnValue({
    data: [],
    isSuccess: true,
    isError: false,
  });
  ipcMocks.useRecordingActions.mockReturnValue({
    data: null,
    isLoading: false,
    isSuccess: true,
  });
  ipcMocks.useRecordingStepTiming.mockReturnValue({ data: null, isLoading: false });
  ipcMocks.useRecordingTrajectory.mockReturnValue({ data: null, isLoading: false });
});

describe("EditorShell toolbar actions", () => {
  it("adds a default zoom clip at the current playhead", () => {
    render(
      <MemoryRouter>
        <EditorShell storyId="story-1" videoSrc="/recording.mp4" />
      </MemoryRouter>,
    );
    useEditorStore.getState().setPlayhead(2_500);

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
    useEditorStore.getState().setPlayhead(2_500);

    fireEvent.click(screen.getByRole("button", { name: "Add text clip" }));

    const state = useEditorStore.getState();
    expect(state.tracks.annotations).toHaveLength(1);
    expect(state.tracks.annotations[0]).toMatchObject({
      trackId: "annotations",
      startMs: 2_500,
      durationMs: 2_200,
      label: "Title",
      text: "Title",
      pos: { x: 0.5, y: 0.78 },
      sizePt: 34,
      color: "#ffffff",
      styleId: "title",
      align: "center",
      anchor: { kind: "screen", pos: { x: 0.5, y: 0.78 } },
      animation: { in: "slide-up", out: "fade", durationMs: 220 },
    });
    expect(state.selectedClipId).toBe(state.tracks.annotations[0]?.id);
    expect(state.selectedTab).toBe("effects");
    expect(state.canUndo).toBe(true);

    state.undo();
    expect(useEditorStore.getState().tracks.annotations).toHaveLength(0);
  });

  it("opens fine tune and selects the target clip from a review fix item", async () => {
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

    fireEvent.click(await screen.findByText("Dense zoom pacing"));

    const state = useEditorStore.getState();
    expect(state.selectedClipId).toBe("zoom-0");
    expect(state.selectedTab).toBe("effects");
    expect(state.playheadMs).toBe(1_000);
  });

  it("sets timeline duration from generated tracks during recording bootstrap", async () => {
    resetStore();
    useEditorStore.setState({ durationMs: 0 });
    ipcMocks.useProjectRecordings.mockReturnValue({
      data: [
        {
          path: "/recordings/full-duration.mp4",
          captured_at: 1,
          duration_ms: 40_064,
          width: 1920,
          height: 1080,
        },
      ],
      isSuccess: true,
      isError: false,
    });

    render(
      <MemoryRouter>
        <EditorShell storyId="story-1" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const state = useEditorStore.getState();
      expect(state.tracks.video[0]?.durationMs).toBe(40_064);
      expect(state.durationMs).toBe(40_064);
    });
  });

  it("rebuilds the timeline when the saved layout points at an older recording", async () => {
    resetStore();
    useEditorStore.setState({ durationMs: 0 });
    ipcMocks.timelineLoad.mockResolvedValue({
      story_id: "story-1",
      layout_json: JSON.stringify({
        version: 1,
        tracks: {
          video: [
            {
              id: "video-old",
              trackId: "video",
              startMs: 0,
              durationMs: 1_000,
              sourcePath: "/recordings/old.mp4",
            },
          ],
          cursor: [],
          zoom: [],
          sound: [],
          annotations: [],
        },
        durationMs: 1_000,
        background: { kind: "transparent" },
      }),
      last_modified: 1,
    });
    ipcMocks.useProjectRecordings.mockReturnValue({
      data: [
        {
          path: "/recordings/new.mp4",
          captured_at: 2,
          duration_ms: 2_500,
          width: 1280,
          height: 720,
        },
      ],
      isSuccess: true,
      isError: false,
    });

    render(
      <MemoryRouter>
        <EditorShell storyId="story-1" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const state = useEditorStore.getState();
      expect(state.tracks.video[0]?.sourcePath).toBe("/recordings/new.mp4");
      expect(state.tracks.video[0]?.durationMs).toBe(2_500);
      expect(state.durationMs).toBe(2_500);
    });
  });

  it("treats an actions sidecar as review timing data", () => {
    ipcMocks.useProjectRecordings.mockReturnValue({
      data: [
        {
          path: "/recordings/action-timed.mp4",
          captured_at: 1,
          duration_ms: 1_233,
          width: 1280,
          height: 720,
        },
      ],
      isSuccess: true,
      isError: false,
    });
    ipcMocks.useRecordingActions.mockReturnValue({
      data: {
        version: 1,
        recording_path: "/recordings/action-timed.mp4",
        viewport: { width: 1280, height: 720 },
        capture_rect: { x: 0, y: 0, width: 1280, height: 720 },
        fps: 60,
        frame_count: 74,
        events: [
          {
            step_id: "step-1",
            ordinal: 1,
            verb: "click",
            t_start_ms: 100,
            t_action_ms: 120,
            t_end_ms: 240,
            target: {
              kind: "element",
              label: "Start",
              center: { x: 100, y: 120 },
              bounds: { x: 80, y: 100, w: 40, h: 40 },
            },
            secondary_target: null,
            pointer: { button: "left", effect: "click" },
          },
        ],
      },
      isLoading: false,
      isSuccess: true,
    });

    render(
      <MemoryRouter>
        <EditorShell storyId="story-1" videoSrc="/recordings/action-timed.mp4" />
      </MemoryRouter>,
    );

    expect(screen.getByText("Timed")).toBeInTheDocument();
    expect(screen.queryByText("Step timing missing")).not.toBeInTheDocument();
  });
});
