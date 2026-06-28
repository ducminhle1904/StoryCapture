/**
 * Post-Production editor store tests. Coverage:
 *   - setPlayhead
 *   - moveClip with snap enabled snaps to nearest neighbour edge within 10 px
 *   - moveClip with Alt-held (snap disabled for this call) does NOT snap
 *   - toggleSnap flips the flag
 *   - addSoundClip adds to the Sound track only
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useEditorStore } from "../state/store";
import { parseTimelineLayoutJson, serializeTimelineLayout } from "../state/timeline-layout";
import { SNAP_THRESHOLD_PX, snapToNearest } from "../state/timeline-slice";

function resetStore() {
  useEditorStore.setState({
    tracks: { video: [], cursor: [], zoom: [], sound: [], annotations: [] },
    playheadMs: 0,
    snapEnabled: true,
    durationMs: 0,
    selectedClipId: null,
    selectedPresetId: null,
    selectedTab: "presets",
    soundDrawerOpen: false,
    exportModalOpen: false,
    activeJobs: {},
    progressByJobId: {},
  });
}

function findVideoClip(id: string) {
  const clip = useEditorStore.getState().tracks.video.find((c) => c.id === id);
  if (!clip) throw new Error(`expected video clip ${id}`);
  return clip;
}

beforeEach(() => {
  resetStore();
});

describe("timeline-slice", () => {
  it("serializes and parses versioned timeline layouts", () => {
    const tracks = {
      video: [
        {
          id: "video-1",
          trackId: "video" as const,
          startMs: 0,
          durationMs: 1000,
          sourcePath: "/tmp/source.mp4",
        },
      ],
      cursor: [],
      zoom: [],
      sound: [],
      annotations: [],
    };

    const layoutJson = serializeTimelineLayout({
      tracks,
      durationMs: 1000,
      background: { kind: "solid", color: { r: 1, g: 2, b: 3, a: 1 } },
    });
    const parsed = parseTimelineLayoutJson(layoutJson);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.layout.version).toBe(1);
    expect(parsed.layout.tracks.video[0]).toMatchObject({ id: "video-1", trackId: "video" });
    expect(parsed.layout.durationMs).toBe(1000);
    expect(parsed.layout.background).toEqual({ kind: "solid", color: { r: 1, g: 2, b: 3, a: 1 } });
  });

  it("rejects corrupt timeline layouts without throwing", () => {
    expect(parseTimelineLayoutJson("{nope").ok).toBe(false);
    expect(parseTimelineLayoutJson(JSON.stringify({ version: 999, tracks: {} })).ok).toBe(false);
  });

  it("selecting a clip opens the effects inspector tab", () => {
    useEditorStore.setState({ selectedTab: "presets" });

    useEditorStore.getState().setSelectedClipId("clip-1");

    expect(useEditorStore.getState().selectedClipId).toBe("clip-1");
    expect(useEditorStore.getState().selectedTab).toBe("effects");
  });

  it("setPlayhead updates playheadMs and clamps at 0", () => {
    useEditorStore.getState().setPlayhead(1234);
    expect(useEditorStore.getState().playheadMs).toBe(1234);
    useEditorStore.getState().setPlayhead(-5);
    expect(useEditorStore.getState().playheadMs).toBe(0);
  });

  it("toggleSnap flips the flag", () => {
    expect(useEditorStore.getState().snapEnabled).toBe(true);
    useEditorStore.getState().toggleSnap();
    expect(useEditorStore.getState().snapEnabled).toBe(false);
    useEditorStore.getState().toggleSnap();
    expect(useEditorStore.getState().snapEnabled).toBe(true);
  });

  it("moveClip with snap enabled snaps to a neighbour edge within 10 px", () => {
    // Seed a neighbour clip whose END edge is at 1000 ms. We then drag a
    // second clip toward 995 ms (5 px away at pxPerMs = 1) and expect it
    // to snap to 1000.
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
    });

    useEditorStore.getState().moveClip("video", "dragged", 995, { pxPerMs: 1 });

    const dragged = findVideoClip("dragged");
    expect(dragged.startMs).toBe(1000);
  });

  it("moveClip outside the 10 px threshold does NOT snap", () => {
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
    });
    useEditorStore.getState().moveClip("video", "dragged", 985, { pxPerMs: 1 });
    const dragged = findVideoClip("dragged");
    // 15 px away from 1000 — outside threshold — stays at 985.
    expect(dragged.startMs).toBe(985);
  });

  it("moveClip with altHeld bypasses snap for that call", () => {
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
    });
    useEditorStore.getState().moveClip("video", "dragged", 995, { altHeld: true, pxPerMs: 1 });
    const dragged = findVideoClip("dragged");
    expect(dragged.startMs).toBe(995);
    // Persistent flag unchanged.
    expect(useEditorStore.getState().snapEnabled).toBe(true);
  });

  it("addSoundClip puts the clip on the Sound track only", () => {
    useEditorStore
      .getState()
      .addSoundClip({ id: "sfx-1", startMs: 100, durationMs: 250, path: "/s.mp3", kind: "sfx" });

    const s = useEditorStore.getState().tracks;
    expect(s.sound).toHaveLength(1);
    expect(s.sound[0]?.trackId).toBe("sound");
    expect(s.video).toHaveLength(0);
    expect(s.cursor).toHaveLength(0);
    expect(s.zoom).toHaveLength(0);
    expect(s.annotations).toHaveLength(0);
  });

  it("snapToNearest returns candidate unchanged when no targets within threshold", () => {
    expect(snapToNearest(500, [600, 700], 10)).toBe(500);
    // Exposed threshold constant is 10 px.
    expect(SNAP_THRESHOLD_PX).toBe(10);
  });
});
