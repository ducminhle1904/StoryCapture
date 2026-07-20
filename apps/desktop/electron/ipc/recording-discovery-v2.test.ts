import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type RecordingBundleV2,
  STRICT_RECORDING_FRAME_RATE,
} from "@storycapture/shared-types/recording-v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverProjectRecordings } from "./recording-discovery";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("V2 recording discovery", () => {
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
});
