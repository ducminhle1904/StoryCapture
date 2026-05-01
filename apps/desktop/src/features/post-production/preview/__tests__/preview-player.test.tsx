import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../state/store";
import { PreviewEngine } from "../preview-engine";
import { PreviewPlayer } from "../preview-player";

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
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    render(<PreviewPlayer storyId="story-1" videoSrc="http://localhost/video.mp4" />);
    await user.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(PreviewEngine).not.toHaveBeenCalled();
    await waitFor(() => expect(requestAnimationFrameSpy).toHaveBeenCalled());
  });

  it("commits native playback time when media pauses", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

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
});
