import type { ExportCompositionGraphV4 } from "@storycapture/shared-types";
import { describe, expect, it } from "vitest";
import { buildExportAudioPlan } from "./export-audio-planning";
import {
  analyzeExportPlan,
  ffmpegArgsForCanonicalExportPlan,
  validateExportOutput,
} from "./export-planning";
import type { ExportOutput } from "./shared";

function source(overrides: Record<string, unknown> = {}) {
  return {
    type: "source",
    id: "source-1",
    clip_id: "clip-1",
    path: "/tmp/in.mp4",
    pts_offset_ms: 0,
    timeline_start_ms: 0,
    duration_ms: 1_000,
    source_width: 1920,
    source_height: 1080,
    ...overrides,
  };
}

function graph(
  video: unknown[] = [source()],
  audio: unknown[] = [],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schema_version: 4,
    output_width: 1920,
    output_height: 1080,
    output_fps: 60,
    duration_ms: 1_000,
    video,
    audio,
    ...overrides,
  });
}

function output(overrides: Partial<ExportOutput> = {}): ExportOutput {
  return {
    format: "mp4",
    resolution: "match-source",
    fps: 60,
    quality: "high",
    encoder_options: {
      container: "mp4",
      codec: "h264",
      rate_control: "auto",
      hw_encoder: "libx264-software",
      quality_value: null,
      x264_preset: "medium",
      keyframe_interval_sec: 2,
      downscale_algo: "lanczos",
      audio: {
        codec: "aac",
        bitrate_kbps: 160,
        channels: 2,
        sample_rate_hz: 48_000,
      },
    },
    ...overrides,
  };
}

function runnablePlan(graphJson: string, cfg: ExportOutput) {
  const plan = analyzeExportPlan(graphJson, cfg);
  if (plan.kind === "unsupported") throw new Error(plan.reason);
  return plan;
}

function audioPlanFor(graphJson: string, format: "mp4" | "webm" = "mp4") {
  const parsed = JSON.parse(graphJson) as ExportCompositionGraphV4;
  return buildExportAudioPlan({
    graph: parsed,
    output: {
      format,
      bitrateKbps: 160,
      channels: 2,
      sampleRateHz: 48_000,
    },
    sourceAudio: Object.fromEntries(
      parsed.video.filter((node) => node.type === "source").map((node) => [node.id, true]),
    ),
  });
}

