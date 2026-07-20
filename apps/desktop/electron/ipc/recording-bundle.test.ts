import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type RecordingBundleV2,
  STRICT_RECORDING_FRAME_RATE,
} from "@storycapture/shared-types/recording-v2";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPartialRecordingBundles,
  estimateFfv1Storage,
  RecordingBundleWorkspace,
  RecordingSequenceLedger,
} from "./recording-bundle";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-bundle-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("recording bundle", () => {
  it("stages and atomically publishes a V2 directory", async () => {
    const root = await tempDir();
    const workspace = await RecordingBundleWorkspace.create(root, "take");
    await fs.writeFile(workspace.resolve("master/video.mkv"), "master");
    await fs.writeFile(workspace.resolve("proxy/video.mp4"), "proxy");
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
        bytes: 6,
        sha256: "a".repeat(64),
        codec: "ffv1",
        pixel_format: "bgra",
        frame_count: 1,
        exact_fps: STRICT_RECORDING_FRAME_RATE,
      },
      proxy: {
        relative_path: "proxy/video.mp4",
        bytes: 5,
        sha256: "b".repeat(64),
        codec: "h264",
      },
      audio: [],
      evidence: {
        cadence_path: "evidence/cadence.json",
        quality_path: "evidence/quality.json",
      },
      sidecars: { actions_path: null },
      sequence_ledger_path: "evidence/sequence-ledger.jsonl",
      failure_codes: [],
    } satisfies RecordingBundleV2;
    const finalPath = await workspace.commit(manifest);
    expect(finalPath).toBe(path.join(root, "take.sc-recording"));
    expect(JSON.parse(await fs.readFile(path.join(finalPath, "manifest.json"), "utf8"))).toEqual(
      manifest,
    );
    await expect(fs.stat(workspace.stagingPath)).rejects.toThrow();
  });

  it("cleans only aged orphan staging directories and preserves active workspaces", async () => {
    const root = await tempDir();
    const workspace = await RecordingBundleWorkspace.create(root, "take");
    const orphanPath = path.join(root, ".storycapture-recording-staging-orphan");
    await fs.mkdir(orphanPath);
    await fs.mkdir(path.join(root, "keep"));
    expect(await cleanupPartialRecordingBundles(root, { minAgeMs: 0, nowMs: Date.now() + 1 })).toBe(
      1,
    );
    await expect(fs.stat(workspace.stagingPath)).resolves.toBeTruthy();
    await expect(fs.stat(orphanPath)).rejects.toThrow();
    await expect(fs.stat(path.join(root, "keep"))).resolves.toBeTruthy();
    await workspace.discard();
  });

  it("estimates bounded FFV1 storage and writes a contiguous ledger", async () => {
    expect(
      estimateFfv1Storage({ width: 1920, height: 1080, fps: 60, durationSeconds: 1 }).totalBytes,
    ).toBeGreaterThan(0);
    const root = await tempDir();
    const ledger = new RecordingSequenceLedger();
    ledger.append({ frame_index: 0, source_sequence: 1, native_pts_us: 0, sha256: "a" });
    ledger.append({ frame_index: 1, source_sequence: 2, native_pts_us: 16_667, sha256: "b" });
    const file = path.join(root, "ledger.jsonl");
    await ledger.writeJsonLines(file);
    expect((await fs.readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(() =>
      ledger.append({ frame_index: 3, source_sequence: 3, native_pts_us: 33_333, sha256: "c" }),
    ).toThrow(/index/);
  });
});
