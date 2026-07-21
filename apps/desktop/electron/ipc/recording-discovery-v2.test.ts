import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type RecordingBundleV2,
  type RecordingBundleV3,
  STRICT_RECORDING_FRAME_RATE,
} from "@storycapture/shared-types/recording-v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverProjectRecordings } from "./recording-discovery";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("recording bundle discovery", () => {
  it("resolves master, proxy, evidence, actions, and audio while keeping failed bundles unpublished", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-v2-"));
    roots.push(root);
    const bundle = path.join(root, "take.sc-recording");
    await Promise.all(
      ["master", "proxy", "audio", "evidence", "sidecars"].map((directory) =>
        fs.mkdir(path.join(bundle, directory), { recursive: true }),
      ),
    );
    const manifest = {
      schema_version: 2,
      status: "completed",
      created_at: new Date(0).toISOString(),
      delivery_policy: "strict",
      certified_tier: null,
      capture_contract: {
        exact_fps: STRICT_RECORDING_FRAME_RATE,
        dimensions: {
          logical_width: 960,
          logical_height: 540,
          capture_dpr: 2,
          physical_width: 1920,
          physical_height: 1080,
          requested_output_width: 1920,
          requested_output_height: 1080,
        },
      },
      master: {
        relative_path: "master/video.mkv",
        bytes: 100,
        sha256: "a".repeat(64),
        codec: "ffv1",
        pixel_format: "bgra",
        frame_count: 300,
        exact_fps: STRICT_RECORDING_FRAME_RATE,
      },
      proxy: {
        relative_path: "proxy/video.mp4",
        bytes: 50,
        sha256: "b".repeat(64),
        codec: "h264",
      },
      audio: [
        {
          relative_path: "audio/microphone.wav",
          bytes: 10,
          sha256: "c".repeat(64),
          role: "microphone",
          codec: "pcm_s16le",
        },
      ],
      evidence: {
        cadence_path: "evidence/cadence.json",
        quality_path: "evidence/quality.json",
      },
      sidecars: { actions_path: "sidecars/actions.json" },
      sequence_ledger_path: "evidence/sequence-ledger.jsonl",
      failure_codes: [],
    } satisfies RecordingBundleV2;
    await fs.writeFile(path.join(bundle, "manifest.json"), JSON.stringify(manifest));
    const probe = vi.fn();
    const recordings = await discoverProjectRecordings(root, probe);
    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({
      version: 2,
      path: path.join(bundle, "proxy/video.mp4"),
      master_path: path.join(bundle, "master/video.mkv"),
      actions_path: path.join(bundle, "sidecars/actions.json"),
      microphone_audio_path: path.join(bundle, "audio/microphone.wav"),
      source_frame_count: 300,
      quality_verdict: "passed",
      validation: { status: "valid" },
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("resolves V3 evidence and sidecars without inventing audio or a V2 tier", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-v3-"));
    roots.push(root);
    const bundle = path.join(root, "take.sc-recording");
    await fs.mkdir(bundle, { recursive: true });
    const hash = "a".repeat(64);
    const manifest = {
      schema_version: 3,
      status: "completed",
      created_at: new Date(0).toISOString(),
      delivery_policy: "strict",
      certification_profile: {
        manifest_id: "manifest-2026-07",
        profile_id: "mac17-2-m5-browser-1080p60",
        evidence_artifact_sha256: hash,
      },
      capture_contract: {
        version: 3,
        guarantee_boundary: "electron_offscreen_delivery",
        source_ordinal_kind: "electron_frame_count",
        target_class: "browser",
        exact_fps: STRICT_RECORDING_FRAME_RATE,
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
      },
      master: {
        relative_path: "master/video.mkv",
        bytes: 100,
        sha256: hash,
        codec: "ffv1",
        pixel_format: "bgra",
        frame_count: 600,
        exact_fps: STRICT_RECORDING_FRAME_RATE,
      },
      proxy: {
        relative_path: "proxy/video.mp4",
        bytes: 50,
        sha256: "b".repeat(64),
        codec: "h264",
      },
      audio: [],
      evidence: {
        cadence_path: "evidence/cadence.json",
        runtime_quality_path: "evidence/runtime-quality.json",
        certification_quality_path: "evidence/certification-quality.json",
      },
      sidecars: {
        actions_path: "sidecars/actions.json",
        cursor_path: "sidecars/cursor.json",
      },
      frame_ledger_path: "evidence/frame-ledger.jsonl",
      diagnostics_manifest_path: "diagnostics/manifest.json",
      failure_codes: [],
    } satisfies RecordingBundleV3;
    await fs.writeFile(path.join(bundle, "manifest.json"), JSON.stringify(manifest));

    const probe = vi.fn();
    const recordings = await discoverProjectRecordings(root, probe);

    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({
      version: 3,
      path: path.join(bundle, "proxy/video.mp4"),
      master_path: path.join(bundle, "master/video.mkv"),
      cadence_evidence_path: path.join(bundle, "evidence/cadence.json"),
      quality_evidence_path: path.join(bundle, "evidence/runtime-quality.json"),
      frame_ledger_path: path.join(bundle, "evidence/frame-ledger.jsonl"),
      actions_path: path.join(bundle, "sidecars/actions.json"),
      cursor_path: path.join(bundle, "sidecars/cursor.json"),
      microphone_audio_path: null,
      system_audio_path: null,
      certified_tier: null,
      certification_profile: manifest.certification_profile,
      guarantee_boundary: "electron_offscreen_delivery",
      source_scope_verified: true,
      source_frame_count: 600,
      quality_verdict: "passed",
      validation: { status: "valid" },
    });
    expect(probe).not.toHaveBeenCalled();

    const failedManifest: RecordingBundleV3 = {
      ...manifest,
      status: "quality_failed",
      proxy: null,
      failure_codes: ["artifact_verification_failed"],
    };
    await fs.writeFile(path.join(bundle, "manifest.json"), JSON.stringify(failedManifest));
    await expect(discoverProjectRecordings(root, probe)).resolves.toEqual([]);
  });
});