describe("canonical post-production export planning", () => {
  it("routes identity, retimed, and multi-source graphs through the compositor", () => {
    const identity = analyzeExportPlan(graph(), output());
    const retimed = analyzeExportPlan(
      graph([
        source({
          source_time_map: {
            version: 1,
            segments: [
              {
                kind: "media",
                sourceStartUs: 0,
                sourceEndUs: 500_000,
                timelineStartMs: 0,
                timelineEndMs: 500,
              },
              {
                kind: "hold",
                sourcePtsUs: 500_000,
                timelineStartMs: 500,
                timelineEndMs: 750,
              },
            ],
          },
        }),
      ]),
      output(),
    );
    const multiple = analyzeExportPlan(
      graph([
        source({ id: "source-a", path: "/tmp/a.mp4", duration_ms: 600 }),
        source({
          id: "source-b",
          clip_id: "clip-2",
          path: "/tmp/b.mp4",
          timeline_start_ms: 500,
          duration_ms: 500,
        }),
        {
          type: "transition",
          id: "transition-1",
          kind: "fade",
          duration_ms: 100,
          offset_ms: 500,
          from_source_id: "source-a",
          to_source_id: "source-b",
        },
      ]),
      output(),
    );

    expect(identity.kind).toBe("composited");
    expect(retimed.kind).toBe("composited");
    expect(multiple.kind).toBe("composited");
  });

  it("accepts every canonical visual node plus sound nodes", () => {
    const plan = analyzeExportPlan(
      graph(
        [
          source(),
          { type: "zoom-pan", id: "zoom" },
          { type: "background", id: "background" },
          { type: "cursor-overlay", id: "cursor" },
          { type: "ripple-overlay", id: "ripple" },
          { type: "highlight-overlay", id: "highlight" },
          { type: "text-overlay", id: "text" },
          { type: "transition", id: "transition" },
        ],
        [
          {
            type: "sound",
            id: "sound-1",
            clip_id: "audio-1",
            kind: "sfx",
            path: "/tmp/sfx.wav",
            t_start_ms: 0,
            duration_ms: 500,
            gain: 1,
            source_binding: null,
          },
        ],
      ),
      output(),
    );

    expect(plan.kind).toBe("composited");
  });

  it("rejects non-v4, source-less, path-less, duration-less, and unknown graphs", () => {
    expect(analyzeExportPlan(graph([source()], [], { schema_version: 3 }), output())).toMatchObject(
      {
        kind: "unsupported",
        reason: "canonical export requires composition graph schema v4",
      },
    );
    expect(analyzeExportPlan(graph([]), output())).toMatchObject({
      kind: "unsupported",
      reason: "export graph has no source video",
    });
    expect(analyzeExportPlan(graph([source({ path: "" })]), output())).toMatchObject({
      kind: "unsupported",
      reason: "export graph has no source video",
    });
    expect(analyzeExportPlan(graph([source()], [], { duration_ms: null }), output())).toMatchObject(
      {
        kind: "unsupported",
        reason: "canonical export requires graph duration_ms",
      },
    );
    expect(
      analyzeExportPlan(graph([source(), { type: "unknown-effect" }]), output()),
    ).toMatchObject({
      kind: "unsupported",
      requiredPlan: "composited",
      unsupportedNodes: ["unknown-effect"],
    });
    expect(
      analyzeExportPlan(graph([source()], [{ type: "audio-source" }]), output()),
    ).toMatchObject({
      kind: "unsupported",
      unsupportedNodes: ["audio:audio-source"],
    });
    expect(analyzeExportPlan("{", output()).kind).toBe("unsupported");
  });

  it("derives exact dimensions, duration, fps, and frame count", () => {
    expect(
      analyzeExportPlan(
        graph([source()], [], { duration_ms: 1_250, output_fps: 24 }),
        output({ resolution: "720p", fps: 24 }),
      ),
    ).toMatchObject({
      kind: "composited",
      outputWidth: 1280,
      outputHeight: 720,
      durationMs: 1_250,
      fps: 24,
      frameCount: 30,
      pixelFormat: "bgra",
    });
  });

  it("builds MP4 args from raw canonical frames and the full audio plan", () => {
    const graphJson = graph();
    const plan = runnablePlan(graphJson, output());
    const audioPlan = audioPlanFor(graphJson);
    const args = ffmpegArgsForCanonicalExportPlan(plan, audioPlan, "/tmp/out.mp4");

    expect(audioPlan.kind).toBe("mixed");
    expect(args.slice(0, 11)).toEqual([
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "-s",
      "1920x1080",
      "-framerate",
      "60",
      "-i",
      "pipe:0",
    ]);
    expect(args).toContain("/tmp/in.mp4");
    expect(args).toContain("-filter_complex");
    expect(args).toContain("[audio_master]");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("1.000000");
    expect(args.at(-1)).toBe("/tmp/out.mp4");
  });

  it("builds WebM with VP9/Opus and exact duration", () => {
    const graphJson = graph();
    const cfg = output({
      format: "webm",
      encoder_options: {
        ...output().encoder_options,
        container: "webm",
        audio: {
          codec: "opus",
          bitrate_kbps: 160,
          channels: 2,
          sample_rate_hz: 48_000,
        },
      },
    });
    const args = ffmpegArgsForCanonicalExportPlan(
      runnablePlan(graphJson, cfg),
      audioPlanFor(graphJson, "webm"),
      "/tmp/out.webm",
    );

    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("libopus");
    expect(args).toContain("1.000000");
    expect(args.at(-1)).toBe("/tmp/out.webm");
  });

  it("builds animated GIF from canonical frames without any audio input", () => {
    const graphJson = graph();
    const plan = runnablePlan(graphJson, output({ format: "gif", encoder_options: null }));
    const noAudio = buildExportAudioPlan({
      graph: JSON.parse(graphJson) as ExportCompositionGraphV4,
      output: { format: "gif" },
      sourceAudio: {},
    });
    const args = ffmpegArgsForCanonicalExportPlan(plan, noAudio, "/tmp/out.gif");

    expect(noAudio.kind).toBe("none");
    expect(args.join(" ")).toContain("palettegen=max_colors=256");
    expect(args.join(" ")).toContain("paletteuse=dither=sierra2_4a");
    expect(args).toContain("-an");
    expect(args).toContain("-loop");
    expect(args).toContain("1.000000");
    expect(args).not.toContain("/tmp/in.mp4");
    expect(args.at(-1)).toBe("/tmp/out.gif");
  });

  it("preserves explicit CRF 0, preset, and keyframe settings on canonical MP4", () => {
    const graphJson = graph();
    const cfg = output({
      encoder_options: {
        ...output().encoder_options,
        rate_control: "crf",
        quality_value: 0,
        x264_preset: "veryfast",
        keyframe_interval_sec: 2,
      },
    });
    const args = ffmpegArgsForCanonicalExportPlan(
      runnablePlan(graphJson, cfg),
      audioPlanFor(graphJson),
      "/tmp/out.mp4",
    );

    expect(args).toContain("-crf");
    expect(args).toContain("0");
    expect(args).toContain("veryfast");
    expect(args).toContain("-g");
    expect(args).toContain("120");
  });

  it("rejects an invalid audio plan for MP4/WebM", () => {
    const graphJson = graph();
    const invalidAudio = buildExportAudioPlan({
      graph: JSON.parse(graphJson) as ExportCompositionGraphV4,
      output: { format: "mp4", bitrateKbps: 160, channels: 2, sampleRateHz: 48_000 },
      sourceAudio: {},
    });

    expect(invalidAudio.kind).toBe("invalid");
    expect(() =>
      ffmpegArgsForCanonicalExportPlan(
        runnablePlan(graphJson, output()),
        invalidAudio,
        "/tmp/out.mp4",
      ),
    ).toThrow(/probe result/i);
  });

  it("validates container and audio combinations before queueing", () => {
    expect(() =>
      validateExportOutput(
        output({
          encoder_options: {
            container: "avi",
          } as unknown as ExportOutput["encoder_options"],
        }),
      ),
    ).toThrow(/unsupported encoder container/);

    expect(() =>
      validateExportOutput(
        output({
          format: "webm",
          encoder_options: {
            container: "mp4",
            audio: { codec: "aac" },
          },
        }),
      ),
    ).toThrow(/does not match export format/);

    expect(() =>
      validateExportOutput(
        output({
          format: "webm",
          encoder_options: {
            container: "webm",
            audio: { codec: "aac" },
          },
        }),
      ),
    ).toThrow(/Opus audio/);
  });
});
