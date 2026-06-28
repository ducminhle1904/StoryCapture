import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../state/store";
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
    const ripple = overlay.querySelector("div");

    await waitFor(() => expect(cursor?.style.opacity).toBe("1"));
    expect(cursor?.style.left).toBe("40%");
    expect(cursor?.style.top).toBe("70%");
    expect(ripple?.style.opacity).toBe("0.72");
    expect(PreviewEngine).not.toHaveBeenCalled();
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

    await waitFor(() => expect(cursor?.style.opacity).toBe("1"));
    expect(cursor?.style.left).toBe("60.00000000000001%");
    expect(cursor?.style.top).toBe("50%");
    expect(cursor?.style.width).toBe("40px");
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
