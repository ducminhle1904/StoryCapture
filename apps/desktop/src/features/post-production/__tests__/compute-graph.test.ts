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
import { sampleExportZoom } from "../export-compositor/export-compositor-app";
import type { Graph, VideoNode } from "../state/compute-graph";
import { computeGraph, graphIsRenderable } from "../state/compute-graph";
import { DEFAULT_EXPORT_FORM } from "../state/export-slice";
import { useEditorStore } from "../state/store";
import { clearSystemFontCatalogCache, loadSystemFontCatalog } from "../state/system-font-catalog";
import type { ZoomClip } from "../state/timeline-slice";
import {
  applyZoomToPoint,
  normalizedZoomCenterToPixels,
  resolveZoomMotion,
  sampleResolvedZoom,
} from "../state/zoom-motion";

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

beforeEach(() => {
  resetStore();
  clearSystemFontCatalogCache();
});

describe("computeGraph", () => {
  it("empty store yields empty video/audio with schema metadata", () => {
    const g = computeGraph(useEditorStore.getState());
    expect(g.schema_version).toBe(3);
    expect(g.output_width).toBe(1920);
    expect(g.output_height).toBe(1080);
    expect(g.output_fps).toBe(60);
    expect(g.video).toEqual([]);
    expect(g.audio).toEqual([]);
    expect(graphIsRenderable(g)).toBe(false);
  });

  it("requires a source video node before a graph is renderable", () => {
    useEditorStore.setState({
      exportForm: { ...DEFAULT_EXPORT_FORM, frameMode: "framed" },
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "gradient", preset_id: "runway-dark" },
      },
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "text-only",
            trackId: "annotations",
            startMs: 0,
            durationMs: 1000,
            text: "Title only",
            pos: { x: 0.5, y: 0.5 },
            sizePt: 32,
          },
        ],
      },
    });

    const graph = computeGraph(useEditorStore.getState());

    expect(graph.video.map((node) => node.type)).toEqual(["background", "text-overlay"]);
    expect(graphIsRenderable(graph)).toBe(false);
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
            sourceSize: { width: 1440, height: 900 },
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
    expect(src.duration_ms).toBe(4000);
    expect(src.source_width).toBe(1440);
    expect(src.source_height).toBe(900);

    const zoom = videoNodeAt(g, 2);
    if (zoom.type !== "zoom-pan") throw new Error("expected zoom-pan");
    expect(zoom.target).toEqual({ kind: "cursor" });
    expect(zoom.keyframes).toHaveLength(4);
    expect(zoom.keyframes.map((k) => k.t_ms)).toEqual([1000, 1500, 2000, 2500]);
    expect(zoom.keyframes.map((k) => k.easing)).toEqual([
      "ease-out-cubic",
      "linear",
      "ease-out-cubic",
      "linear",
    ]);
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
    expect(cursor.click_effect).toEqual({
      style: "ring",
      color: "white",
      intensity: "normal",
    });
    expect(cursor.t_start_ms).toBe(0);
    expect(cursor.duration_ms).toBe(4000);

    const text = videoNodeAt(g, 5);
    if (text.type !== "text-overlay") throw new Error("expected text-overlay");
    expect(text.boxes[0]?.text).toBe("Hello");
    expect(text.boxes[0]?.anim_duration_ms).toBe(180);

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
            sourceSize: { width: 1920, height: 1080 },
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

  it("preserves source dimensions for source-mode match-source exports", () => {
    useEditorStore.setState({
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        resolution: "match-source",
        frameMode: "source",
      },
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "gradient", preset_id: "runway-dark" },
        captureRect: { x: 0, y: 0, width: 1800, height: 1012 },
      },
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            sourcePath: "/tmp/in.mp4",
            sourceSize: { width: 1920, height: 1080 },
          },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    const g = computeGraph(useEditorStore.getState());

    expect(g.output_width).toBe(1920);
    expect(g.output_height).toBe(1080);
    expect(g.video.some((n) => n.type === "background")).toBe(false);
  });

  it("falls back explicitly when match-source dimensions are unavailable", () => {
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

    expect(g.output_width).toBe(1920);
    expect(g.output_height).toBe(1080);
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

  it.each([
    {
      name: "regular motion and boundaries",
      clips: [
        {
          id: "regular",
          trackId: "zoom",
          startMs: 1_000,
          durationMs: 1_500,
          target: { kind: "cursor" },
          scale: 2,
          center: { x: 0.3, y: 0.4 },
          origin: "authored",
        },
      ] satisfies ZoomClip[],
      times: [999, 1_000, 1_225, 2_049, 2_500],
    },
    {
      name: "auto handoff",
      clips: [
        {
          id: "auto-a",
          trackId: "zoom",
          startMs: 500,
          durationMs: 1_200,
          target: { kind: "cursor" },
          scale: 1.8,
          center: { x: 0.3, y: 0.4 },
          origin: "auto",
        },
        {
          id: "auto-b",
          trackId: "zoom",
          startMs: 1_900,
          durationMs: 1_200,
          target: { kind: "cursor" },
          scale: 2.2,
          center: { x: 0.7, y: 0.6 },
          origin: "auto",
        },
      ] satisfies ZoomClip[],
      times: [500, 1_700, 1_900, 2_150, 3_100],
    },
    {
      name: "authored overlap prefers latest motion",
      clips: [
        {
          id: "authored-a",
          trackId: "zoom",
          startMs: 0,
          durationMs: 2_000,
          target: { kind: "cursor" },
          scale: 1.7,
          center: { x: 0.35, y: 0.45 },
          origin: "authored",
        },
        {
          id: "authored-b",
          trackId: "zoom",
          startMs: 1_000,
          durationMs: 1_500,
          target: { kind: "cursor" },
          scale: 2.1,
          center: { x: 0.65, y: 0.55 },
          origin: "authored",
        },
      ] satisfies ZoomClip[],
      times: [999, 1_000, 1_250, 1_999, 2_500],
    },
  ])("keeps preview-resolution and export sampling in parity for $name", ({ clips, times }) => {
    useEditorStore.setState({
      tracks: { video: [], cursor: [], zoom: clips, sound: [], annotations: [] },
    });
    const graph = computeGraph(useEditorStore.getState());
    const motions = resolveZoomMotion(clips);

    for (const timeMs of times) {
      const preview = sampleResolvedZoom(motions, timeMs);
      const exported = sampleExportZoom(graph, timeMs, graph.output_width, graph.output_height);
      const expectedCenter = normalizedZoomCenterToPixels(
        preview.center,
        preview.scale,
        graph.output_width,
        graph.output_height,
      );
      expect(exported.scale, `scale at ${timeMs}ms`).toBeCloseTo(preview.scale, 8);
      expect(exported.center.x, `center.x at ${timeMs}ms`).toBeCloseTo(expectedCenter.x, 8);
      expect(exported.center.y, `center.y at ${timeMs}ms`).toBeCloseTo(expectedCenter.y, 8);
    }
  });

  it("preserves distinct graph identity for authored zooms with the same start", () => {
    const clips: ZoomClip[] = [
      {
        id: "same-start-a",
        trackId: "zoom",
        startMs: 1_000,
        durationMs: 1_500,
        target: { kind: "cursor" },
        scale: 1.5,
        center: { x: 0.3, y: 0.4 },
        origin: "authored",
      },
      {
        id: "same-start-b",
        trackId: "zoom",
        startMs: 1_000,
        durationMs: 1_800,
        target: { kind: "element", selector: "#checkout" },
        scale: 2,
        center: { x: 0.7, y: 0.6 },
        origin: "authored",
      },
    ];
    useEditorStore.setState({
      tracks: { video: [], cursor: [], zoom: clips, sound: [], annotations: [] },
    });

    const nodes = computeGraph(useEditorStore.getState()).video.filter(
      (node) => node.type === "zoom-pan",
    );

    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);
    expect(nodes.map((node) => node.target)).toEqual(clips.map((clip) => clip.target));
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
    const expectedAnchor = applyZoomToPoint(
      { x: 0.25, y: 0.35 },
      sampleResolvedZoom(resolveZoomMotion(useEditorStore.getState().tracks.zoom), 1_500),
    );
    expect(text.boxes[0]?.pos.x).toBeCloseTo(expectedAnchor.x);
    expect(text.boxes[0]?.pos.y).toBeCloseTo(expectedAnchor.y);
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
      font: { kind: "bundled", family: "Geist", weight: 700, style: "normal" },
      size_pt: 18,
      color: { r: 248, g: 250, b: 252, a: 255 },
      align: "center",
      max_width_pct: 82,
      line_height: 1.1,
      letter_spacing_px: 0,
      text_shadow: null,
      box_style: {
        padding_px: 10,
        radius_px: 10,
        bg_color: { r: 16, g: 18, b: 21, a: 230 },
        border_color: { r: 255, g: 255, b: 255, a: 46 },
        border_width_px: 1,
        shadow: null,
      },
      anim_in: "fade",
      anim_out: "fade",
      anim_duration_ms: 180,
    });
  });

  it("maps resolved font, typography, text shadow, border, and box shadow overrides", () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "custom-text",
            trackId: "annotations",
            startMs: 500,
            durationMs: 1_500,
            text: "Custom\nstyle",
            pos: { x: 0.25, y: 0.7 },
            sizePt: 27,
            styleId: "caption",
            font: {
              kind: "system",
              family: "Example Sans",
              fullName: "Example Sans Semibold Italic",
              postscriptName: "ExampleSans-SemiboldItalic",
              faceStyle: "Semibold Italic",
              weight: 600,
              style: "italic",
            },
            color: "#abcdef80",
            align: "right",
            maxWidthPct: 44,
            lineHeight: 1.45,
            letterSpacingPx: 2.5,
            textShadow: { color: "#11223380", blurPx: 7, offsetXpx: 1.5, offsetYpx: 2 },
            boxStyle: {
              paddingPx: 12,
              radiusPx: 16,
              bgColor: "#223344cc",
              borderColor: "#fedcba99",
              borderWidthPx: 2.5,
              shadow: { color: "#01020366", blurPx: 9, offsetXpx: -2, offsetYpx: 3 },
            },
          },
        ],
      },
    });

    const graph = computeGraph(useEditorStore.getState());
    const text = graph.video.find((node) => node.type === "text-overlay");
    if (!text || text.type !== "text-overlay") throw new Error("expected text-overlay");
    expect(text.boxes[0]).toMatchObject({
      font: {
        kind: "system",
        family: "Example Sans",
        weight: 600,
        style: "italic",
      },
      align: "right",
      max_width_pct: 44,
      line_height: 1.45,
      letter_spacing_px: 2.5,
      color: { r: 171, g: 205, b: 239, a: 128 },
      text_shadow: {
        color: { r: 17, g: 34, b: 51, a: 128 },
        blur_px: 7,
        offset_x_px: 1.5,
        offset_y_px: 2,
      },
      box_style: {
        padding_px: 12,
        radius_px: 16,
        bg_color: { r: 34, g: 51, b: 68, a: 204 },
        border_color: { r: 254, g: 220, b: 186, a: 153 },
        border_width_px: 2.5,
        shadow: {
          color: { r: 1, g: 2, b: 3, a: 102 },
          blur_px: 9,
          offset_x_px: -2,
          offset_y_px: 3,
        },
      },
    });
  });

  it("emits the bundled fallback when a saved system font is missing", async () => {
    await loadSystemFontCatalog({ queryLocalFonts: async () => [] } as unknown as Window);
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "missing-font",
            trackId: "annotations",
            startMs: 0,
            durationMs: 1_000,
            text: "Fallback",
            pos: { x: 0.5, y: 0.5 },
            sizePt: 18,
            styleId: "callout",
            font: {
              kind: "system",
              family: "Missing Sans",
              fullName: "Missing Sans Regular",
              postscriptName: "MissingSans-Regular",
              faceStyle: "Regular",
              weight: 400,
              style: "normal",
            },
          },
        ],
      },
    });

    const text = computeGraph(useEditorStore.getState()).video.find(
      (node) => node.type === "text-overlay",
    );
    if (!text || text.type !== "text-overlay") throw new Error("expected text-overlay");
    expect(text.boxes[0]?.font).toEqual({
      kind: "bundled",
      family: "Geist",
      weight: 500,
      style: "normal",
    });
  });

  it("resolves target text anchors before emitting export text boxes", () => {
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "transparent" },
        actions: {
          source_version: 1,
          confidence: "legacy-approximate",
          recording_path: "/tmp/demo.mp4",
          cursor_motion_preset: "natural",
          viewport: { width: 1000, height: 500 },
          capture_rect: { x: 0, y: 0, width: 1000, height: 500 },
          fps_num: 60,
          fps_den: 1,
          frame_count: 600,
          events: [
            {
              source_index: 0,
              confidence: "legacy-approximate",
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
              cursor_timing: null,
              input_timing: { kind: "click", action_ms: 2000 },
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
