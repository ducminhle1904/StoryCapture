/**
 * computeGraph tests. Coverage:
 *   - empty store ⇒ empty video/audio arrays + correct schema metadata
 *   - one clip per relevant track ⇒ nodes emitted in canonical order
 *     (Source → ZoomPan → CursorOverlay → TextOverlay) with shapes that
 *     deserialize cleanly into the Rust `effects::Graph` AST
 *   - determinism: two calls with the same state produce byte-equal JSON
 *   - clips missing required metadata are skipped (no source/audio path,
 *     no cursor trajectory dir, no annotation text)
 */

import { beforeEach, describe, expect, it } from "vitest";

import { computeGraph, graphIsRenderable } from "../state/compute-graph";
import { useEditorStore } from "../state/store";

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

beforeEach(resetStore);

describe("computeGraph", () => {
  it("empty store yields empty video/audio with schema metadata", () => {
    const g = computeGraph(useEditorStore.getState());
    expect(g.schema_version).toBe(2);
    expect(g.output_width).toBe(1920);
    expect(g.output_height).toBe(1080);
    expect(g.output_fps).toBe(60);
    expect(g.video).toEqual([]);
    expect(g.audio).toEqual([]);
    expect(graphIsRenderable(g)).toBe(false);
  });

  it("emits Source → ZoomPan → CursorOverlay → TextOverlay in canonical order", () => {
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 4000,
            metadata: { sourcePath: "/tmp/in.mp4" },
          },
        ],
        zoom: [
          {
            id: "z1",
            trackId: "zoom",
            startMs: 1000,
            durationMs: 1500,
            metadata: { scale: 2.0 },
          },
        ],
        cursor: [
          {
            id: "c1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 4000,
            metadata: {
              trajectoryDir: "/tmp/cursor",
              trajectoryFps: 60,
              trajectoryFrameCount: 240,
            },
          },
        ],
        annotations: [
          {
            id: "a1",
            trackId: "annotations",
            startMs: 500,
            durationMs: 1000,
            metadata: { text: "Hello" },
          },
        ],
        sound: [
          {
            id: "s1",
            trackId: "sound",
            startMs: 0,
            durationMs: 4000,
            metadata: { path: "/tmp/bgm.mp3", kind: "bgm" },
          },
        ],
      },
    });

    const g = computeGraph(useEditorStore.getState());
    expect(g.video.map((n) => n.type)).toEqual([
      "source",
      "zoom-pan",
      "cursor-overlay",
      "text-overlay",
    ]);
    expect(g.audio.map((n) => n.type)).toEqual(["audio-source"]);

    const src = g.video[0]!;
    if (src.type !== "source") throw new Error("expected source");
    expect(src.path).toBe("/tmp/in.mp4");
    expect(src.pts_offset_ms).toBe(0);

    const zoom = g.video[1]!;
    if (zoom.type !== "zoom-pan") throw new Error("expected zoom-pan");
    expect(zoom.target).toEqual({ kind: "cursor" });
    expect(zoom.keyframes).toHaveLength(2);
    expect(zoom.keyframes[1]!.scale).toBe(2.0);

    const text = g.video[3]!;
    if (text.type !== "text-overlay") throw new Error("expected text-overlay");
    expect(text.boxes[0]!.text).toBe("Hello");

    expect(graphIsRenderable(g)).toBe(true);
  });

  it("is deterministic — two calls produce byte-equal JSON", () => {
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            metadata: { sourcePath: "/x.mp4" },
          },
          {
            id: "v2",
            trackId: "video",
            startMs: 1000,
            durationMs: 1000,
            metadata: { sourcePath: "/y.mp4" },
          },
        ],
        cursor: [],
        zoom: [
          { id: "z1", trackId: "zoom", startMs: 200, durationMs: 400, metadata: {} },
        ],
        sound: [],
        annotations: [],
      },
    });

    const a = JSON.stringify(computeGraph(useEditorStore.getState()));
    const b = JSON.stringify(computeGraph(useEditorStore.getState()));
    expect(a).toBe(b);
  });

  it("skips clips missing required metadata", () => {
    useEditorStore.setState({
      tracks: {
        video: [
          { id: "v1", trackId: "video", startMs: 0, durationMs: 1000 }, // no sourcePath
        ],
        cursor: [
          { id: "c1", trackId: "cursor", startMs: 0, durationMs: 1000 }, // no trajectoryDir
        ],
        zoom: [],
        sound: [
          { id: "s1", trackId: "sound", startMs: 0, durationMs: 1000 }, // no path
        ],
        annotations: [
          { id: "a1", trackId: "annotations", startMs: 0, durationMs: 1000 }, // no text
        ],
      },
    });
    const g = computeGraph(useEditorStore.getState());
    expect(g.video).toEqual([]);
    expect(g.audio).toEqual([]);
  });
});
