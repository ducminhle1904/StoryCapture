/**
 * Timeline tests. Coverage:
 *   - 5 fixed tracks render
 *   - Magnetic snap within 10 px
 *   - Alt-held bypasses snap without flipping the persistent flag
 *   - Clips carry ARIA labels for screen readers
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { Timeline } from "../timeline/timeline";
import { useEditorStore } from "../state/store";

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
});

describe("Timeline", () => {
  it("renders the region with aria-label and 5 fixed tracks", () => {
    render(<Timeline storyId="s1" pxPerMs={1} />);
    const region = screen.getByRole("region", { name: /timeline/i });
    expect(region).toBeInTheDocument();

    // Five track rows labelled correctly.
    expect(screen.getByRole("row", { name: /video track/i })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /cursor track/i })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /zoom track/i })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /sound track/i })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /annotations track/i })).toBeInTheDocument();
  });

  it("renders clips with descriptive ARIA labels", () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [{ id: "c1", trackId: "cursor", startMs: 12500, durationMs: 3200, trajectoryDir: "/c", trajectoryFps: 60, trajectoryFrameCount: 0, skin: "mac-default", sizeScale: 1 }],
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

  it("moveClip snaps a clip within 10 px of a neighbour edge", () => {
    useEditorStore.setState({
      tracks: {
        video: [
          { id: "neighbour", trackId: "video", startMs: 500, durationMs: 500, sourcePath: "/v.mp4" },
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

    const dragged = useEditorStore
      .getState()
      .tracks.video.find((c) => c.id === "dragged")!;
    expect(dragged.startMs).toBe(1000);
  });

  it("Alt-held bypasses snap without changing snapEnabled", () => {
    useEditorStore.setState({
      tracks: {
        video: [
          { id: "neighbour", trackId: "video", startMs: 500, durationMs: 500, sourcePath: "/v.mp4" },
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

    useEditorStore
      .getState()
      .moveClip("video", "dragged", 995, { pxPerMs: 1, altHeld: true });

    const dragged = useEditorStore
      .getState()
      .tracks.video.find((c) => c.id === "dragged")!;
    // Alt bypasses snap — stays at 995.
    expect(dragged.startMs).toBe(995);
    // Persistent flag unchanged.
    expect(useEditorStore.getState().snapEnabled).toBe(true);
  });
});
