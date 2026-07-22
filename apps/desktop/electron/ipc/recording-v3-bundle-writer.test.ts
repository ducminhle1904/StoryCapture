import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type RecordingCaptureContractV3,
  type RecordingCertifiedProfileV3,
  recordingV3DimensionsForViewport,
  readRecordingBundleV3,
  readRecordingDiagnosticFrameLedgerEntryV3,
} from "@storycapture/shared-types/recording-v3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RecordingV3BundleWriter,
  type RecordingV3BundleWriterOptions,
} from "./recording-v3-bundle-writer";
import type { RecordingV3EngineResult } from "./recording-v3-engine";

const temporaryRoots: string[] = [];
const sha = "a".repeat(64);

const captureContract: RecordingCaptureContractV3 = {
  version: 3,
  guarantee_boundary: "electron_offscreen_delivery",
  source_ordinal_kind: "electron_frame_count",
  target_class: "browser",
  exact_fps: { numerator: 60, denominator: 1 },
  dimensions: {
    logical_width: 960,
    logical_height: 540,
    capture_dpr: 2,
    physical_width: 1920,
    physical_height: 1080,
    requested_output_width: 1920,
    requested_output_height: 1080,
  },
  cursor_policy: "sidecar_reconstructed",
  audio_roles: [],
};

const profile: RecordingCertifiedProfileV3 = {
  version: 3,
  profile_id: "mac17-2-v3",
  stage: "certified",
  target_class: "browser",
  platform: "darwin",
  arch: "arm64",
  hardware_model: "Mac17,2",
  hardware_chip: "Apple M5",
  os_build: "25F84",
  backend_id: "electron_offscreen_shared_texture_v3",
  backend_version: "3.0.0",
  addon_protocol_version: 3,
  addon_sha256: sha,
  electron_version: "42.4.1",
  chromium_version: "148.0.7778.265",
  ffmpeg_version: "7.1",
  ffmpeg_sha256: sha,
  output_width: 1920,
  output_height: 1080,
  exact_fps: { numerator: 60, denominator: 1 },
  cursor_policy: "sidecar_reconstructed",
  audio_roles: [],
  evidence_artifact_sha256: sha,
  valid_from: "2026-07-21T00:00:00.000Z",
  valid_until: "2027-07-21T00:00:00.000Z",
  kill_switch_id: "recording-v3-mac17-2",
};

const engineResult: RecordingV3EngineResult = {
  activeDurationUs: 16_667,
  expectedSlots: 1,
  receipts: [
    {
      sourceEpoch: 0,
      activeSegment: 0,
      sourceFrameCount: 7,
      sourceTimestampUs: 12_000,
      activeTimePtsUs: 0,
      deliveryOrdinal: 0,
      nativeLeaseOrdinal: 0,
      nativeCommitOrdinal: 0,
      encodedOrdinal: 0,
      bgraSha256: sha,
      serviceTimeMs: 1,
    },
  ],
  stats: {
    handlesImported: 1,
    handlesReleased: 1,
    activeLeases: 0,
    peakActiveLeases: 1,
    deliveryFrames: 1,
    nativeLeasesAccepted: 1,
    nativeCommits: 1,
    encodedFrames: 1,
    leaseOverflows: 0,
    leaseAdmissionWaits: 0,
    leaseAdmissionWaitMaxMs: 0,
    backpressureEvents: 0,
    deadlineMisses: 0,
    sourceOrdinalGaps: 0,
    sourceTimestampRegressions: 0,
    maxQueueDepth: 1,
    maxReadyQueueDepth: 1,
    boundedPoolBytes: 1,
    serviceTimeP95Ms: 1,
    serviceTimeP99Ms: 1,
    serviceTimeMaxMs: 1,
    ffmpegExitCode: 0,
    failed: false,
    failureCode: "",
    failureReason: "",
  },
};

