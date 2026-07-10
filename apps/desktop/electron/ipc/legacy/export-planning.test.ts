import { describe, expect, it } from "vitest";
import {
  analyzeExportPlan,
  ffmpegArgsForExportPlan,
  mappedAudioFilter,
  validateExportOutput,
} from "./export-planning";
import type { ExportOutput } from "./shared";

function graph(video: unknown[], audio: unknown[] = []): string {
  return JSON.stringify({
    schema_version: 2,
    output_width: 1920,
    output_height: 1080,
    output_fps: 60,
    video,
    audio,
  });
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    type: "source",
    path: "/tmp/in.mp4",
    pts_offset_ms: 0,
    duration_ms: 1_000,
    source_fps: 60,
    ...overrides,
  };
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
      hw_encoder: null,
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

describe("post-production export planning", () => {
  it("forces compositor export for a non-identity source time map", () => {
    const plan = analyzeExportPlan(
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
              { kind: "hold", sourcePtsUs: 500_000, timelineStartMs: 500, timelineEndMs: 750 },
            ],
          },
        }),
      ]),
      output(),
    );
    expect(plan.kind).toBe("composited");
  });

  it("maps capture-bound audio through media and exact silence hold segments", () => {
    const filter = mappedAudioFilter({
      version: 1,
      segments: [
        {
          kind: "media",
          sourceStartUs: 0,
          sourceEndUs: 500_000,
          timelineStartMs: 0,
          timelineEndMs: 500,
        },
        { kind: "hold", sourcePtsUs: 500_000, timelineStartMs: 500, timelineEndMs: 750 },
        {
          kind: "media",
          sourceStartUs: 500_000,
          sourceEndUs: 1_000_000,
          timelineStartMs: 750,
          timelineEndMs: 1_250,
        },
      ],
    });
    expect(filter).toContain("atrim=start=0:end=0.5");
    expect(filter).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=0.25");
    expect(filter).toContain("concat=n=3:v=0:a=1[mapped_audio]");
  });

  it("classifies a one-source match-source high-quality MP4 as source-copy eligible", () => {
    const plan = analyzeExportPlan(graph([source()]), output());

    expect(plan.kind).toBe("source-copy");
    if (plan.kind === "unsupported") throw new Error(plan.reason);
    expect(ffmpegArgsForExportPlan(plan, "/tmp/out.mp4")).toEqual([
      "-y",
      "-i",
      "/tmp/in.mp4",
      "-map",
      "0",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "/tmp/out.mp4",
    ]);
  });

  it("re-encodes one source when resolution or fps changes", () => {
    const plan = analyzeExportPlan(graph([source()]), output({ resolution: "1080p", fps: 30 }));

    expect(plan.kind).toBe("simple-reencode");
    if (plan.kind === "unsupported") throw new Error(plan.reason);
    const args = ffmpegArgsForExportPlan(plan, "/tmp/out.mp4");
    expect(args).toContain("-vf");
    expect(args).toContain("fps=30,scale=1920:1080:flags=lanczos");
  });

  it("does not source-copy when source fps metadata is missing", () => {
    const plan = analyzeExportPlan(graph([source({ source_fps: undefined })]), output());

    expect(plan.kind).toBe("simple-reencode");
  });

  it("does not source-copy when audio encoding settings change", () => {
    const baseOptions = must(output().encoder_options);
    const cfg = output({
      encoder_options: {
        ...baseOptions,
        audio: {
          codec: "aac",
          bitrate_kbps: 192,
          channels: 2,
          sample_rate_hz: 48_000,
        },
      },
    });
    const plan = analyzeExportPlan(graph([source()]), cfg);

    expect(plan.kind).toBe("simple-reencode");
    if (plan.kind === "unsupported") throw new Error(plan.reason);
    const args = ffmpegArgsForExportPlan(plan, "/tmp/out.mp4");
    expect(args).toContain("-b:a");
    expect(args).toContain("192k");
  });

  it("source-copies WebM when default Opus audio options are present", () => {
    const baseOptions = must(output().encoder_options);
    const cfg = output({
      format: "webm",
      encoder_options: {
        ...baseOptions,
        container: "webm",
        audio: {
          codec: "opus",
          bitrate_kbps: 160,
          channels: 2,
          sample_rate_hz: 48_000,
        },
      },
    });
    const plan = analyzeExportPlan(graph([source({ path: "/tmp/in.webm" })]), cfg);

    expect(plan.kind).toBe("source-copy");
    if (plan.kind === "unsupported") throw new Error(plan.reason);
    expect(ffmpegArgsForExportPlan(plan, "/tmp/out.webm")).toEqual([
      "-y",
      "-i",
      "/tmp/in.webm",
      "-map",
      "0",
      "-c",
      "copy",
      "/tmp/out.webm",
    ]);
  });

  it("fails fast for multiple sources until simple concat is implemented", () => {
    const plan = analyzeExportPlan(
      graph([source({ path: "/tmp/a.mp4" }), source({ path: "/tmp/b.mp4", pts_offset_ms: 1_000 })]),
      output(),
    );

    expect(plan).toMatchObject({
      kind: "unsupported",
      requiredPlan: "simple-concat",
    });
    if (plan.kind === "unsupported") expect(plan.reason).toMatch(/simple concat/);
  });

  it("classifies cursor overlays as composited exports", () => {
    const plan = analyzeExportPlan(
      graph([
        source({ source_width: 1920, source_height: 1080 }),
        {
          type: "cursor-overlay",
          id: "cursor",
          skin: "mac-default",
          size_scale: 1,
          motion_preset: "natural",
          color_tint: null,
          trajectory: {
            png_sequence_dir: "/tmp/in.actions.json",
            fps: 60,
            frame_count: 60,
          },
        },
      ]),
      output(),
    );

    expect(plan).toMatchObject({
      kind: "composited",
      outputWidth: 1920,
      outputHeight: 1080,
      fps: 60,
      durationMs: 1_000,
      frameCount: 60,
    });
  });

  it("classifies zoom and highlight overlays as composited exports", () => {
    const plan = analyzeExportPlan(
      graph([
        source(),
        {
          type: "zoom-pan",
          id: "zoom",
          target: { kind: "cursor" },
          keyframes: [
            { t_ms: 0, center: { x: 960, y: 540 }, scale: 1 },
            { t_ms: 200, center: { x: 960, y: 540 }, scale: 1.5 },
          ],
        },
        {
          type: "highlight-overlay",
          id: "highlight",
          highlights: [
            {
              t_start_ms: 100,
              duration_ms: 500,
              shape: "ring",
              center: { x: 960, y: 540 },
              max_radius_px: 56,
              padding_px: 8,
              radius_px: 56,
              stroke_px: 2,
              glow_px: 16,
              color: { r: 255, g: 255, b: 255, a: 229 },
              opacity: 0.72,
            },
          ],
        },
      ]),
      output(),
    );

    expect(plan).toMatchObject({
      kind: "composited",
      outputWidth: 1920,
      outputHeight: 1080,
      fps: 60,
    });
  });

  it("fails fast for unsupported compositor graph nodes and audio graph nodes", () => {
    const plan = analyzeExportPlan(
      graph(
        [source(), { type: "transition", id: "transition", kind: "fade", duration_ms: 250 }],
        [{ type: "audio-source", path: "/tmp/audio.m4a", pts_offset_ms: 0 }],
      ),
      output(),
    );

    expect(plan).toMatchObject({
      kind: "unsupported",
      requiredPlan: "composited",
      unsupportedNodes: ["audio", "transition"],
    });
  });

  it("fails fast for composited source offsets until audio alignment is implemented", () => {
    const plan = analyzeExportPlan(
      graph([
        source({ pts_offset_ms: 2_000 }),
        {
          type: "cursor-overlay",
          id: "cursor",
          skin: "mac-default",
          size_scale: 1,
          motion_preset: "natural",
          color_tint: null,
          trajectory: {
            png_sequence_dir: "/tmp/in.actions.json",
            fps: 60,
            frame_count: 60,
          },
        },
      ]),
      output(),
    );

    expect(plan).toMatchObject({
      kind: "unsupported",
      requiredPlan: "composited",
      unsupportedNodes: ["pts_offset_ms"],
    });
  });

  it("returns unsupported for invalid or missing source graphs", () => {
    expect(analyzeExportPlan("{", output())).toMatchObject({
      kind: "unsupported",
    });
    expect(analyzeExportPlan(graph([]), output())).toMatchObject({
      kind: "unsupported",
      reason: "export graph has no source video",
    });
  });

  it("maps software H.264 CRF, preset, keyframes, scaling, and audio args", () => {
    const cfg = output({
      resolution: "720p",
      encoder_options: {
        container: "mp4",
        codec: "h264",
        rate_control: "crf",
        hw_encoder: "libx264-software",
        quality_value: 17,
        x264_preset: "slow",
        keyframe_interval_sec: 2,
        downscale_algo: "bicubic",
        audio: {
          codec: "aac",
          bitrate_kbps: 192,
          channels: 1,
          sample_rate_hz: 44_100,
        },
      },
    });
    const args = ffmpegArgsForExportPlan(runnablePlan(graph([source()]), cfg), "/tmp/out.mp4");

    expect(args).toContain("fps=60,scale=1280:720:flags=bicubic");
    expect(args).toContain("libx264");
    expect(args).toContain("slow");
    expect(args).toContain("-crf");
    expect(args).toContain("17");
    expect(args).toContain("-g");
    expect(args).toContain("120");
    expect(args).toContain("-c:a");
    expect(args).toContain("aac");
    expect(args).toContain("192k");
    expect(args).not.toContain("-an");
  });

  it("maps CRF 0 to a real lossless H.264 encode", () => {
    const cfg = output({
      encoder_options: {
        container: "mp4",
        codec: "h264",
        rate_control: "crf",
        hw_encoder: "libx264-software",
        quality_value: 0,
        x264_preset: "veryfast",
        keyframe_interval_sec: 2,
        downscale_algo: "lanczos",
        audio: {
          codec: "aac",
          bitrate_kbps: 160,
          channels: 2,
          sample_rate_hz: 48_000,
        },
      },
    });

    const args = ffmpegArgsForExportPlan(runnablePlan(graph([source()]), cfg), "/tmp/out.mp4");
    expect(args).toContain("-crf");
    expect(args).toContain("0");
    expect(args).toContain("veryfast");
  });

  it("maps composited MP4 exports to raw-video stdin with source audio", () => {
    const plan = runnablePlan(
      graph([
        source({ source_width: 1920, source_height: 1080 }),
        {
          type: "text-overlay",
          id: "text",
          boxes: [
            {
              t_start_ms: 0,
              t_end_ms: 1_000,
              text: "Hello",
              pos: { x: 0.5, y: 0.5 },
              font: { family: "Inter", weight: 700 },
              size_pt: 32,
              color: { r: 255, g: 255, b: 255, a: 255 },
              box_style: null,
              anim_in: "none",
              anim_out: "none",
            },
          ],
        },
      ]),
      output(),
    );

    expect(plan.kind).toBe("composited");
    expect(ffmpegArgsForExportPlan(plan, "/tmp/out.mp4")).toEqual([
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
      "-i",
      "/tmp/in.mp4",
      "-map",
      "0:v:0",
      "-map",
      "1:a?",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-g",
      "120",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-shortest",
      "/tmp/out.mp4",
    ]);
  });

  it("uses the requested resolution for composited exports", () => {
    const plan = runnablePlan(
      graph([
        source({ source_width: 1920, source_height: 1080 }),
        {
          type: "text-overlay",
          id: "text",
          boxes: [
            {
              t_start_ms: 0,
              t_end_ms: 1_000,
              text: "Hello",
              pos: { x: 0.5, y: 0.5 },
              size_pt: 32,
              color: { r: 255, g: 255, b: 255, a: 255 },
              box_style: null,
            },
          ],
        },
      ]),
      output({ resolution: "720p" }),
    );

    expect(plan).toMatchObject({
      kind: "composited",
      outputWidth: 1280,
      outputHeight: 720,
    });
    expect(ffmpegArgsForExportPlan(plan, "/tmp/out.mp4")).toContain("1280x720");
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

function must<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}
