import { describe, expect, it } from "vitest";

import {
  cadenceWarning,
  recordingPngSequenceInputArgs,
  recordingQualityArgs,
  recordingRawVideoInputArgs,
  recordingVideoFilters,
  resolveRecordingOutput,
} from "./recording-pipeline";

describe("recording pipeline helpers", () => {
  it("defaults missing output resolution to match source", () => {
    expect(resolveRecordingOutput(1366, 768)).toMatchObject({
      outputWidth: 1366,
      outputHeight: 768,
    });
  });

  it("honors match-source and custom output resolutions", () => {
    expect(
      resolveRecordingOutput(1440, 900, {
        outputResolution: { kind: "match-source" },
      }),
    ).toMatchObject({ outputWidth: 1440, outputHeight: 900 });

    expect(
      resolveRecordingOutput(1440, 900, {
        outputResolution: { kind: "custom", w: 1600, h: 1000 },
      }),
    ).toMatchObject({ outputWidth: 1600, outputHeight: 1000 });
  });

  it("builds raw-video stdin args for the streaming author preview path", () => {
    expect(
      recordingRawVideoInputArgs({ width: 1920, height: 1080, fps: 60 }),
    ).toEqual([
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
  });

  it("uses the declared media FPS for PNG sequences", () => {
    expect(recordingPngSequenceInputArgs(60)).toEqual(["-framerate", "60"]);
  });

  it("builds letterbox filters with pad color and scale algorithm", () => {
    expect(
      recordingVideoFilters({
        sourceWidth: 1280,
        sourceHeight: 800,
        outputWidth: 1920,
        outputHeight: 1080,
        fitMode: "letterbox",
        padColor: { kind: "custom", r: 12, g: 34, b: 56 },
        scaleAlgo: "area",
      }),
    ).toEqual([
      "scale=1920:1080:force_original_aspect_ratio=decrease:flags=area",
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0c2238",
      "format=yuv420p",
    ]);
  });

  it("builds fill-crop and stretch filters", () => {
    expect(
      recordingVideoFilters({
        sourceWidth: 1280,
        sourceHeight: 800,
        outputWidth: 1920,
        outputHeight: 1080,
        fitMode: "fill-crop",
        padColor: { kind: "black" },
        scaleAlgo: "lanczos",
      }),
    ).toEqual([
      "scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos",
      "crop=1920:1080",
      "format=yuv420p",
    ]);

    expect(
      recordingVideoFilters({
        sourceWidth: 1280,
        sourceHeight: 800,
        outputWidth: 1920,
        outputHeight: 1080,
        fitMode: "stretch",
        padColor: { kind: "black" },
        scaleAlgo: "bilinear",
      }),
    ).toEqual(["scale=1920:1080:flags=bilinear", "format=yuv420p"]);
  });

  it("maps quality presets to explicit x264 settings", () => {
    expect(recordingQualityArgs("high")).toEqual([
      "-preset",
      "veryfast",
      "-crf",
      "18",
    ]);
    expect(recordingQualityArgs("lossless")).toEqual([
      "-preset",
      "veryfast",
      "-crf",
      "0",
    ]);
  });

  it("reports low capture cadence without failing healthy cadence", () => {
    expect(cadenceWarning({ actualFps: 14.25, requestedFps: 60 })).toEqual({
      code: "actual_capture_fps_below_requested",
      message: "Captured 14.25 fps; requested 60.00 fps.",
    });
    expect(cadenceWarning({ actualFps: 55, requestedFps: 60 })).toBeNull();
  });
});