async function createWriter(
  verifyArtifact: NonNullable<RecordingV3BundleWriterOptions["verifyArtifact"]>,
  qualification: RecordingV3BundleWriterOptions["qualification"] = {
    mode: "certified",
    manifestId: "manifest-1",
    profile,
  },
  name = "take",
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v3-bundle-"));
  temporaryRoots.push(root);
  const dimensions =
    qualification.mode === "uncertified_development"
      ? recordingV3DimensionsForViewport("development", { width: 1280, height: 800 })
      : captureContract.dimensions;
  const writer = await RecordingV3BundleWriter.create({
    exportsDir: root,
    name,
    captureContract: { ...captureContract, dimensions },
    qualification,
    width: dimensions.requested_output_width,
    height: dimensions.requested_output_height,
    verifyArtifact,
  });
  await fs.writeFile(writer.masterPath, "lossless-master");
  return writer;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("RecordingV3BundleWriter", () => {
  it("atomically commits a completed V3 bundle with action and cursor sidecars", async () => {
    const writer = await createWriter(async ({ proxyPath }) => {
      await fs.writeFile(proxyPath, "proxy");
      return {
        ledger: [
          {
            version: 3,
            source_epoch: 0,
            active_segment: 0,
            source_frame_count: 7,
            source_timestamp_us: 12_000,
            active_time_pts_us: 0,
            delivery_ordinal: 1,
            native_lease_ordinal: 1,
            native_commit_ordinal: 1,
            encoded_ordinal: 1,
            decoded_ordinal: 1,
            bgra_sha256: sha,
          },
        ],
        cadenceEvidence: {
          version: 3,
          guarantee_boundary: "electron_offscreen_delivery",
          source_ordinal_kind: "electron_frame_count",
          requested_fps: { numerator: 60, denominator: 1 },
          source_fps: { numerator: 60, denominator: 1 },
          stream_time_base: { numerator: 1, denominator: 60 },
          active_duration_us: 16_667,
          expected_slots: 1,
          source_presentations: 1,
          delivery_frames: 1,
          native_commits: 1,
          encoded_frames: 1,
          artifact_decoded_frames: 1,
          source_ordinal_gaps: 0,
          source_timestamp_regressions: 0,
          delivery_duplicates: 0,
          native_lease_overflows: 0,
          native_backpressure_events: 0,
          native_deadline_misses: 0,
          artifact_pts_gaps: 0,
          artifact_pts_duplicates: 0,
          full_decode_succeeded: true,
          verdict: "passed",
          failure_codes: [],
        },
        runtimeQualityEvidence: {
          version: 3,
          measurement_scope: "runtime_integrity",
          reference_identity: null,
          evaluated_frames: 1,
          full_frame_luma_ssim: null,
          text_edge_roi_ssim: null,
          p01_edge_contrast_retention: null,
          edge_spread_increase_px: null,
          overlay_geometry_delta_px: null,
          color_channel_delta: null,
          lossless_master_hashes_match: true,
          certification_verdict: null,
          verdict: "passed",
          failure_codes: [],
        },
      };
    });
    const result = await writer.finalize({
      engineResult,
      actions: {
        version: 3,
        recording_path: "master/video.mkv",
        viewport: { width: 1920, height: 1080 },
        capture_rect: { x: 0, y: 0, width: 1920, height: 1080 },
        fps: 60,
        frame_count: 1,
        events: [
          {
            step_id: "step-1",
            ordinal: 1,
            verb: "click",
            t_start_ms: 0,
            t_action_ms: 1,
            t_end_ms: 2,
            target: null,
            secondary_target: null,
            pointer: null,
          },
        ],
      },
    });

    expect(result.status).toBe("completed");
    const manifest = await fs
      .readFile(path.join(result.bundle_path, "manifest.json"), "utf8")
      .then((text) => readRecordingBundleV3(JSON.parse(text)));
    expect(manifest?.sidecars).toEqual({
      actions_path: "sidecars/actions.json",
      cursor_path: "sidecars/cursor.json",
    });
    expect(await fs.readdir(path.dirname(result.bundle_path))).toEqual(["take.sc-recording"]);
  });

  it("commits artifact verification failures only as diagnostic quality-failed bundles", async () => {
    const writer = await createWriter(async () => {
      throw new Error("decoded hash mismatch");
    });
    const result = await writer.finalize({ engineResult, actions: null });

    expect(result.status).toBe("quality_failed");
    expect(result.output_path).toBeNull();
    expect(result.quality_evidence.failure_codes).toEqual(["artifact_verification_failed"]);
    const manifest = await fs
      .readFile(path.join(result.bundle_path, "manifest.json"), "utf8")
      .then((text) => readRecordingBundleV3(JSON.parse(text)));
    expect(manifest?.status).toBe("quality_failed");
    expect(manifest?.proxy).toBeNull();
    const diagnosticLedger = await fs
      .readFile(path.join(result.bundle_path, "evidence/frame-ledger.jsonl"), "utf8")
      .then((text) => readRecordingDiagnosticFrameLedgerEntryV3(JSON.parse(text.trim())));
    expect(diagnosticLedger?.decoded_ordinal).toBeNull();
  });

  it("preserves wide Development dimensions through verification and quality-failed retention", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v3-bundle-"));
    temporaryRoots.push(root);
    const dimensions = recordingV3DimensionsForViewport("development", {
      width: 1280,
      height: 800,
    });
    const verifyArtifact = vi.fn(async () => {
      throw new Error("development artifact mismatch");
    });
    const writer = await RecordingV3BundleWriter.create({
      exportsDir: root,
      name: "development",
      captureContract: { ...captureContract, dimensions },
      qualification: { mode: "uncertified_development" },
      width: 1280,
      height: 800,
      verifyArtifact,
    });
    await fs.writeFile(writer.masterPath, "lossless-master");
    const result = await writer.finalize({ engineResult, actions: null });

    expect(verifyArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1280, height: 800 }),
    );
    expect(result).toMatchObject({
      status: "quality_failed",
      delivery_policy: "development",
      recording_mode: "uncertified_development",
      certification_profile: null,
      output_width: 1280,
      output_height: 800,
    });
    const manifest = await fs
      .readFile(path.join(result.bundle_path, "manifest.json"), "utf8")
      .then((text) => readRecordingBundleV3(JSON.parse(text)));
    expect(manifest?.capture_contract.dimensions).toEqual(dimensions);
  });

  it("commits an uncertified development bundle without synthesizing a profile", async () => {
    const writer = await createWriter(
      async ({ proxyPath }) => {
        await fs.writeFile(proxyPath, "proxy");
        return {
          ledger: [
            {
              version: 3,
              source_epoch: 0,
              active_segment: 0,
              source_frame_count: 7,
              source_timestamp_us: 12_000,
              active_time_pts_us: 0,
              delivery_ordinal: 1,
              native_lease_ordinal: 1,
              native_commit_ordinal: 1,
              encoded_ordinal: 1,
              decoded_ordinal: 1,
              bgra_sha256: sha,
            },
          ],
          cadenceEvidence: {
            version: 3,
            guarantee_boundary: "electron_offscreen_delivery",
            source_ordinal_kind: "electron_frame_count",
            requested_fps: { numerator: 60, denominator: 1 },
            source_fps: { numerator: 60, denominator: 1 },
            stream_time_base: { numerator: 1, denominator: 60 },
            active_duration_us: 16_667,
            expected_slots: 1,
            source_presentations: 1,
            delivery_frames: 1,
            native_commits: 1,
            encoded_frames: 1,
            artifact_decoded_frames: 1,
            source_ordinal_gaps: 0,
            source_timestamp_regressions: 0,
            delivery_duplicates: 0,
            native_lease_overflows: 0,
            native_backpressure_events: 0,
            native_deadline_misses: 0,
            artifact_pts_gaps: 0,
            artifact_pts_duplicates: 0,
            full_decode_succeeded: true,
            verdict: "passed",
            failure_codes: [],
          },
          runtimeQualityEvidence: {
            version: 3,
            measurement_scope: "runtime_integrity",
            reference_identity: null,
            evaluated_frames: 1,
            full_frame_luma_ssim: null,
            text_edge_roi_ssim: null,
            p01_edge_contrast_retention: null,
            edge_spread_increase_px: null,
            overlay_geometry_delta_px: null,
            color_channel_delta: null,
            lossless_master_hashes_match: true,
            certification_verdict: null,
            verdict: "passed",
            failure_codes: [],
          },
        };
      },
      { mode: "uncertified_development" },
      "take-uncertified-dev",
    );
    const result = await writer.finalize({ engineResult, actions: null });

    expect(result).toMatchObject({
      status: "completed",
      delivery_policy: "development",
      recording_mode: "uncertified_development",
      certification_profile: null,
    });
    expect(path.basename(result.bundle_path)).toBe("take-uncertified-dev.sc-recording");
    const manifest = await fs
      .readFile(path.join(result.bundle_path, "manifest.json"), "utf8")
      .then((text) => readRecordingBundleV3(JSON.parse(text)));
    expect(manifest).toMatchObject({
      delivery_policy: "development",
      recording_mode: "uncertified_development",
      certification_profile: null,
    });
  });
});
