import type { ExportTransitionKind } from "@storycapture/shared-types";
import { describe, expect, it } from "vitest";
import { exportFrameCommandSnapshot } from "../../export-compositor/canonical-export-adapter";
import {
  canonicalGraph,
  canonicalSource,
  canonicalTextBox,
  canonicalTransition,
} from "../../export-compositor/canonical-test-fixture";
import { CANONICAL_TRANSITION_KINDS } from "../../export-compositor/canvas-scene-renderer";
import { previewFrameCommandSnapshot } from "../canonical-preview-adapter";
import type { VirtualCursorSample } from "../virtual-cursor-path";

describe("canonical Preview/export visual parity", () => {
  it.each(
    CANONICAL_TRANSITION_KINDS,
  )("produces byte-identical deterministic commands for %s", (kind: ExportTransitionKind) => {
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 1_000),
      canonicalSource("source-b", 1_000, 1_000),
      canonicalTransition(kind),
      {
        type: "background",
        id: "background",
        kind: { kind: "gradient", preset_id: "runway-dark" },
        radius_px: 24,
        shadow: null,
        padding_px: 36,
      },
      {
        type: "cursor-overlay",
        id: "cursor",
        clip_id: "cursor-clip",
        skin: "mac-default",
        size_scale: 1.15,
        motion_preset: "cinematic",
        preserve_full_motion: true,
        click_effect: { style: "ring", color: "brand", intensity: "normal" },
        color_tint: { r: 110, g: 80, b: 240, a: 160 },
        t_start_ms: 0,
        duration_ms: 2_000,
        trajectory: {
          kind: "trajectory",
          path: "/tmp/cursor.json",
          png_sequence_dir: "/tmp/cursor.json",
          fps: 60,
          frame_count: 120,
        },
      },
      {
        type: "highlight-overlay",
        id: "highlights",
        highlights: [
          {
            clip_id: "highlight",
            t_start_ms: 0,
            duration_ms: 2_000,
            shape: "spotlight",
            center: { x: 640, y: 360 },
            source_center: { x: 0.55, y: 0.45 },
            source_bounds: { x: 0.45, y: 0.35, w: 0.2, h: 0.2 },
            max_radius_px: 60,
            padding_px: 10,
            radius_px: 12,
            stroke_px: 2,
            glow_px: 16,
            color: { r: 255, g: 255, b: 255, a: 255 },
            opacity: 0.72,
          },
        ],
      },
      {
        type: "ripple-overlay",
        id: "ripples",
        events: [
          {
            clip_id: "ripple",
            t_anticipate_ms: 760,
            t_impact_ms: 800,
            duration_ms: 500,
            center: { x: 0.58, y: 0.48 },
            max_radius_px: 48,
            color: { r: 80, g: 190, b: 255, a: 255 },
          },
        ],
      },
      {
        type: "text-overlay",
        id: "text",
        boxes: [canonicalTextBox({ kind: "cursor", offset: { x: 0.04, y: -0.05 } })],
      },
    ]);
    const cursorSample: VirtualCursorSample = {
      x: 0.58,
      y: 0.48,
      cursorScale: 0.96,
      clickFeedback: [],
    };
    const inputs = { cursor_samples: new Map([["cursor", cursorSample]]) };

    for (const timestampMs of [800, 850, 900, 950, 1_000]) {
      const preview = previewFrameCommandSnapshot(graph, timestampMs, inputs);
      const exported = exportFrameCommandSnapshot(graph, timestampMs, inputs);
      expect(new TextEncoder().encode(preview)).toEqual(new TextEncoder().encode(exported));
    }
  });
});
