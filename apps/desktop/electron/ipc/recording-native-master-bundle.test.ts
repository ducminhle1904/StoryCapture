import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RecordingQualityEvidenceV3 } from "@storycapture/shared-types/recording-v3";
import { afterEach, describe, expect, it } from "vitest";

import { RecordingBundleWorkspace } from "./recording-bundle";
import {
  finalizeRecordingNativeMaster,
  type RecordingNativeMasterEvidence,
} from "./recording-native-master-bundle";

const roots: string[] = [];
const dimensions = {
  logical_width: 960,
  logical_height: 540,
  capture_dpr: 2,
  physical_width: 1_920,
  physical_height: 1_080,
  requested_output_width: 1_920,
  requested_output_height: 1_080,
};
const quality: RecordingQualityEvidenceV3 = {
  version: 3,
  evaluated_frames: 3,
  full_frame_luma_ssim: { measured: 0.99, threshold: 0.985, comparator: "gte", passed: true },
  text_edge_roi_ssim: { measured: 0.98, threshold: 0.975, comparator: "gte", passed: true },
  p01_edge_contrast_retention: { measured: 0.9, threshold: 0.85, comparator: "gte", passed: true },
  edge_spread_increase_px: { measured: 1, threshold: 1, comparator: "lte", passed: true },
  overlay_geometry_delta_px: { measured: 1, threshold: 1, comparator: "lte", passed: true },
  color_channel_delta: { measured: 20, threshold: 24, comparator: "lte", passed: true },
  lossless_master_hashes: "not_applicable",
  verdict: "passed",
  failure_codes: [],
};

function evidence(artifactPath: string): RecordingNativeMasterEvidence {
  return {
    artifact_path: artifactPath,
    artifact_bytes: 6,
    source_updates: 1,
    output_frames: 300,
    held_frames: 299,
    encoder_dropped_frames: 0,
    backpressure_events: 0,
    unresolved_backpressure_events: 0,
    width: 1_920,
    height: 1_080,
    started_monotonic_us: 1_000,
    ended_monotonic_us: 5_001_000,
    finalized_duration_us: 5_000_000,
    pts_gaps: 0,
    pts_duplicates: 0,
    pts_non_monotonic: 0,
    encoder: { id: "hardware-h264", hardware_accelerated: true },
    codec: "h264",
    pixel_format: "yuv420p",
    finalized: true,
    artifact: { finalized: true, full_decode_succeeded: true, decoded_frames: 300 },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("native Recording V3 bundle finalization", () => {
  it("publishes a directly playable H.264 master with held-frame evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-native-bundle-"));
    roots.push(root);
    const workspace = await RecordingBundleWorkspace.create(root, "take");
    const artifactPath = workspace.resolve("master/video.mp4");
    await fs.writeFile(artifactPath, "master");

    const result = await finalizeRecordingNativeMaster({
      workspace,
      evidence: evidence(artifactPath),
      dimensions,
      backend: { id: "native", version: "3" },
      quality,
    });

    expect(result).toMatchObject({
      version: 3,
      status: "completed",
      output_path: result.master_path,
      proxy_path: null,
      cadence_evidence: { source_updates: 1, output_frames: 300, held_frames: 299 },
    });
  });

  it("retains a failed bundle when full decode evidence disagrees", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-native-bundle-"));
    roots.push(root);
    const workspace = await RecordingBundleWorkspace.create(root, "failed");
    const artifactPath = workspace.resolve("master/video.mp4");
    await fs.writeFile(artifactPath, "master");

    const result = await finalizeRecordingNativeMaster({
      workspace,
      evidence: {
        ...evidence(artifactPath),
        artifact: { finalized: true, full_decode_succeeded: false, decoded_frames: 299 },
      },
      dimensions,
      backend: { id: "native", version: "3" },
      quality,
    });

    expect(result).toMatchObject({
      status: "quality_failed",
      output_path: null,
      diagnostic_bundle_path: result.bundle_path,
      cadence_evidence: { verdict: "passed" },
    });
  });
});
