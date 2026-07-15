import { describe, expect, it } from "vitest";

import type { VirtualCursorSample } from "../preview/virtual-cursor-path";
import {
  canonicalGraph,
  canonicalSource,
  canonicalTextBox,
  canonicalTransition,
} from "./canonical-test-fixture";
import { CANONICAL_VISUAL_NODE_TYPES, evaluateScene } from "./scene-evaluator";

describe("canonical scene evaluator", () => {
  it("keeps an explicit exhaustive mapping for every visual graph node", () => {
    expect(CANONICAL_VISUAL_NODE_TYPES).toEqual([
      "source",
      "zoom-pan",
      "background",
      "cursor-overlay",
      "ripple-overlay",
      "highlight-overlay",
      "text-overlay",
      "transition",
    ]);
  });

  it("evaluates transition overlap, source maps, and tail hold deterministically", () => {
    const sourceA = canonicalSource("source-a", 0, 1_000);
    sourceA.source_time_map = {
      version: 1,
      segments: [
        {
          kind: "media",
          sourceStartUs: 0,
          sourceEndUs: 700_000,
          timelineStartMs: 0,
          timelineEndMs: 700,
        },
        {
          kind: "hold",
          sourcePtsUs: 700_000,
          timelineStartMs: 700,
          timelineEndMs: 1_000,
          reason: "cursor-motion",
        },
      ],
    };
    const graph = canonicalGraph([
      sourceA,
      canonicalSource("source-b", 1_000, 1_000),
      canonicalTransition("wipe-left"),
    ]);
    graph.duration_ms = 2_400;

    const first = evaluateScene(graph, 850);
    const second = evaluateScene(graph, 850);

    expect(first).toEqual(second);
    expect(first.transition).toMatchObject({ kind: "wipe-left", progress: 0.25 });
    expect(first.sources.map((source) => source.node.id)).toEqual(["source-a", "source-b"]);
    expect(first.sources.map((source) => source.source_pts_us)).toEqual([700_000, 50_000]);

    const postTransition = evaluateScene(graph, 1_050);
    expect(postTransition.sources[0]).toMatchObject({
      effective_start_ms: 800,
      local_timeline_ms: 250,
      source_pts_us: 250_000,
      held: false,
    });

    const tail = evaluateScene(graph, 2_300);
    expect(tail.sources[0]).toMatchObject({
      node: expect.objectContaining({ id: "source-b" }),
      local_timeline_ms: 1_000,
      source_pts_us: 1_000_000,
      held: true,
    });
  });

  it("applies normalized cursor offsets and target margins to pixel-space inputs", () => {
    const cursorNode = {
      type: "cursor-overlay" as const,
      id: "cursor-pixels",
      clip_id: "cursor-pixels-clip",
      skin: "mac-default" as const,
      size_scale: 1,
      motion_preset: "natural" as const,
      preserve_full_motion: true,
      click_effect: { style: "none", color: "auto", intensity: "normal" } as const,
      color_tint: null,
      t_start_ms: 0,
      duration_ms: 2_000,
      trajectory: {
        kind: "trajectory" as const,
        path: "/tmp/cursor-pixels.json",
        png_sequence_dir: "/tmp/cursor-pixels.json",
        fps: 60,
        frame_count: 120,
      },
    };
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 2_000),
      cursorNode,
      {
        type: "text-overlay",
        id: "text-pixels",
        boxes: [
          canonicalTextBox({ kind: "cursor", offset: { x: 0.04, y: -0.06 } }),
          canonicalTextBox({ kind: "target", stepId: "step-pixels", placement: "right" }),
        ],
      },
    ]);
    const scene = evaluateScene(graph, 500, {
      cursor_samples: new Map([
        [
          cursorNode.id,
          { x: 640, y: 360, cursorScale: 1, clickFeedback: [] } satisfies VirtualCursorSample,
        ],
      ]),
      target_bounds_by_step_id: new Map([["step-pixels", { x: 256, y: 144, w: 256, h: 144 }]]),
    });
    const textByAnchor = new Map(scene.text.map((text) => [text.box.anchor.kind, text]));

    expect(textByAnchor.get("cursor")?.pos.x).toBeCloseTo(0.54, 6);
    expect(textByAnchor.get("cursor")?.pos.y).toBeCloseTo(0.44, 6);
    expect(textByAnchor.get("target")?.pos.x).toBeCloseTo(0.46, 6);
    expect(textByAnchor.get("target")?.pos.y).toBeCloseTo(0.3, 6);
  });

  it("resolves cursor, target, safe-area, and screen anchors at each frame", () => {
    const cursorNode = {
      type: "cursor-overlay" as const,
      id: "cursor",
      clip_id: "cursor-clip",
      skin: "mac-default" as const,
      size_scale: 1,
      motion_preset: "natural" as const,
      preserve_full_motion: true,
      click_effect: { style: "ring", color: "brand", intensity: "normal" } as const,
      color_tint: { r: 180, g: 80, b: 255, a: 160 },
      t_start_ms: 0,
      duration_ms: 2_000,
      trajectory: {
        kind: "trajectory" as const,
        path: "/tmp/cursor.json",
        png_sequence_dir: "/tmp/cursor.json",
        fps: 60,
        frame_count: 120,
      },
    };
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 2_000),
      {
        type: "background",
        id: "background",
        kind: { kind: "solid", color: { r: 10, g: 20, b: 30, a: 255 } },
        radius_px: 24,
        shadow: null,
        padding_px: 40,
      },
      {
        type: "zoom-pan",
        id: "zoom",
        clip_id: "zoom-clip",
        t_start_ms: 0,
        duration_ms: 2_000,
        target: { kind: "cursor" },
        keyframes: [
          { t_ms: 0, center: { x: 640, y: 360 }, scale: 1, easing: "linear" },
          { t_ms: 2_000, center: { x: 640, y: 360 }, scale: 2, easing: "linear" },
        ],
      },
      cursorNode,
      {
        type: "highlight-overlay",
        id: "highlights",
        highlights: [
          {
            clip_id: "highlight",
            t_start_ms: 0,
            duration_ms: 2_000,
            shape: "ring",
            center: { x: 640, y: 360 },
            source_center: { x: 0.5, y: 0.5 },
            source_bounds: { x: 0.35, y: 0.3, w: 0.2, h: 0.2 },
            max_radius_px: 40,
            padding_px: 8,
            radius_px: 10,
            stroke_px: 2,
            glow_px: 10,
            color: { r: 255, g: 200, b: 40, a: 255 },
            opacity: 0.8,
          },
        ],
      },
      {
        type: "text-overlay",
        id: "text",
        boxes: [
          canonicalTextBox({ kind: "cursor", offset: { x: 0.05, y: -0.04 } }),
          canonicalTextBox({ kind: "target", stepId: "step-1", placement: "right" }),
          canonicalTextBox({ kind: "safe-area", placement: "bottom" }),
          canonicalTextBox({ kind: "screen", pos: { x: 0.2, y: 0.3 } }),
        ],
      },
    ]);
    const sample: VirtualCursorSample = {
      x: 0.6,
      y: 0.45,
      cursorScale: 1,
      clickFeedback: [],
    };

    const frameA = evaluateScene(graph, 500, {
      cursor_samples: new Map([["cursor", sample]]),
      target_bounds_by_step_id: new Map([["step-1", { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }]]),
    });
    const frameB = evaluateScene(graph, 1_500, {
      cursor_samples: new Map([["cursor", sample]]),
      target_bounds_by_step_id: new Map([["step-1", { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }]]),
    });

    const frameAText = new Map(frameA.text.map((value) => [value.box.anchor.kind, value]));
    const frameBText = new Map(frameB.text.map((value) => [value.box.anchor.kind, value]));
    expect(Array.from(frameAText.keys()).sort()).toEqual([
      "cursor",
      "safe-area",
      "screen",
      "target",
    ]);
    expect(frameAText.get("safe-area")?.pos).toEqual({ x: 0.5, y: 0.86 });
    expect(frameAText.get("screen")?.pos).toEqual({ x: 0.2, y: 0.3 });
    expect(frameBText.get("cursor")?.pos).not.toEqual(frameAText.get("cursor")?.pos);
    expect(frameBText.get("target")?.pos).not.toEqual(frameAText.get("target")?.pos);
    expect(frameA.highlights[0]?.center).toEqual({ x: 640, y: 360 });
    expect(frameB.highlights[0]?.bounds?.w).toBeGreaterThan(frameA.highlights[0]?.bounds?.w ?? 0);
  });

  it("selects a deterministic PNG sequence frame and preserves cursor tint", () => {
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 2_000),
      {
        type: "cursor-overlay",
        id: "cursor-png",
        clip_id: "cursor-png-clip",
        skin: "dark",
        size_scale: 1.2,
        motion_preset: "cinematic",
        preserve_full_motion: false,
        click_effect: { style: "none", color: "auto", intensity: "subtle" },
        color_tint: { r: 20, g: 220, b: 180, a: 180 },
        t_start_ms: 100,
        duration_ms: 1_000,
        trajectory: {
          kind: "png-sequence",
          path: "/tmp/cursor-sequence",
          png_sequence_dir: "/legacy/cursor-sequence",
          fps: 30,
          frame_count: 10,
        },
      },
    ]);

    const scene = evaluateScene(graph, 450);
    expect(scene.cursors[0]).toMatchObject({
      png_frame_index: 9,
      node: {
        color_tint: { r: 20, g: 220, b: 180, a: 180 },
        trajectory: { path: "/tmp/cursor-sequence" },
      },
    });
  });
});
