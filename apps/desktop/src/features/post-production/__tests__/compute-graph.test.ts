/**
 * computeGraph tests. Coverage:
 *   - empty store ⇒ empty video/audio arrays + correct schema metadata
 *   - one clip per relevant track ⇒ nodes emitted in canonical order
 *     (Source → ZoomPan → Background → CursorOverlay → TextOverlay → Transition)
 *     with shapes that deserialize cleanly into the Rust `effects::Graph` AST
 *   - determinism: two calls with the same state produce byte-equal JSON
 *   - clips missing required metadata are skipped (no source/audio path,
 *     no cursor trajectory dir, no annotation text)
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Graph, VideoNode } from "../state/compute-graph";
import { computeGraph, graphIsRenderable } from "../state/compute-graph";
import { DEFAULT_EXPORT_FORM } from "../state/export-slice";
import { useEditorStore } from "../state/store";

function videoNodeAt(graph: Graph, index: number): VideoNode {
  const node = graph.video[index];
  if (!node) throw new Error(`expected video node at index ${index}`);
  return node;
}

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
    exportForm: { ...DEFAULT_EXPORT_FORM },
    activeJobs: {},
    progressByJobId: {},
    _undoExtras: {
      graphSnapshot: {},
      textOverlays: {},
      background: { kind: "transparent" },
    },
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

  it("emits Source → ZoomPan → Background → CursorOverlay → TextOverlay → Transition in canonical order", () => {
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "gradient", preset_id: "runway-dark" },
      },
      exportForm: {
        formats: ["mp4"],
        resolution: "1080p",
        customWidth: 1920,
        customHeight: 1080,
        fps: 60,
        quality: "high",
        frameMode: "framed",
        outFolder: null,
        baseName: "export",
      },
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 4000,
            sourcePath: "/tmp/in.mp4",
            outgoingTransition: { kind: "fade", durationMs: 500 },
          },
          {
            id: "v2",
            trackId: "video",
            startMs: 4000,
            durationMs: 2000,
            sourcePath: "/tmp/out.mp4",
          },
        ],
        zoom: [
          {
            id: "z1",
            trackId: "zoom",
            startMs: 1000,
            durationMs: 1500,
            target: { kind: "cursor" },
            scale: 2.0,
            center: { x: 0.5, y: 0.5 },
          },
        ],
        cursor: [
          {
            id: "c1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 4000,
            trajectoryDir: "/tmp/cursor",
            trajectoryFps: 60,
            trajectoryFrameCount: 240,
            skin: "mac-default",
            motionPreset: "cinematic",
            sizeScale: 1,
          },
        ],
        annotations: [
          {
            id: "a1",
            trackId: "annotations",
            startMs: 500,
            durationMs: 1000,
            text: "Hello",
            pos: { x: 0.5, y: 0.9 },
            sizePt: 24,
          },
        ],
        sound: [
          {
            id: "s1",
            trackId: "sound",
            startMs: 0,
            durationMs: 4000,
            path: "/tmp/bgm.mp3",
            kind: "bgm",
            gain: 0.35,
          },
        ],
      },
    });

    const g = computeGraph(useEditorStore.getState());
    expect(g.video.map((n) => n.type)).toEqual([
      "source",
      "source",
      "zoom-pan",
      "background",
      "cursor-overlay",
      "text-overlay",
      "transition",
    ]);
    expect(g.audio.map((n) => n.type)).toEqual(["audio-source", "volume"]);
    expect(g.audio[1]).toMatchObject({ type: "volume", volume: 0.35 });

    const src = videoNodeAt(g, 0);
    if (src.type !== "source") throw new Error("expected source");
    expect(src.path).toBe("/tmp/in.mp4");
    expect(src.pts_offset_ms).toBe(0);

    const zoom = videoNodeAt(g, 2);
    if (zoom.type !== "zoom-pan") throw new Error("expected zoom-pan");
    expect(zoom.target).toEqual({ kind: "cursor" });
    expect(zoom.keyframes).toHaveLength(4);
    expect(zoom.keyframes.map((k) => k.t_ms)).toEqual([1000, 1220, 2280, 2500]);
    expect(zoom.keyframes.map((k) => k.scale)).toEqual([1.0, 2.0, 2.0, 1.0]);
    expect(zoom.keyframes.map((k) => k.center)).toEqual([
      { x: 960, y: 540 },
      { x: 960, y: 540 },
      { x: 960, y: 540 },
      { x: 960, y: 540 },
    ]);
    expect(zoom.keyframes[1]?.scale).toBe(2.0);

    const background = videoNodeAt(g, 3);
    if (background.type !== "background") throw new Error("expected background");
    expect(background.kind).toEqual({ kind: "gradient", preset_id: "runway-dark" });
    expect(background.radius_px).toBe(24);
    expect(background.padding_px).toBe(64);

    const cursor = videoNodeAt(g, 4);
    if (cursor.type !== "cursor-overlay") throw new Error("expected cursor-overlay");
    expect(cursor.motion_preset).toBe("cinematic");

    const text = videoNodeAt(g, 5);
    if (text.type !== "text-overlay") throw new Error("expected text-overlay");
    expect(text.boxes[0]?.text).toBe("Hello");

    const transition = videoNodeAt(g, 6);
    if (transition.type !== "transition") throw new Error("expected transition");
    expect(transition.kind).toBe("fade");
    expect(transition.duration_ms).toBe(500);
    expect(transition.offset_ms).toBe(3500);

    expect(graphIsRenderable(g)).toBe(true);
  });

  it("does not emit a background node for source-preserving exports", () => {
    useEditorStore.setState({
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        frameMode: "source",
      },
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "gradient", preset_id: "runway-dark" },
      },
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            sourcePath: "/tmp/in.mp4",
          },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    const g = computeGraph(useEditorStore.getState());

    expect(g.video.map((n) => n.type)).toEqual(["source"]);
  });

  it("expands match-source framed exports so the foreground keeps native pixels", () => {
    useEditorStore.setState({
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        resolution: "match-source",
        frameMode: "framed",
      },
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "gradient", preset_id: "runway-dark" },
        captureRect: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            sourcePath: "/tmp/in.mp4",
          },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    const g = computeGraph(useEditorStore.getState());
    const background = g.video.find((n) => n.type === "background");

    expect(g.output_width).toBe(2048);
    expect(g.output_height).toBe(1208);
    expect(background).toMatchObject({ type: "background", padding_px: 64 });
  });

  it("converts normalized zoom centers to crop-safe output pixels", () => {
    useEditorStore.setState({
      exportForm: {
        formats: ["mp4"],
        resolution: "720p",
        customWidth: 1920,
        customHeight: 1080,
        fps: 60,
        quality: "high",
        frameMode: "source",
        outFolder: null,
        baseName: "export",
      },
      tracks: {
        video: [],
        cursor: [],
        zoom: [
          {
            id: "z-edge",
            trackId: "zoom",
            startMs: 0,
            durationMs: 1000,
            target: { kind: "cursor" },
            scale: 2,
            center: { x: 0.05, y: 0.95 },
          },
        ],
        sound: [],
        annotations: [],
      },
    });

    const g = computeGraph(useEditorStore.getState());
    const zoom = videoNodeAt(g, 0);
    if (zoom.type !== "zoom-pan") throw new Error("expected zoom-pan");

    expect(g.output_width).toBe(1280);
    expect(g.output_height).toBe(720);
    expect(zoom.keyframes.map((k) => k.center)).toEqual([
      { x: 640, y: 360 },
      { x: 320, y: 540 },
      { x: 320, y: 540 },
      { x: 640, y: 360 },
    ]);
  });

  it("emits transition nodes with deterministic boundary order and Rust-compatible offsets", () => {
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "v2",
            trackId: "video",
            startMs: 5000,
            durationMs: 8000,
            sourcePath: "/v2.mp4",
            outgoingTransition: { kind: "wipe-left", durationMs: 300 },
          },
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 5000,
            sourcePath: "/v1.mp4",
            outgoingTransition: { kind: "fade", durationMs: 500 },
          },
          {
            id: "v3",
            trackId: "video",
            startMs: 13_000,
            durationMs: 12_000,
            sourcePath: "/v3.mp4",
          },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    const g = computeGraph(useEditorStore.getState());
    expect(g.video.map((n) => n.type)).toEqual([
      "source",
      "source",
      "source",
      "transition",
      "transition",
    ]);

    const transitions = g.video.filter((node) => node.type === "transition");
    expect(transitions).toEqual([
      expect.objectContaining({
        kind: "fade",
        duration_ms: 500,
        offset_ms: 4500,
      }),
      expect.objectContaining({
        kind: "wipe-left",
        duration_ms: 300,
        offset_ms: 12_200,
      }),
    ]);

    const second = computeGraph(useEditorStore.getState()).video.filter(
      (node) => node.type === "transition",
    );
    expect(transitions.map((node) => node.id)).toEqual(second.map((node) => node.id));
  });

  it("emits PNG highlight overlays before text overlays and preserves annotation color", () => {
    useEditorStore.setState({
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        resolution: "720p",
      },
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "a-highlight",
            trackId: "annotations",
            startMs: 1_000,
            durationMs: 1_500,
            text: "Important",
            pos: { x: 0.4, y: 0.8 },
            sizePt: 30,
            color: "#ffcc00",
            highlight: {
              center: { x: 0.25, y: 0.35 },
              radiusPx: 72,
              bounds: { x: 0.2, y: 0.3, w: 0.1, h: 0.08 },
              color: "#00ffaa",
              durationMs: 900,
            },
          },
        ],
      },
    });

    const g = computeGraph(useEditorStore.getState());
    expect(g.video.map((node) => node.type)).toEqual(["highlight-overlay", "text-overlay"]);
    const highlight = videoNodeAt(g, 0);
    if (highlight.type !== "highlight-overlay") throw new Error("expected highlight-overlay");
    expect(highlight.highlights[0]).toMatchObject({
      t_start_ms: 1_000,
      duration_ms: 900,
      max_radius_px: 72,
      shape: "ring",
      color: { r: 0, g: 255, b: 170, a: 255 },
    });
    expect(highlight.highlights[0]?.center.x).toBeCloseTo(320);
    expect(highlight.highlights[0]?.center.y).toBeCloseTo(252);
    expect(highlight.highlights[0]?.bounds?.x).toBeCloseTo(256);
    expect(highlight.highlights[0]?.bounds?.y).toBeCloseTo(216);
    expect(highlight.highlights[0]?.bounds?.w).toBeCloseTo(128);
    expect(highlight.highlights[0]?.bounds?.h).toBeCloseTo(57.6);
    const text = videoNodeAt(g, 1);
    if (text.type !== "text-overlay") throw new Error("expected text-overlay");
    expect(text.boxes[0]?.color).toEqual({ r: 255, g: 204, b: 0, a: 255 });
  });

  it("transforms highlight and callout anchors through active zoom", () => {
    useEditorStore.setState({
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        resolution: "720p",
      },
      tracks: {
        video: [],
        cursor: [],
        zoom: [
          {
            id: "zoom-focus",
            trackId: "zoom",
            startMs: 500,
            durationMs: 1200,
            target: { kind: "cursor" },
            scale: 2,
            center: { x: 0.25, y: 0.35 },
          },
        ],
        sound: [],
        annotations: [
          {
            id: "a-focus",
            trackId: "annotations",
            startMs: 1_000,
            durationMs: 1_000,
            text: "Focus",
            pos: { x: 0.25, y: 0.35 },
            sizePt: 24,
            anchor: { kind: "target", stepId: "step-1", placement: "right" },
            highlight: {
              center: { x: 0.25, y: 0.35 },
              radiusPx: 40,
              color: "#ffffff",
              durationMs: 700,
            },
          },
        ],
      },
    });

    const g = computeGraph(useEditorStore.getState());
    const highlight = g.video.find((node) => node.type === "highlight-overlay");
    if (!highlight || highlight.type !== "highlight-overlay") {
      throw new Error("expected highlight-overlay");
    }

    expect(highlight.highlights[0]?.center.x).toBeCloseTo(640);
    expect(highlight.highlights[0]?.center.y).toBeCloseTo(360);
    expect(highlight.highlights[0]?.max_radius_px).toBeCloseTo(80);

    const text = g.video.find((node) => node.type === "text-overlay");
    if (!text || text.type !== "text-overlay") throw new Error("expected text-overlay");
    expect(text.boxes[0]?.pos.x).toBeCloseTo(0.5);
    expect(text.boxes[0]?.pos.y).toBeCloseTo(0.5);
  });

  it("maps inherited text preset styling, background, font, and animation into text overlay boxes", () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "styled-text",
            trackId: "annotations",
            startMs: 1_000,
            durationMs: 2_200,
            text: "Styled",
            pos: { x: 0.5, y: 0.18 },
            sizePt: 18,
            styleId: "callout",
          },
        ],
      },
    });

    const graph = computeGraph(useEditorStore.getState());
    const text = graph.video.find((node) => node.type === "text-overlay");
    if (!text || text.type !== "text-overlay") throw new Error("expected text-overlay");
    expect(text.boxes[0]).toMatchObject({
      text: "Styled",
      font: { kind: "bundled", family: "Geist", weight: 700 },
      size_pt: 18,
      color: { r: 248, g: 250, b: 252, a: 255 },
      box_style: {
        padding_px: 10,
        radius_px: 10,
        bg_color: { r: 16, g: 18, b: 21, a: 230 },
        border_color: { r: 255, g: 255, b: 255, a: 46 },
      },
      anim_in: "fade",
      anim_out: "fade",
    });
  });

  it("resolves target text anchors before emitting export text boxes", () => {
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "transparent" },
        actions: {
          version: 1,
          recording_path: "/tmp/demo.mp4",
          viewport: { width: 1000, height: 500 },
          capture_rect: { x: 0, y: 0, width: 1000, height: 500 },
          fps: 60,
          frame_count: 600,
          events: [
            {
              step_id: "step-1",
              ordinal: 1,
              verb: "click",
              t_start_ms: 1000,
              t_action_ms: 2000,
              t_end_ms: 2200,
              target: {
                kind: "element",
                label: "Sign In",
                center: { x: 800, y: 300 },
                bounds: { x: 760, y: 280, w: 80, h: 40 },
              },
              secondary_target: null,
              pointer: { button: "left", effect: "click" },
            },
          ],
        },
      },
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "target-text",
            trackId: "annotations",
            startMs: 1_000,
            durationMs: 2_200,
            text: "Attached",
            pos: { x: 0.12, y: 0.12 },
            sizePt: 18,
            anchor: { kind: "target", stepId: "step-1", placement: "right" },
          },
        ],
      },
    });

    const graph = computeGraph(useEditorStore.getState());
    const text = graph.video.find((node) => node.type === "text-overlay");
    if (!text || text.type !== "text-overlay") throw new Error("expected text-overlay");
    expect(text.boxes[0]?.pos.x).toBeCloseTo(0.9);
    expect(text.boxes[0]?.pos.y).toBeCloseTo(0.6);
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
            sourcePath: "/x.mp4",
          },
          {
            id: "v2",
            trackId: "video",
            startMs: 1000,
            durationMs: 1000,
            sourcePath: "/y.mp4",
          },
        ],
        cursor: [],
        zoom: [
          {
            id: "z1",
            trackId: "zoom",
            startMs: 200,
            durationMs: 400,
            target: { kind: "cursor" },
            scale: 1.5,
            center: { x: 0.5, y: 0.5 },
          },
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
          // Empty sourcePath ⇒ skipped at runtime.
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            sourcePath: "",
            outgoingTransition: { kind: "fade", durationMs: 500 },
          },
          {
            id: "v2",
            trackId: "video",
            startMs: 1000,
            durationMs: 1000,
            sourcePath: "",
          },
        ],
        cursor: [
          // Empty trajectoryDir ⇒ skipped.
          {
            id: "c1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 1000,
            trajectoryDir: "",
            trajectoryFps: 60,
            trajectoryFrameCount: 0,
            skin: "mac-default",
            sizeScale: 1,
          },
        ],
        zoom: [],
        sound: [
          // Empty path ⇒ skipped.
          { id: "s1", trackId: "sound", startMs: 0, durationMs: 1000, path: "", kind: "sfx" },
        ],
        annotations: [
          // Empty text ⇒ skipped.
          {
            id: "a1",
            trackId: "annotations",
            startMs: 0,
            durationMs: 1000,
            text: "",
            pos: { x: 0.5, y: 0.9 },
            sizePt: 24,
          },
        ],
      },
    });
    const g = computeGraph(useEditorStore.getState());
    expect(g.video).toEqual([]);
    expect(g.audio).toEqual([]);
  });
});
