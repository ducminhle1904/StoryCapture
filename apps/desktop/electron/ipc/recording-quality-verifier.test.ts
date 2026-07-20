import { describe, expect, it } from "vitest";
import {
  exactLosslessMasterQualityEvidence,
  RECORDING_STRICT_QUALITY_THRESHOLDS,
  verifyRecordingQuality,
} from "./recording-quality-verifier";
import { injectDownscaleUpscaleBlur, injectOrdinalFault } from "./recording-verifier-faults";
import {
  createRecordingVerifierFixtureSample,
  decodeFixtureOrdinal,
  recordingVerifierFixtureManifest,
} from "./recording-verifier-fixture";

describe("deterministic recording verifier fixture", () => {
  it("contains the required 1080p60 screen-content regions and per-frame ordinal", () => {
    const manifest = recordingVerifierFixtureManifest("motion");
    const sample = createRecordingVerifierFixtureSample(42, "motion");

    expect(manifest).toMatchObject({
      width: 1920,
      height: 1080,
      fps: { numerator: 60, denominator: 1 },
      default_frame_count: 300,
      text_sizes_px: [12, 16, 24, 42],
      ordinal_bits: 24,
    });
    expect(manifest.text_edge_rois).toHaveLength(4);
    expect(manifest.one_pixel_edge_roi.width).toBeGreaterThan(0);
    expect(manifest.checkerboard_roi.width).toBeGreaterThan(0);
    expect(manifest.chroma_samples).toHaveLength(6);
    expect(sample.source_sequence).toBe(43);
    expect(decodeFixtureOrdinal(sample.frame)).toBe(42);
  });

  it("advances the static source sequence while keeping pixels identical", () => {
    const first = createRecordingVerifierFixtureSample(0, "static");
    const later = createRecordingVerifierFixtureSample(17, "static");

    expect(later.source_sequence).toBe(18);
    expect(later.monotonic_timestamp_us).toBeGreaterThan(first.monotonic_timestamp_us);
    expect(later.frame.equals(first.frame)).toBe(true);
    expect(recordingVerifierFixtureManifest("static").ordinal_roi).toBeNull();
  });
});

describe("recording screen-content quality verifier", () => {
  it("derives perfect metrics only from a non-empty exact master hash verification", () => {
    expect(exactLosslessMasterQualityEvidence(3, true)).toMatchObject({
      evaluated_frames: 3,
      full_frame_luma_ssim: { measured: 1, passed: true },
      lossless_master_hashes_match: true,
      verdict: "passed",
      failure_codes: [],
    });
    expect(exactLosslessMasterQualityEvidence(0, true)).toMatchObject({
      evaluated_frames: 0,
      verdict: "failed",
      failure_codes: ["contract_mismatch"],
    });
  });

  it("passes every exact fixture frame at the software thresholds", () => {
    const frames = [0, 1].map((frameIndex) => {
      const reference = createRecordingVerifierFixtureSample(frameIndex).frame;
      return { reference, actual: Buffer.from(reference), expected_ordinal: frameIndex };
    });
    const evidence = verifyRecordingQuality({
      profile: "software",
      manifest: recordingVerifierFixtureManifest(),
      frames,
      lossless_master_hashes_match: true,
    });

    expect(evidence.verdict).toBe("passed");
    expect(evidence.evaluated_frames).toBe(2);
    expect(evidence.failure_codes).toEqual([]);
    expect(evidence.full_frame_luma_ssim?.measured).toBeCloseTo(1, 10);
    expect(evidence.text_edge_roi_ssim?.measured).toBeCloseTo(1, 10);
    expect(evidence.p01_edge_contrast_retention?.measured).toBeCloseTo(1, 10);
    expect(evidence.edge_spread_increase_px?.measured).toBe(0);
    expect(RECORDING_STRICT_QUALITY_THRESHOLDS.hardware.full_frame_luma_ssim).toBe(0.985);
  }, 30_000);

  it("rejects a deliberately downscaled and upscaled frame as blurred", () => {
    const reference = createRecordingVerifierFixtureSample(0).frame;
    const actual = injectDownscaleUpscaleBlur(reference, 1920, 1080, 4);
    const evidence = verifyRecordingQuality({
      profile: "software",
      manifest: recordingVerifierFixtureManifest(),
      frames: [{ reference, actual, expected_ordinal: 0 }],
    });

    expect(evidence.verdict).toBe("failed");
    expect(evidence.failure_codes).toEqual(
      expect.arrayContaining([
        "visual_full_frame_ssim",
        "visual_text_edge_ssim",
        "visual_edge_contrast",
        "visual_edge_spread",
      ]),
    );
  }, 30_000);

  it("rejects an intentionally corrupted per-frame ordinal", () => {
    const reference = createRecordingVerifierFixtureSample(7).frame;
    const actual = injectOrdinalFault(reference, 1920, 1080);
    const evidence = verifyRecordingQuality({
      profile: "software",
      manifest: recordingVerifierFixtureManifest(),
      frames: [{ reference, actual, expected_ordinal: 7 }],
    });

    expect(evidence.verdict).toBe("failed");
    expect(evidence.failure_codes).toContain("artifact_hash_mismatch");
  }, 30_000);

  it("rejects overlay geometry and chroma deltas beyond their strict limits", () => {
    const manifest = recordingVerifierFixtureManifest();
    const reference = createRecordingVerifierFixtureSample(0).frame;
    const actual = Buffer.from(reference);
    const overlay = manifest.overlay_roi;
    for (let y = overlay.y; y < overlay.y + overlay.height; y += 1) {
      for (let x = overlay.x; x < overlay.x + overlay.width + 2; x += 1) {
        const offset = (y * manifest.width + x) * 4;
        actual.set([36, 28, 24, 255], offset);
      }
    }
    for (let y = overlay.y; y < overlay.y + overlay.height; y += 1) {
      for (let x = overlay.x + 2; x < overlay.x + overlay.width + 2; x += 1) {
        const offset = (y * manifest.width + x) * 4;
        actual.set([192, 32, 255, 255], offset);
      }
    }
    const chroma = manifest.chroma_samples[0];
    const chromaOffset = (chroma.y * manifest.width + chroma.x) * 4;
    actual[chromaOffset] = 30;

    const evidence = verifyRecordingQuality({
      profile: "software",
      manifest,
      frames: [{ reference, actual, expected_ordinal: 0 }],
    });

    expect(evidence.overlay_geometry_delta_px?.measured).toBe(2);
    expect(evidence.color_channel_delta?.measured).toBe(30);
    expect(evidence.failure_codes).toEqual(
      expect.arrayContaining(["visual_overlay_geometry", "visual_color_delta"]),
    );
  }, 30_000);
});
