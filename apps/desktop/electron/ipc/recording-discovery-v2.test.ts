import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RecordingV4Bundle } from "@storycapture/shared-types/recording-v4";
import { afterEach, describe, expect, it } from "vitest";

import { discoverProjectRecordings } from "./recording-discovery";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function completedManifest(): RecordingV4Bundle {
  const encoder = {
    encoder_id: "hardware-h264",
    hardware_accelerated: true as const,
    requested_bitrate_bps: 20_000_000,
    average_bitrate_bps: 20_000_000,
    peak_bitrate_bps: 22_000_000,
    envelope: {
      source: "live_calibration" as const,
      encoder_id: "hardware-h264",
      minimum_bitrate_bps: 16_000_000,
      target_bitrate_bps: 20_000_000,
      maximum_bitrate_bps: 25_000_000,
      safety_headroom_ratio: 0.2,
    },
  };
  const passGte = { measured: 1, threshold: 0.9, comparator: "gte" as const, passed: true };
  const passLte = { measured: 0, threshold: 1, comparator: "lte" as const, passed: true };
  return {
    schema_version: 4,
    profile: "verified_1080p60",
    status: "completed",
    session_id: "session-1",
    created_at: new Date(0).toISOString(),
    target: { kind: "author_preview", stable_id: "preview", process_id: 42, initial_title: "Preview" },
    dimensions: { physical_width: 1920, physical_height: 1080 },
    master: {
      relative_path: "master/video.mp4", bytes: 100, sha256: "a".repeat(64), codec: "h264",
      pixel_format: "yuv420p", frame_rate: { numerator: 60, denominator: 1 }, frame_count: 1,
      encoder,
    },
    audio: [{
      relative_path: "audio/microphone.m4a", bytes: 10, sha256: "b".repeat(64), role: "microphone",
      evidence: {
        role: "microphone", requested: true, status: "captured", codec: "aac",
        sample_rate_hz: 48_000, channels: 1, started_offset_us: 0, duration_us: 16_667,
        end_drift_us: 0, sync_tolerance_us: 20_000, pause_mapping_valid: true,
        continuity_gaps: 0, ledger: [{ sequence: 0, pts_us: 0, duration_us: 16_667, frames: 800 }],
        failure_codes: [],
      },
    }],
    cadence: {
      version: 4, frame_rate: { numerator: 60, denominator: 1 }, active_duration_us: 16_667,
      expected_output_frames: 1, output_frames: 1, source_updates: 1, held_frames: 0,
      submitted_frames: 1, acknowledged_frames: 1, ring_high_water_mark: 1, pause_intervals: [],
      ledger: [{ slot: 0, pts_us: 0, source_sequence: 0, source_timestamp_us: 0,
        held_from_slot: null, submitted_at_us: 1, acknowledged_at_us: 2 }],
      verdict: "passed", failure_codes: [],
    },
    quality: {
      checkpoints: [{ frame_slot: 0, reference_id: "initial-surface",
        full_frame_luma_ssim: passGte, text_edge_roi_ssim: passGte,
        edge_spread_increase_px: passLte, color_channel_delta: passLte }],
      verdict: "passed", failure_codes: [],
    },
    artifact: { finalized: true, full_decode_succeeded: true, decoded_frames: 1, duration_us: 16_667 },
    evidence: {
      cadence_path: "evidence/cadence.json", quality_path: "evidence/quality.json",
      bitrate_path: "evidence/bitrate.json", frame_ledger_path: "evidence/frame-ledger.jsonl",
      audio_ledger_path: "evidence/audio-ledger.jsonl",
    },
    sidecars: { actions_path: "sidecars/actions.json" },
    failure_codes: [],
  };
}

describe("Recording V4 discovery", () => {
  it("registers completed V4 master, evidence, actions, and native audio", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-v4-"));
    roots.push(root);
    const bundle = path.join(root, "take.sc-recording");
    await fs.mkdir(bundle, { recursive: true });
    await fs.writeFile(path.join(bundle, "manifest.json"), JSON.stringify(completedManifest()));

    await expect(discoverProjectRecordings(root)).resolves.toEqual([
      expect.objectContaining({
        version: 4,
        path: path.join(bundle, "master/video.mp4"),
        master_path: path.join(bundle, "master/video.mp4"),
        proxy_path: null,
        microphone_audio_path: path.join(bundle, "audio/microphone.m4a"),
        actions_path: path.join(bundle, "sidecars/actions.json"),
        source_frame_count: 1,
        quality_verdict: "passed",
        validation: { status: "valid" },
      }),
    ]);
  });

  it("ignores loose MP4 files and non-completed bundles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-v4-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "legacy.mp4"), "legacy");
    const bundle = path.join(root, "failed.sc-recording");
    await fs.mkdir(bundle, { recursive: true });
    await fs.writeFile(path.join(bundle, "manifest.json"), JSON.stringify({
      ...completedManifest(), status: "quality_failed", failure_codes: ["quality_checkpoint_failed"],
      quality: { ...completedManifest().quality, verdict: "failed", failure_codes: ["quality_checkpoint_failed"] },
    }));

    await expect(discoverProjectRecordings(root)).resolves.toEqual([]);
  });
});
