/**
 * Timeline tests. Coverage:
 *   - 5 fixed tracks render
 *   - Magnetic snap within 10 px
 *   - Alt-held bypasses snap without flipping the persistent flag
 *   - Clips carry ARIA labels for screen readers
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../state/store";
import { Timeline } from "../timeline/timeline";
import { COALESCE_IDLE_MS, Coalescer } from "../undo/coalesce";
import { HISTORY_CAP, HistoryBuffer } from "../undo/history-buffer";

function resetStore() {
  useEditorStore.setState({
    tracks: { video: [], cursor: [], zoom: [], sound: [], annotations: [] },
    playheadMs: 0,
    snapEnabled: true,
    durationMs: 10_000,
    selectedClipId: null,
    selectedPresetId: null,
    selectedTab: "presets",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Timeline", () => {
  it("renders the region with aria-label and 5 fixed tracks", () => {
    render(<Timeline storyId="s1" pxPerMs={1} />);
    const region = screen.getByRole("region", { name: /timeline/i });
    expect(region).toBeInTheDocument();

    // Five track rows labelled correctly.
    expect(screen.getByRole("region", { name: /video track/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /cursor track/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /zoom track/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /sound track/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /annotations track/i })).toBeInTheDocument();
  });

  it("auto-scrolls horizontally to keep the playhead in view", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(<Timeline storyId="s1" pxPerMs={1} />);
    const timeline = screen.getByRole("region", { name: /^timeline$/i });
    Object.defineProperty(timeline, "clientWidth", { value: 500, configurable: true });
    Object.defineProperty(timeline, "scrollLeft", { value: 0, writable: true, configurable: true });

    act(() => {
      useEditorStore.getState().setPlayhead(1_000);
    });

    expect(timeline.scrollLeft).toBeGreaterThan(0);

    const currentScrollLeft = timeline.scrollLeft;
    act(() => {
      useEditorStore.getState().setSnapEnabled(false);
    });
    expect(timeline.scrollLeft).toBe(currentScrollLeft);
  });

  it("renders clips with descriptive ARIA labels", () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [
          {
            id: "c1",
            trackId: "cursor",
            startMs: 12500,
            durationMs: 3200,
            trajectoryDir: "/c",
            trajectoryFps: 60,
            trajectoryFrameCount: 0,
            skin: "mac-default",
            sizeScale: 1,
          },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
      durationMs: 30_000,
    });
    render(<Timeline storyId="s1" pxPerMs={1} />);
    // "Cursor clip at 12.50s, 3.20s duration"
    const btns = screen.getAllByRole("button", {
      name: /cursor clip at 12\.50s, 3\.20s duration/i,
    });
    expect(btns.length).toBeGreaterThanOrEqual(1);
    expect(btns[0]).toHaveAttribute("data-track-id", "cursor");
  });

  it("renders zoom in/out markers and resizes zoom clips from the end handle", () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [],
        zoom: [
          {
            id: "zoom-1",
            trackId: "zoom",
            startMs: 1000,
            durationMs: 500,
            label: "Script zoom",
            target: { kind: "cursor" },
            scale: 1.7,
            center: { x: 0.5, y: 0.5 },
            preset: "DYNAMIC",
          },
        ],
        sound: [],
        annotations: [],
      },
      durationMs: 3000,
    });
    render(<Timeline storyId="s1" pxPerMs={1} />);

    const zoomClip = screen.getByRole("button", {
      name: /zoom clip at 1\.00s, 0\.50s duration/i,
    });
    expect(zoomClip.querySelector("[data-clip-resize-edge='start'] svg")).not.toBeNull();
    const endHandle = zoomClip.querySelector("[data-clip-resize-edge='end']");
    if (!(endHandle instanceof HTMLElement)) throw new Error("expected zoom end handle");

    fireEvent.pointerDown(endHandle, { clientX: 1500, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 1700, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 1700, pointerId: 1 });

    expect(useEditorStore.getState().tracks.zoom[0]?.durationMs).toBe(700);
    expect(useEditorStore.getState().canUndo).toBe(true);
  });

  it("moveClip snaps a clip within 10 px of a neighbour edge", () => {
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "neighbour",
            trackId: "video",
            startMs: 500,
            durationMs: 500,
            sourcePath: "/v.mp4",
          },
          { id: "dragged", trackId: "video", startMs: 2000, durationMs: 200, sourcePath: "/v.mp4" },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
      durationMs: 10_000,
    });

    // Drag target = 995 ms, neighbour end edge = 1000 ms, 5 px away at pxPerMs=1
    useEditorStore.getState().moveClip("video", "dragged", 995, { pxPerMs: 1 });

    const dragged = useEditorStore.getState().tracks.video.find((c) => c.id === "dragged");
    if (!dragged) throw new Error("expected dragged clip");
    expect(dragged.startMs).toBe(1000);
  });

  it("Alt-held bypasses snap without changing snapEnabled", () => {
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "neighbour",
            trackId: "video",
            startMs: 500,
            durationMs: 500,
            sourcePath: "/v.mp4",
          },
          { id: "dragged", trackId: "video", startMs: 2000, durationMs: 200, sourcePath: "/v.mp4" },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
      durationMs: 10_000,
      snapEnabled: true,
    });

    useEditorStore.getState().moveClip("video", "dragged", 995, { pxPerMs: 1, altHeld: true });

    const dragged = useEditorStore.getState().tracks.video.find((c) => c.id === "dragged");
    if (!dragged) throw new Error("expected dragged clip");
    // Alt bypasses snap — stays at 995.
    expect(dragged.startMs).toBe(995);
    // Persistent flag unchanged.
    expect(useEditorStore.getState().snapEnabled).toBe(true);
  });

  it("adds an undoable outgoing transition from the left video clip", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 2000,
            label: "Intro",
            sourcePath: "/intro.mp4",
          },
          {
            id: "v2",
            trackId: "video",
            startMs: 2000,
            durationMs: 2000,
            label: "Outro",
            sourcePath: "/outro.mp4",
          },
        ],
        cursor: [
          {
            id: "c1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 2000,
            trajectoryDir: "/c",
            trajectoryFps: 60,
            trajectoryFrameCount: 120,
            skin: "mac-default",
            sizeScale: 1,
          },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
      durationMs: 5000,
    });

    render(<Timeline storyId="s1" pxPerMs={0.1} />);

    expect(screen.getAllByRole("button", { name: /add transition/i })).toHaveLength(1);
    const addTransition = screen.getByRole("button", {
      name: /add transition between intro and outro/i,
    });
    await user.click(addTransition);
    await user.click(screen.getByRole("menuitem", { name: /wipe left/i }));

    expect(useEditorStore.getState().tracks.video[0]?.outgoingTransition).toEqual({
      kind: "wipe-left",
      durationMs: 500,
    });
    expect(useEditorStore.getState().tracks.cursor[0]?.id).toBe("c1");
    expect(useEditorStore.getState().canUndo).toBe(true);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().tracks.video[0]?.outgoingTransition).toBeUndefined();

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().tracks.video[0]?.outgoingTransition).toEqual({
      kind: "wipe-left",
      durationMs: 500,
    });
  });
});
