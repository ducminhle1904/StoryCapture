import { describe, expect, it } from "vitest";

import { validateExportArtifactProbe } from "./export-artifact-verification";

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
            { codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1" },
            { codec_type: "audio" },
          ],
          format: { duration: "2.033" },
        },
        expected,
        1_024,
      ),
    ).toMatchObject({ width: 1920, height: 1080, fps: 30, audioStreams: 1 });
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
});
