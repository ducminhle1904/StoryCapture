import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleCursorClickEffect } from "../../state/cursor-click-effect";
import type { SourceTimelineMap } from "../../state/source-timeline-map";
import { useEditorStore } from "../../state/store";
import type { CursorClip } from "../../state/timeline-slice";
import { PreviewEngine } from "../preview-engine";
import { PreviewPlayer } from "../preview-player";
import { ACTIONS } from "./fixtures";

vi.mock("../preview-engine", () => ({
  PreviewEngine: vi.fn().mockImplementation(function MockPreviewEngine() {
    return {
      init: vi.fn(async () => undefined),
      renderFrame: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
  }),
}));

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
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockNativePlayback() {
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(async () => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const requestAnimationFrameSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

  return { play, requestAnimationFrameSpy };
}

function setActionCursorClip(overrides: Partial<CursorClip> = {}) {
  useEditorStore.setState({
    tracks: {
      video: [],
      cursor: [
        {
          id: "cursor-1",
          trackId: "cursor",
          startMs: 0,
          durationMs: 10_000,
          trajectoryDir: "/tmp/demo.actions.json",
          trajectoryFps: 60,
          trajectoryFrameCount: 600,
          skin: "mac-default",
          sizeScale: 1,
          ...overrides,
        },
      ],
      zoom: [],
      sound: [],
      annotations: [],
    },
  });
}

function feedbackPrimitives(overlay: HTMLElement): HTMLDivElement[] {
  return Array.from(
    overlay.querySelectorAll<HTMLDivElement>("[data-testid='cursor-click-feedback-primitive']"),
  );
}

describe("PreviewPlayer", () => {
  it("uses native video by default without initializing the preview engine", () => {
    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);

    expect(screen.getByLabelText("Source video preview")).toBeInTheDocument();
    expect(screen.queryByLabelText("Composited preview canvas")).not.toBeInTheDocument();
    expect(PreviewEngine).not.toHaveBeenCalled();
  });

  it("initializes the preview engine only when composited canvas mode is requested", async () => {
    render(
      <PreviewPlayer
        storyId="story-1"
        videoSrc="http://localhost/video.mp4"
        outputMode="composited-canvas"
      />,
    );

    expect(screen.getByLabelText("Composited preview canvas")).toBeInTheDocument();
    expect(screen.queryByLabelText("Source video preview")).not.toBeInTheDocument();
    await waitFor(() => expect(PreviewEngine).toHaveBeenCalled());
  });

  it("starts native video playback without requiring a preview engine", async () => {
    const user = userEvent.setup();
    const { play, requestAnimationFrameSpy } = mockNativePlayback();

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    await user.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(PreviewEngine).not.toHaveBeenCalled();
    await waitFor(() => expect(requestAnimationFrameSpy).toHaveBeenCalled());
  });

  it("keeps a successfully loaded source available without retrying", () => {
    vi.useFakeTimers();
    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    const video = screen.getByLabelText("Source video preview");

    fireEvent.loadedData(video);
    act(() => vi.advanceTimersByTime(1000));

    expect(screen.getByLabelText("Source video preview")).toBe(video);
    expect(screen.queryByRole("button", { name: "Retry preview" })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("returns to a stopped state when the browser rejects playback", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("blocked"));
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    await user.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument());
  });

  it("remounts the source once after a transient media error", () => {
    vi.useFakeTimers();
    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    const failedVideo = screen.getByLabelText("Source video preview");

    fireEvent.error(failedVideo);
    act(() => vi.advanceTimersByTime(400));

    expect(screen.getByLabelText("Source video preview")).not.toBe(failedVideo);
    expect(screen.queryByRole("button", { name: "Retry preview" })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows a manual retry after the automatic retry also fails", async () => {
    vi.useFakeTimers();
    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    fireEvent.error(screen.getByLabelText("Source video preview"));
    act(() => vi.advanceTimersByTime(400));
    const retriedVideo = screen.getByLabelText("Source video preview");

    fireEvent.error(retriedVideo);
    const retryButton = screen.getByRole("button", { name: "Retry preview" });
    fireEvent.click(retryButton);

    expect(screen.getByLabelText("Source video preview")).not.toBe(retriedVideo);
    expect(screen.queryByRole("button", { name: "Retry preview" })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("clears media failure state when the source changes", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video-a.mp4" />,
    );
    fireEvent.error(screen.getByLabelText("Source video preview"));
    act(() => vi.advanceTimersByTime(400));
    fireEvent.error(screen.getByLabelText("Source video preview"));
    expect(screen.getByRole("button", { name: "Retry preview" })).toBeInTheDocument();

    rerender(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video-b.mp4" />);

    expect(screen.queryByRole("button", { name: "Retry preview" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Source video preview")).toHaveAttribute(
      "src",
      "http://localhost/video-b.mp4",
    );
    vi.useRealTimers();
  });

  it("cancels a pending media retry when unmounted", () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />,
    );
    fireEvent.error(screen.getByLabelText("Source video preview"));

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("continues the native preview playhead after the source video ends", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(window.performance, "now").mockReturnValue(0);
    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafCallback = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    useEditorStore.setState({ durationMs: 2000 });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    const video = screen.getByLabelText("Source video preview") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 1.2, configurable: true });

    await user.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(rafCallback).toBeTruthy());

    act(() => {
      rafCallback?.(1500);
    });
    expect(useEditorStore.getState().playheadMs).toBe(1500);
    expect(video.currentTime).toBeCloseTo(1.199);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

    act(() => {
      rafCallback?.(2100);
    });
    expect(useEditorStore.getState().playheadMs).toBe(2000);
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument());
  });

  it("replays native video from the beginning when play starts at the timeline end", async () => {
    const user = userEvent.setup();
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(window.performance, "now").mockReturnValue(0);
    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafCallback = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    useEditorStore.setState({ durationMs: 2000, playheadMs: 2000 });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    const video = screen.getByLabelText("Source video preview") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 2, configurable: true });

    await user.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(useEditorStore.getState().playheadMs).toBe(0);
    expect(video.currentTime).toBe(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());
    await waitFor(() => expect(rafCallback).toBeTruthy());

    act(() => {
      rafCallback?.(250);
    });
    expect(useEditorStore.getState().playheadMs).toBe(250);
  });

  it("continues the composited preview playhead after the source video ends", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(window.performance, "now").mockReturnValue(0);
    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafCallback = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    useEditorStore.setState({ durationMs: 2000 });

    const { container } = render(
      <PreviewPlayer
        storyId="story-1"
        videoSrc="http://localhost/video.mp4"
        outputMode="composited-canvas"
      />,
    );
    await waitFor(() => expect(PreviewEngine).toHaveBeenCalled());
    const video = container.querySelector("video[hidden]") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 1.2, configurable: true });
    const engine = vi.mocked(PreviewEngine).mock.results[0]?.value as {
      renderFrame: ReturnType<typeof vi.fn>;
    };

    await user.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(rafCallback).toBeTruthy());

    act(() => {
      rafCallback?.(1500);
    });
    expect(useEditorStore.getState().playheadMs).toBe(1500);
    expect(video.currentTime).toBeCloseTo(1.199);
    expect(engine.renderFrame).toHaveBeenLastCalledWith(1500, expect.anything());

    act(() => {
      rafCallback?.(2100);
    });
    expect(useEditorStore.getState().playheadMs).toBe(2000);
    expect(engine.renderFrame).toHaveBeenLastCalledWith(2000, expect.anything());
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument());
  });

  it("replays the composited preview from the beginning when play starts at the timeline end", async () => {
    const user = userEvent.setup();
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(window.performance, "now").mockReturnValue(0);
    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafCallback = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    useEditorStore.setState({ durationMs: 2000, playheadMs: 2000 });

    const { container } = render(
      <PreviewPlayer
        storyId="story-1"
        videoSrc="http://localhost/video.mp4"
        outputMode="composited-canvas"
      />,
    );
    await waitFor(() => expect(PreviewEngine).toHaveBeenCalled());
    const video = container.querySelector("video[hidden]") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 0.1, configurable: true });
    const engine = vi.mocked(PreviewEngine).mock.results[0]?.value as {
      renderFrame: ReturnType<typeof vi.fn>;
    };

    await user.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(useEditorStore.getState().playheadMs).toBe(0);
    expect(engine.renderFrame).toHaveBeenLastCalledWith(0, expect.anything());
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());
    await waitFor(() => expect(rafCallback).toBeTruthy());

    act(() => {
      rafCallback?.(150);
    });
    expect(useEditorStore.getState().playheadMs).toBe(150);
    expect(engine.renderFrame).toHaveBeenLastCalledWith(150, expect.anything());
  });

  it("commits native playback time when media pauses", async () => {
    const user = userEvent.setup();
    mockNativePlayback();

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    const video = screen.getByLabelText("Source video preview") as HTMLVideoElement;

    await user.click(screen.getByRole("button", { name: "Play" }));
    video.currentTime = 3.25;
    act(() => {
      video.dispatchEvent(new Event("pause"));
    });

    expect(useEditorStore.getState().playheadMs).toBe(3250);
  });

  it("syncs native video currentTime when scrubbing while paused", async () => {
    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    const video = screen.getByLabelText("Source video preview") as HTMLVideoElement;

    act(() => {
      useEditorStore.getState().setPlayhead(2500);
    });

    await waitFor(() => expect(video.currentTime).toBe(2.5));
    expect(PreviewEngine).not.toHaveBeenCalled();
  });

  it("maps a scrub inside a source hold to the held media frame", async () => {
    useEditorStore.setState((state) => ({
      tracks: {
        ...state.tracks,
        video: [
          {
            id: "video-1",
            trackId: "video",
            startMs: 0,
            durationMs: 3000,
            sourcePath: "/tmp/video.mp4",
            sourceTimeMap: {
              version: 1,
              segments: [
                {
                  kind: "media",
                  sourceStartUs: 0,
                  sourceEndUs: 1_000_000,
                  timelineStartMs: 0,
                  timelineEndMs: 1000,
                },
                {
                  kind: "hold",
                  sourcePtsUs: 1_000_000,
                  timelineStartMs: 1000,
                  timelineEndMs: 2000,
                  reason: "cursor-motion",
                },
                {
                  kind: "media",
                  sourceStartUs: 1_000_000,
                  sourceEndUs: 2_000_000,
                  timelineStartMs: 2000,
                  timelineEndMs: 3000,
                },
              ],
            } satisfies SourceTimelineMap,
          },
        ],
      },
    }));
    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    const video = screen.getByLabelText("Source video preview") as HTMLVideoElement;

    act(() => useEditorStore.getState().setPlayhead(1500));

    await waitFor(() => expect(video.currentTime).toBe(1));
  });

  it("seeks native video when playhead changes while playing", async () => {
    const user = userEvent.setup();
    mockNativePlayback();

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    const video = screen.getByLabelText("Source video preview") as HTMLVideoElement;

    await user.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());
    video.currentTime = 1;

    act(() => {
      useEditorStore.getState().setPlayhead(4000);
    });

    await waitFor(() => expect(video.currentTime).toBe(4));
    expect(useEditorStore.getState().playheadMs).toBe(4000);
    expect(PreviewEngine).not.toHaveBeenCalled();
  });

  it("shows the virtual cursor overlay from active cursor clips without starting the compositor", async () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [
          {
            id: "cursor-1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 10_000,
            trajectoryDir: "/tmp/demo.actions.json",
            trajectoryFps: 60,
            trajectoryFrameCount: 600,
            skin: "mac-default",
            sizeScale: 1.25,
          },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );

    act(() => {
      useEditorStore.getState().setPlayhead(2000);
    });

    const overlay = screen.getByTestId("virtual-cursor-overlay");
    const cursor = overlay.querySelector("img");

    await waitFor(() => expect(cursor?.style.opacity).toBe("1"));
    expect(cursor?.style.left).toBe("80%");
    expect(cursor?.style.top).toBe("60%");
    expect(cursor?.style.width).toBe("40px");
    expect(PreviewEngine).not.toHaveBeenCalled();
  });

  it("shows the virtual cursor overlay from trajectory-only sidecars", async () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [
          {
            id: "cursor-trajectory",
            trackId: "cursor",
            startMs: 0,
            durationMs: 10_000,
            trajectoryDir: "/tmp/demo.trajectory.json",
            trajectoryKind: "trajectory",
            trajectoryFps: 60,
            trajectoryFrameCount: 2,
            skin: "mac-default",
            sizeScale: 1,
          },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    render(
      <PreviewPlayer
        storyId="story-1"
        videoSrc="http://localhost/video.mp4"
        trajectory={{
          recording_path: "/tmp/demo.mp4",
          capture_rect: { x: 0, y: 0, width: 1920, height: 1080 },
          fps: 60,
          frame_count: 2,
          frames: [
            { t_ms: 0, x: 0.2, y: 0.3, click: false },
            { t_ms: 2000, x: 0.4, y: 0.7, click: true },
          ],
        }}
      />,
    );

    act(() => {
      useEditorStore.getState().setPlayhead(2000);
    });

    const overlay = screen.getByTestId("virtual-cursor-overlay");
    const cursor = overlay.querySelector("img");
    const feedbackNodes = feedbackPrimitives(overlay);

    await waitFor(() => expect(cursor?.style.opacity).toBe("1"));
    expect(cursor?.style.left).toBe("40%");
    expect(cursor?.style.top).toBe("70%");
    expect(feedbackNodes).toHaveLength(6);
    expect(feedbackNodes.every((node) => node.style.visibility === "hidden")).toBe(true);
    expect(PreviewEngine).not.toHaveBeenCalled();
  });

  it("renders configured click primitives with deterministic dual-tone styles", async () => {
    const clickEffect = { style: "ring", color: "black", intensity: "strong" } as const;
    setActionCursorClip({ clickEffect });

    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );
    act(() => useEditorStore.getState().setPlayhead(2100));

    const overlay = screen.getByTestId("virtual-cursor-overlay");
    const nodes = feedbackPrimitives(overlay);
    await waitFor(() => expect(nodes[0]?.style.visibility).toBe("visible"));
    const expected = sampleCursorClickEffect(clickEffect, 100)?.primitives[0];

    expect(nodes).toHaveLength(6);
    expect(nodes.filter((node) => node.style.visibility === "visible")).toHaveLength(1);
    expect(nodes[0]?.style.left).toBe("80%");
    expect(nodes[0]?.style.top).toBe("60%");
    expect(Number.parseFloat(nodes[0]?.style.width ?? "0")).toBeCloseTo(
      (expected?.radius ?? 0) * 2,
      5,
    );
    expect(nodes[0]?.style.borderColor).toContain("rgba(17, 24, 39");
    expect(nodes[0]?.style.backgroundColor).toContain("rgba(17, 24, 39");
    expect(nodes[0]?.style.boxShadow).toContain("rgba(255, 255, 255");
    expect(nodes[0]?.style.boxShadow).toContain("rgba(17, 24, 39");
  });

  it("reuses a bounded node pool for overlapping echo feedback", async () => {
    setActionCursorClip({
      clickEffect: { style: "echo", color: "brand", intensity: "normal" },
    });
    const first = ACTIONS.events[0];
    if (!first?.target) throw new Error("Expected click fixture with a target");
    const rapidActions = {
      ...ACTIONS,
      events: [
        first,
        {
          ...first,
          source_index: 1,
          ordinal: 2,
          t_start_ms: 2050,
          t_action_ms: 2200,
          t_end_ms: 2400,
          target: {
            ...first.target,
            center: { x: 200, y: 100 },
          },
          input_timing: { kind: "click" as const, action_ms: 2200 },
        },
      ],
    };

    render(
      <PreviewPlayer
        storyId="story-1"
        videoSrc="http://localhost/video.mp4"
        actions={rapidActions}
      />,
    );
    act(() => useEditorStore.getState().setPlayhead(2300));

    const nodes = feedbackPrimitives(screen.getByTestId("virtual-cursor-overlay"));
    await waitFor(() =>
      expect(nodes.filter((node) => node.style.visibility === "visible")).toHaveLength(4),
    );
    expect(nodes).toHaveLength(6);
    expect(nodes[0]?.style.left).toBe("80%");
    expect(nodes[0]?.style.top).toBe("60%");
    expect(nodes[2]?.style.left).toBe("20%");
    expect(nodes[2]?.style.top).toBe("20%");
  });

  it("keeps the Press cursor hotspot fixed while applying sampled scale", async () => {
    const clickEffect = { style: "press", color: "auto", intensity: "normal" } as const;
    setActionCursorClip({ clickEffect });

    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );
    act(() => useEditorStore.getState().setPlayhead(2100));

    const cursor = screen.getByTestId("virtual-cursor-overlay").querySelector("img");
    const expectedScale = sampleCursorClickEffect(clickEffect, 100)?.cursorScale;
    await waitFor(() => expect(cursor?.style.opacity).toBe("1"));

    expect(cursor?.style.left).toBe("80%");
    expect(cursor?.style.top).toBe("60%");
    expect(cursor?.style.transformOrigin).toBe("1px 1px");
    expect(cursor?.style.transform).toBe(`translate3d(-1px, -1px, 0) scale(${expectedScale})`);
  });

  it("scales cursor and feedback in rendered screen space from a 1080 baseline", async () => {
    const clickEffect = { style: "soft-pulse", color: "white", intensity: "normal" } as const;
    setActionCursorClip({ clickEffect });

    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );
    const zoomLayer = screen.getByTestId("preview-zoom-layer");
    Object.defineProperty(zoomLayer, "clientWidth", { configurable: true, value: 960 });
    Object.defineProperty(zoomLayer, "clientHeight", { configurable: true, value: 540 });
    act(() => useEditorStore.getState().setPlayhead(2100));

    const overlay = screen.getByTestId("virtual-cursor-overlay");
    const cursor = overlay.querySelector("img");
    const node = feedbackPrimitives(overlay)[0];
    const expected = sampleCursorClickEffect(clickEffect, 100)?.primitives[0];
    await waitFor(() => expect(node?.style.visibility).toBe("visible"));

    expect(cursor?.style.width).toBe("16px");
    expect(Number.parseFloat(node?.style.width ?? "0")).toBeCloseTo(expected?.radius ?? 0, 5);
  });

  it("recomputes cursor scale when the paused preview is resized", async () => {
    const clickEffect = { style: "ring", color: "white", intensity: "normal" } as const;
    setActionCursorClip({ clickEffect });
    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );
    const zoomLayer = screen.getByTestId("preview-zoom-layer");
    const stage = zoomLayer.parentElement?.parentElement;
    if (!stage) throw new Error("expected preview stage");
    Object.defineProperty(zoomLayer, "clientWidth", { configurable: true, value: 960 });
    Object.defineProperty(zoomLayer, "clientHeight", { configurable: true, value: 540 });
    act(() => useEditorStore.getState().setPlayhead(2_100));
    const cursor = screen.getByTestId("virtual-cursor-overlay").querySelector("img");
    await waitFor(() => expect(cursor?.style.width).toBe("16px"));

    Object.defineProperty(zoomLayer, "clientWidth", { configurable: true, value: 480 });
    Object.defineProperty(zoomLayer, "clientHeight", { configurable: true, value: 270 });
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 480,
      bottom: 270,
      left: 0,
      width: 480,
      height: 270,
      toJSON: () => ({}),
    });
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(cursor?.style.width).toBe("8px"));
  });

  it("keeps feedback hidden when the clip effect is None", async () => {
    setActionCursorClip({
      clickEffect: { style: "none", color: "brand", intensity: "strong" },
    });
    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );
    act(() => useEditorStore.getState().setPlayhead(2000));

    const overlay = screen.getByTestId("virtual-cursor-overlay");
    const cursor = overlay.querySelector("img");
    const nodes = feedbackPrimitives(overlay);
    await waitFor(() => expect(cursor?.style.opacity).toBe("1"));

    expect(nodes).toHaveLength(6);
    expect(nodes.every((node) => node.style.visibility === "hidden")).toBe(true);
    expect(cursor?.style.transform).toBe("translate3d(-1px, -1px, 0) scale(1)");
  });

  it("hides and resets every feedback node after the sampled effect ends", async () => {
    setActionCursorClip({
      clickEffect: { style: "ring", color: "white", intensity: "normal" },
    });
    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );
    const nodes = feedbackPrimitives(screen.getByTestId("virtual-cursor-overlay"));

    act(() => useEditorStore.getState().setPlayhead(2100));
    await waitFor(() => expect(nodes[0]?.style.visibility).toBe("visible"));
    act(() => useEditorStore.getState().setPlayhead(3000));

    await waitFor(() =>
      expect(nodes.every((node) => node.style.visibility === "hidden")).toBe(true),
    );
    expect(nodes.every((node) => node.style.opacity === "0")).toBe(true);
  });

  it("keeps cursor screen-sized while positioning it through active zoom", async () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [
          {
            id: "cursor-1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 10_000,
            trajectoryDir: "/tmp/demo.actions.json",
            trajectoryFps: 60,
            trajectoryFrameCount: 600,
            skin: "mac-default",
            sizeScale: 1.25,
          },
        ],
        zoom: [
          {
            id: "zoom-1",
            trackId: "zoom",
            startMs: 1500,
            durationMs: 1000,
            target: { kind: "cursor" },
            scale: 2,
            center: { x: 0.8, y: 0.6 },
          },
        ],
        sound: [],
        annotations: [],
      },
    });

    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );

    act(() => {
      useEditorStore.getState().setPlayhead(2000);
    });

    const overlay = screen.getByTestId("virtual-cursor-overlay");
    const cursor = overlay.querySelector("img");
    const feedback = feedbackPrimitives(overlay)[0];

    await waitFor(() => expect(cursor?.style.opacity).toBe("1"));
    expect(cursor?.style.left).toBe("60.00000000000001%");
    expect(cursor?.style.top).toBe("50%");
    expect(cursor?.style.width).toBe("40px");
    expect(feedback?.style.visibility).toBe("visible");
    expect(feedback?.style.left).toBe(cursor?.style.left);
    expect(feedback?.style.top).toBe(cursor?.style.top);
  });

  it("expands bounded action highlights symmetrically after preview zoom", () => {
    useEditorStore.setState({
      playheadMs: 500,
      tracks: {
        video: [],
        cursor: [],
        zoom: [
          {
            id: "zoom-1",
            trackId: "zoom",
            startMs: 0,
            durationMs: 1000,
            target: { kind: "cursor" },
            scale: 2,
            center: { x: 0.5, y: 0.5 },
          },
        ],
        sound: [],
        annotations: [
          {
            id: "highlight-1",
            trackId: "annotations",
            startMs: 0,
            durationMs: 1000,
            text: "",
            pos: { x: 0.5, y: 0.5 },
            sizePt: 24,
            highlight: {
              center: { x: 0.45, y: 0.55 },
              bounds: { x: 0.4, y: 0.5, w: 0.1, h: 0.1 },
              radiusPx: 48,
              paddingPx: 12,
              strokePx: 3,
              glowPx: 10,
              opacity: 0.8,
              color: "#ffffff",
            },
          },
        ],
      },
    });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);

    const highlight = screen.getByTestId("highlight-frame");
    expect(highlight.style.left).toBe("calc(30% - 12px)");
    expect(highlight.style.top).toBe("calc(50% - 12px)");
    expect(highlight.style.width).toBe("calc(20% + 24px)");
    expect(highlight.style.height).toBe("calc(20% + 24px)");
    expect(highlight.style.transform).toBe("translate3d(0, 0, 0)");
    expect(highlight.style.boxSizing).toBe("border-box");
    expect(highlight.style.borderRadius).toBe("8.64px");
    expect(highlight.style.padding).toBe("");
  });

  it("does not render bounded action highlights with unreliable bounds", () => {
    useEditorStore.setState({
      playheadMs: 500,
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "highlight-invalid",
            trackId: "annotations",
            startMs: 0,
            durationMs: 1000,
            text: "",
            pos: { x: 0.5, y: 0.5 },
            sizePt: 24,
            highlight: {
              center: { x: 0.5, y: 0.5 },
              bounds: { x: 0.2, y: 0.2, w: Number.POSITIVE_INFINITY, h: 0.12 },
              radiusPx: 48,
              paddingPx: 12,
              color: "#ffffff",
            },
          },
        ],
      },
    });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);

    expect(screen.getByTestId("highlight-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("highlight-frame")).not.toBeInTheDocument();
  });

  it("applies timeline zoom clips in the native preview path", async () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [],
        zoom: [
          {
            id: "zoom-1",
            trackId: "zoom",
            startMs: 1000,
            durationMs: 1000,
            label: "Zoom",
            target: { kind: "cursor" },
            scale: 2,
            center: { x: 0.25, y: 0.75 },
            preset: "DYNAMIC",
          },
        ],
        sound: [],
        annotations: [],
      },
    });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);

    act(() => {
      useEditorStore.getState().setPlayhead(1110);
    });

    const zoomLayer = screen.getByTestId("preview-zoom-layer");
    await waitFor(() => expect(zoomLayer.style.transform).toContain("matrix(1.5"));
    expect(zoomLayer.style.transformOrigin).toBe("0 0");

    act(() => {
      useEditorStore.getState().setPlayhead(1500);
    });
    await waitFor(() => expect(zoomLayer.style.transform).toContain("matrix(2"));
    expect(zoomLayer.style.transformOrigin).toBe("0 0");

    act(() => {
      useEditorStore.getState().setPlayhead(1890);
    });
    await waitFor(() => expect(zoomLayer.style.transform).toContain("matrix(1.5"));

    expect(PreviewEngine).not.toHaveBeenCalled();
  });

  it("renders active annotation text over the native video preview", async () => {
    useEditorStore.setState({
      playheadMs: 1500,
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "text-1",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 2000,
            label: "Title",
            text: "Checkout ready",
            pos: { x: 0.5, y: 0.82 },
            sizePt: 32,
            color: "#ffcc00",
          },
          {
            id: "text-2",
            trackId: "annotations",
            startMs: 4000,
            durationMs: 1000,
            label: "Later",
            text: "Later title",
            pos: { x: 0.5, y: 0.5 },
            sizePt: 24,
            color: "#ffffff",
          },
        ],
      },
    });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);

    expect(screen.getByTestId("text-overlay")).toBeInTheDocument();
    expect(screen.getByText("Checkout ready")).toBeInTheDocument();
    expect(screen.queryByText("Later title")).not.toBeInTheDocument();
    expect(PreviewEngine).not.toHaveBeenCalled();

    act(() => {
      useEditorStore.getState().setPlayhead(4500);
    });

    await waitFor(() => expect(screen.getByText("Later title")).toBeInTheDocument());
    expect(screen.queryByText("Checkout ready")).not.toBeInTheDocument();
  });

  it("resolves cursor and target text anchors in the native preview", async () => {
    useEditorStore.setState({
      playheadMs: 2000,
      tracks: {
        video: [],
        cursor: [
          {
            id: "cursor-1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 10_000,
            trajectoryDir: "/tmp/demo.actions.json",
            trajectoryKind: "actions",
            trajectoryFps: 60,
            trajectoryFrameCount: 600,
            skin: "mac-default",
            sizeScale: 1,
          },
        ],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "text-cursor",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 3000,
            label: "Cursor",
            text: "Cursor label",
            pos: { x: 0.2, y: 0.2 },
            sizePt: 24,
            anchor: { kind: "cursor", offset: { x: 0.1, y: -0.1 } },
          },
          {
            id: "text-target",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 3000,
            label: "Target",
            text: "Target label",
            pos: { x: 0.1, y: 0.1 },
            sizePt: 24,
            anchor: { kind: "target", stepId: "step-1", placement: "right" },
          },
        ],
      },
    });

    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );

    await waitFor(() => expect(screen.getByText("Cursor label")).toBeInTheDocument());
    expect(screen.getByText("Cursor label")).toHaveStyle({ left: "90%", top: "50%" });
    expect(screen.getByText("Target label")).toHaveStyle({ left: "90%", top: "60%" });
  });

  it("falls target-anchored text back to its saved screen position without geometry", () => {
    useEditorStore.setState({
      playheadMs: 2000,
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "text-missing-target",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 3000,
            label: "Target",
            text: "Fallback label",
            pos: { x: 0.22, y: 0.33 },
            sizePt: 24,
            anchor: { kind: "target", stepId: "missing-step", placement: "top" },
          },
        ],
      },
    });

    render(
      <PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" actions={ACTIONS} />,
    );

    expect(screen.getByText("Fallback label")).toHaveStyle({ left: "22%", top: "33%" });
  });

  it("anchors text boxes to the nearest frame edge without shrinking", () => {
    useEditorStore.setState({
      playheadMs: 1500,
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "left-text",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 2000,
            label: "Left",
            text: "Left edge text",
            pos: { x: 0.08, y: 0.4 },
            sizePt: 24,
          },
          {
            id: "right-text",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 2000,
            label: "Right",
            text: "Right edge text",
            pos: { x: 0.92, y: 0.6 },
            sizePt: 24,
          },
        ],
      },
    });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);

    expect(screen.getByText("Left edge text")).toHaveStyle({
      width: "max-content",
      transformOrigin: "left center",
    });
    expect(screen.getByText("Left edge text").style.transform).toContain("translate(0%");
    expect(screen.getByText("Right edge text")).toHaveStyle({
      width: "max-content",
      transformOrigin: "right center",
    });
    expect(screen.getByText("Right edge text").style.transform).toContain("translate(-100%");
  });

  it("allows direct-dragged text to move outside the video frame", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);
    useEditorStore.setState({
      playheadMs: 1500,
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "outside-text",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 2000,
            label: "Outside",
            text: "Outside frame",
            pos: { x: 0.5, y: 0.5 },
            sizePt: 24,
          },
        ],
      },
    });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);

    const text = screen.getByRole("button", { name: "Text overlay Outside frame" });
    fireEvent.pointerDown(text, { clientX: 500, clientY: 250 });
    fireEvent.pointerMove(window, { clientX: -100, clientY: 650 });
    fireEvent.pointerUp(window);

    const clip = useEditorStore.getState().tracks.annotations[0];
    expect(clip?.pos.x).toBeCloseTo(-0.1);
    expect(clip?.pos.y).toBe(1.25);
    expect(clip?.anchor).toMatchObject({ kind: "screen", pos: { y: 1.25 } });
    if (clip?.anchor?.kind !== "screen") throw new Error("expected screen anchor");
    expect(clip.anchor.pos.x).toBeCloseTo(-0.1);
    rectSpy.mockRestore();
  });

  it("converts anchored text to a screen position when dragged directly", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);
    useEditorStore.setState({
      playheadMs: 1500,
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "safe-text",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 2000,
            label: "Safe",
            text: "Safe label",
            pos: { x: 0.1, y: 0.1 },
            sizePt: 24,
            anchor: { kind: "safe-area", placement: "bottom" },
          },
        ],
      },
    });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);

    const text = screen.getByRole("button", { name: "Text overlay Safe label" });
    fireEvent.pointerDown(text, { clientX: 500, clientY: 430 });
    fireEvent.pointerMove(window, { clientX: 600, clientY: 380 });
    fireEvent.pointerUp(window);

    const clip = useEditorStore.getState().tracks.annotations[0];
    expect(clip?.pos).toEqual({ x: 0.6, y: 0.76 });
    expect(clip?.anchor).toEqual({ kind: "screen", pos: { x: 0.6, y: 0.76 } });
    rectSpy.mockRestore();
  });

  it("selects, drags, resizes, and inline-edits preview text", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);
    useEditorStore.setState({
      playheadMs: 1500,
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "text-1",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 2000,
            label: "Title",
            text: "Move me",
            pos: { x: 0.5, y: 0.5 },
            sizePt: 24,
            color: "#ffffff",
            styleId: "title",
          },
        ],
      },
    });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);

    const text = screen.getByRole("button", { name: "Text overlay Move me" });
    fireEvent.pointerDown(text, { clientX: 500, clientY: 250 });
    fireEvent.pointerMove(window, { clientX: 600, clientY: 300 });
    fireEvent.pointerUp(window);

    expect(useEditorStore.getState().selectedClipId).toBe("text-1");
    expect(useEditorStore.getState().selectedTab).toBe("effects");
    expect(useEditorStore.getState().tracks.annotations[0]?.pos).toEqual({ x: 0.6, y: 0.6 });
    expect(useEditorStore.getState().tracks.annotations[0]?.anchor).toEqual({
      kind: "screen",
      pos: { x: 0.6, y: 0.6 },
    });
    expect(useEditorStore.getState().canUndo).toBe(true);

    const resize = screen.getByRole("button", { name: "Resize text overlay" });
    fireEvent.pointerDown(resize, { clientX: 600, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 650, clientY: 330 });
    fireEvent.pointerUp(window);

    expect(useEditorStore.getState().tracks.annotations[0]?.sizePt).toBeGreaterThan(24);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Text overlay Move me" }));
    const editor = screen.getByLabelText("Edit text overlay");
    fireEvent.change(editor, { target: { value: "Edited copy" } });
    fireEvent.blur(editor);

    expect(useEditorStore.getState().tracks.annotations[0]?.text).toBe("Edited copy");
    rectSpy.mockRestore();
  });

  it("clamps forward jump to the known video duration", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ durationMs: 10_000, playheadMs: 8000 });

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    await user.click(screen.getByRole("button", { name: "Jump forward 5 seconds" }));

    expect(useEditorStore.getState().playheadMs).toBe(10_000);
    expect(screen.getByRole("button", { name: "Jump forward 5 seconds" })).toBeDisabled();
  });
});
