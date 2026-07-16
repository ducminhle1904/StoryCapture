import type { ExportCompositionGraphV4, ExportPreflightArgs } from "@storycapture/shared-types";
import { describe, expect, it } from "vitest";

import { exportPreflight } from "./export-preflight";

type ExportPreflightArgsWithDisclosure = ExportPreflightArgs & {
  ai_disclosure?: { contains_ai_voiceover: boolean; embed_xmp: boolean };
};

const GRAPH: ExportCompositionGraphV4 = {
  schema_version: 4,
  output_width: 1920,
  output_height: 1080,
  output_fps: 60,
  duration_ms: 2_000,
  video: [
    {
      type: "source",
      id: "00000000-0000-4000-8000-000000000001",
      clip_id: "video-1",
      path: "/tmp/source.mp4",
      pts_offset_ms: 0,
      timeline_start_ms: 0,
      duration_ms: 2_000,
      source_width: 1920,
      source_height: 1080,
    },
  ],
  audio: [],
};

function args(
  overrides: Partial<ExportPreflightArgsWithDisclosure> = {},
): ExportPreflightArgsWithDisclosure {
  return {
    graph_json: JSON.stringify(GRAPH),
    outputs: [{ format: "mp4", resolution: "1080p", fps: 60, quality: "high" }],
    compiler_issues: [],
    ...overrides,
  };
}

describe("exportPreflight", () => {
  it("accepts a valid graph/output and reports canonical duration", () => {
    const result = exportPreflight(args());

    expect(result.ready).toBe(true);
    expect(result.composition_duration_ms).toBe(2_000);
    expect(result.outputs).toEqual([
      expect.objectContaining({ output_index: 0, format: "mp4", ready: true, issues: [] }),
    ]);
  });

  it("warns without blocking when requested XMP cannot be embedded in WebM or GIF", () => {
    const result = exportPreflight(
      args({
        outputs: [
          { format: "webm", resolution: "1080p", fps: 60, quality: "high" },
          { format: "gif", resolution: "1080p", fps: 60, quality: "high" },
        ],
        ai_disclosure: { contains_ai_voiceover: true, embed_xmp: true },
      }),
    );

    expect(result.ready).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "output.xmp-mp4-only",
        severity: "warning",
        output_index: 0,
      }),
      expect.objectContaining({
        code: "output.xmp-mp4-only",
        severity: "warning",
        output_index: 1,
      }),
    ]);
    expect(result.outputs.every((output) => output.ready)).toBe(true);
  });

  it("returns typed compiler and output issues without throwing", () => {
    const result = exportPreflight(
      args({
        outputs: [{ format: "avi", resolution: "1080p", fps: 60, quality: "high" }],
        compiler_issues: [
          {
            id: "sound.missing-source:voiceover",
            code: "sound.missing-source",
            severity: "error",
            message: "Voiceover source is missing.",
            clip_id: "voiceover",
          },
        ],
      }),
    );

    expect(result.ready).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "sound.missing-source",
      "output.invalid-config",
    ]);
    expect(result.outputs[0]?.ready).toBe(false);
  });

  it("rejects encoder-specific rate-control and preset combinations", () => {
    const result = exportPreflight(
      args({
        outputs: [
          {
            format: "mp4",
            resolution: "1080p",
            fps: 60,
            quality: "high",
            encoder_options: {
              container: "mp4",
              codec: "h264",
              hw_encoder: "nvenc-h264",
              rate_control: "crf",
              encoder_preset: "slow",
              resampling_quality: "high",
            },
          },
        ],
      }),
    );

    expect(result.ready).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "output.invalid-config",
        message: expect.stringMatching(/rate control crf.*nvenc-h264/i),
      }),
    ]);
  });

  it("accepts canonical generic preset and resampling fields", () => {
    const result = exportPreflight(
      args({
        outputs: [
          {
            format: "mp4",
            resolution: "1080p",
            fps: 60,
            quality: "high",
            encoder_options: {
              container: "mp4",
              codec: "h264",
              hw_encoder: "libx264-software",
              rate_control: "crf",
              encoder_preset: "slow",
              resampling_quality: "balanced",
            },
          },
        ],
      }),
    );

    expect(result.ready).toBe(true);
  });

  it("rejects an x264 preset on a hardware encoder", () => {
    const result = exportPreflight(
      args({
        outputs: [
          {
            format: "mp4",
            resolution: "1080p",
            fps: 60,
            quality: "high",
            encoder_options: {
              container: "mp4",
              codec: "h264",
              hw_encoder: "nvenc-h264",
              rate_control: "vbr",
              encoder_preset: "slow",
              resampling_quality: "high",
            },
          },
        ],
      }),
    );

    expect(result.ready).toBe(false);
    expect(result.issues[0]?.message).toMatch(/preset slow.*nvenc-h264/i);
  });
});
