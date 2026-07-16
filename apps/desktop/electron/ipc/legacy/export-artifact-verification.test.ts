import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildArtifactLoudnessAnalysisArgs,
  validateExportArtifactProbe,
  validateExportLoudness,
  verifyExportArtifact,
} from "./export-artifact-verification";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const expected = {
  format: "mp4" as const,
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 2_000,
  expectAudio: true,
};

describe("export artifact verification", () => {
  it("accepts exact dimensions, FPS, duration, and stream shape", () => {
    expect(
      validateExportArtifactProbe(
        {
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              profile: "High",
              pix_fmt: "yuv420p",
              color_range: "tv",
              color_space: "bt709",
              color_transfer: "bt709",
              color_primaries: "bt709",
              width: 1920,
              height: 1080,
              avg_frame_rate: "30/1",
              r_frame_rate: "30/1",
              bit_rate: "8000000",
            },
            {
              codec_type: "audio",
              codec_name: "aac",
              profile: "LC",
              sample_rate: "48000",
              channels: 2,
              channel_layout: "stereo",
              bit_rate: "192000",
            },
          ],
          format: { duration: "2.033" },
        },
        expected,
        1_024,
      ),
    ).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      audioStreams: 1,
      videoCodec: "h264",
      videoProfile: "High",
      pixelFormat: "yuv420p",
      colorRange: "tv",
      frameRateMode: "cfr",
      videoBitrateKbps: 8_000,
      audioCodec: "aac",
      audioProfile: "LC",
      audioSampleRateHz: 48_000,
      audioChannels: 2,
      audioChannelLayout: "stereo",
      audioBitrateKbps: 192,
      fullDecodePassed: false,
      faststart: null,
      loudness: null,
    });
  });

  it.each([
    ["codec_name", "hevc", /video codec/i],
    ["profile", "Main", /H\.264 profile/i],
    ["pix_fmt", "yuv444p", /pixel format/i],
    ["color_range", "pc", /color range/i],
    ["color_space", "bt601", /color matrix/i],
    ["color_transfer", "unknown", /color transfer/i],
    ["color_primaries", "unknown", /color primaries/i],
    ["r_frame_rate", "60/1", /constant frame rate/i],
  ] as const)("rejects MP4 video contract drift in %s", (field, value, message) => {
    const video = {
      codec_type: "video",
      codec_name: "h264",
      profile: "High",
      pix_fmt: "yuv420p",
      color_range: "tv",
      color_space: "bt709",
      color_transfer: "bt709",
      color_primaries: "bt709",
      width: 1920,
      height: 1080,
      avg_frame_rate: "30/1",
      r_frame_rate: "30/1",
      [field]: value,
    };
    expect(() =>
      validateExportArtifactProbe(
        {
          streams: [
            video,
            {
              codec_type: "audio",
              codec_name: "aac",
              profile: "LC",
              sample_rate: "48000",
              channels: 2,
              channel_layout: "stereo",
            },
          ],
          format: { duration: "2.0" },
        },
        expected,
        1_024,
      ),
    ).toThrow(message);
  });

  it("rejects MP4 audio contract drift", () => {
    expect(() =>
      validateExportArtifactProbe(
        {
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              profile: "High",
              pix_fmt: "yuv420p",
              color_range: "tv",
              color_space: "bt709",
              color_transfer: "bt709",
              color_primaries: "bt709",
              width: 1920,
              height: 1080,
              avg_frame_rate: "30/1",
              r_frame_rate: "30/1",
            },
            {
              codec_type: "audio",
              codec_name: "aac",
              profile: "LC",
              sample_rate: "44100",
              channels: 1,
              channel_layout: "mono",
            },
          ],
          format: { duration: "2.0" },
        },
        expected,
        1_024,
      ),
    ).toThrow(/sample rate/i);
  });

  it("builds and validates artifact loudness analysis", () => {
    expect(buildArtifactLoudnessAnalysisArgs("/tmp/final.mp4")).toContain(
      "loudnorm=I=-14:TP=-1:LRA=11:print_format=json",
    );
    expect(
      validateExportLoudness({
        integratedLufs: -14.4,
        truePeakDbtp: -1,
        loudnessRangeLu: 3,
        thresholdLufs: -24,
        targetOffsetLu: 0,
      }),
    ).toMatchObject({ integratedLufs: -14.4, truePeakDbtp: -1 });
    expect(() =>
      validateExportLoudness({
        integratedLufs: -14.6,
        truePeakDbtp: -1,
        loudnessRangeLu: 3,
        thresholdLufs: -24,
        targetOffsetLu: 0,
      }),
    ).toThrow(/integrated loudness/i);
    expect(() =>
      validateExportLoudness({
        integratedLufs: -14,
        truePeakDbtp: -0.99,
        loudnessRangeLu: 3,
        thresholdLufs: -24,
        targetOffsetLu: 0,
      }),
    ).toThrow(/true peak/i);
  });

  it("rejects wrong media metadata and missing audio", () => {
    expect(() =>
      validateExportArtifactProbe(
        {
          streams: [{ codec_type: "video", width: 1280, height: 720, avg_frame_rate: "24/1" }],
          format: { duration: "1.0" },
        },
        expected,
        10,
      ),
    ).toThrow(/dimensions/i);
    expect(() =>
      validateExportArtifactProbe(
        {
          streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1" }],
          format: { duration: "2.0" },
        },
        expected,
        10,
      ),
    ).toThrow(/missing.*audio/i);
  });

  it("accepts GIF centisecond frame-delay quantization but rejects material drift", () => {
    const gifExpected = { ...expected, format: "gif" as const, expectAudio: false };
    expect(
      validateExportArtifactProbe(
        {
          streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "179/6" }],
          format: { duration: "2.0" },
        },
        gifExpected,
        1_024,
      ),
    ).toMatchObject({ fps: 179 / 6, audioStreams: 0 });
    expect(() =>
      validateExportArtifactProbe(
        {
          streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "28/1" }],
          format: { duration: "2.0" },
        },
        gifExpected,
        1_024,
      ),
    ).toThrow(/FPS/);
  });

  it.skipIf(!ffmpegPath)(
    "fully decodes and verifies a real faststart MP4 media contract",
    async () => {
      if (!ffmpegPath) throw new Error("ffmpeg-static binary is unavailable");
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-verify-mp4-"));
      tempDirs.push(directory);
      const outputPath = path.join(directory, "delivery.mp4");
      await execFileAsync(
        ffmpegPath,
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x180:rate=30:duration=2",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=1000:sample_rate=48000:duration=2",
          "-af",
          "loudnorm=I=-14:TP=-1:LRA=11",
          "-c:v",
          "libx264",
          "-profile:v",
          "high",
          "-pix_fmt",
          "yuv420p",
          "-fps_mode",
          "cfr",
          "-g",
          "60",
          "-color_range",
          "tv",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-colorspace",
          "bt709",
          "-c:a",
          "aac",
          "-profile:a",
          "aac_low",
          "-b:a",
          "192k",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-movflags",
          "+faststart",
          "-t",
          "2",
          outputPath,
        ],
        { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
      );

      await expect(
        verifyExportArtifact(outputPath, {
          format: "mp4",
          width: 320,
          height: 180,
          fps: 30,
          durationMs: 2_000,
          expectAudio: true,
        }),
      ).resolves.toMatchObject({
        videoCodec: "h264",
        videoProfile: "High",
        pixelFormat: "yuv420p",
        colorRange: "tv",
        frameRateMode: "cfr",
        audioCodec: "aac",
        audioProfile: "LC",
        audioSampleRateHz: 48_000,
        audioChannels: 2,
        audioChannelLayout: "stereo",
        faststart: true,
        fullDecodePassed: true,
      });
    },
    30_000,
  );
});
