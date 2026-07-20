import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRecordingBundleV2 } from "@storycapture/shared-types/recording-v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictRecordingMasterPipeline } from "./recording-master-pipeline";
import { createPassingCadenceObservation } from "./recording-verifier-faults";
import {
  createRecordingVerifierFixtureSample,
  RECORDING_FIXTURE_HEIGHT,
  RECORDING_FIXTURE_WIDTH,
} from "./recording-verifier-fixture";

vi.mock("./recording-bundle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./recording-bundle")>()),
  recordingStoragePreflight: vi.fn(async () => ({
    eligible: true,
    available_bytes: 10_000_000_000,
    required_bytes: 1,
    estimated_take_bytes: 1,
    reserve_bytes: 1,
  })),
  hasLiveRecordingReserve: vi.fn(async () => true),
}));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("StrictRecordingMasterPipeline", () => {
  it("commits a diagnostic bundle instead of publishing when verification fails", async () => {
    const exportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-master-pipeline-"));
    roots.push(exportsDir);
    const samples = Array.from({ length: 3 }, (_, index) =>
      createRecordingVerifierFixtureSample(index),
    );
    const dimensions = {
      logical_width: RECORDING_FIXTURE_WIDTH,
      logical_height: RECORDING_FIXTURE_HEIGHT,
      capture_dpr: 1,
      physical_width: RECORDING_FIXTURE_WIDTH,
      physical_height: RECORDING_FIXTURE_HEIGHT,
      requested_output_width: RECORDING_FIXTURE_WIDTH,
      requested_output_height: RECORDING_FIXTURE_HEIGHT,
    };
    const pipeline = await StrictRecordingMasterPipeline.create({
      exportsDir,
      name: "failed-take",
      width: RECORDING_FIXTURE_WIDTH,
      height: RECORDING_FIXTURE_HEIGHT,
      captureContract: { exact_fps: { numerator: 60, denominator: 1 }, dimensions },
      deliveryPolicy: "strict",
      certifiedTier: null,
    });
    await Promise.all(
      samples.map((sample) =>
        pipeline.submit({
          sourceSequence: sample.source_sequence,
          nativePtsUs: sample.monotonic_timestamp_us,
          pixels: sample.frame,
        }),
      ),
    );

    const result = await pipeline.finalize({
      cadenceEvidence: {
        ...createPassingCadenceObservation(samples.length),
        verdict: "passed",
        failure_codes: [],
      },
      qualityEvidence: {
        version: 2,
        evaluated_frames: 0,
        full_frame_luma_ssim: null,
        text_edge_roi_ssim: null,
        p01_edge_contrast_retention: null,
        edge_spread_increase_px: null,
        overlay_geometry_delta_px: null,
        color_channel_delta: null,
        lossless_master_hashes_match: false,
        verdict: "failed",
        failure_codes: ["artifact_hash_mismatch"],
      },
    });

    expect(result).toMatchObject({
      status: "quality_failed",
      output_path: null,
      diagnostic_bundle_path: result.bundle_path,
    });
    const manifest = readRecordingBundleV2(
      JSON.parse(await fs.readFile(path.join(result.bundle_path, "manifest.json"), "utf8")),
    );
    expect(manifest).toMatchObject({
      status: "quality_failed",
      failure_codes: expect.arrayContaining(["artifact_hash_mismatch"]),
    });
    expect(await fs.stat(path.join(result.bundle_path, "master/video.mkv"))).toBeTruthy();

    const passingPipeline = await StrictRecordingMasterPipeline.create({
      exportsDir,
      name: "passing-take",
      width: RECORDING_FIXTURE_WIDTH,
      height: RECORDING_FIXTURE_HEIGHT,
      captureContract: { exact_fps: { numerator: 60, denominator: 1 }, dimensions },
      deliveryPolicy: "strict",
      certifiedTier: null,
    });
    for (const sample of samples) {
      await passingPipeline.submit({
        sourceSequence: sample.source_sequence,
        nativePtsUs: sample.monotonic_timestamp_us,
        pixels: sample.frame,
      });
    }
    const passing = await passingPipeline.finalize({
      cadenceEvidence: {
        ...createPassingCadenceObservation(samples.length),
        verdict: "passed",
        failure_codes: [],
      },
    });
    expect(passing).toMatchObject({
      status: "completed",
      output_path: passing.proxy_path,
      diagnostic_bundle_path: null,
    });
  }, 60_000);
});
