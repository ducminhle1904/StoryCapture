import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RecordingBundleV2 } from "@storycapture/shared-types/recording-v2";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupExpiredFailedRecordingBundles,
  FAILED_RECORDING_RETENTION_MS,
} from "./recording-failed-bundle-retention";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function manifest(status: RecordingBundleV2["status"], createdAt: string): RecordingBundleV2 {
  const artifact = { bytes: 1, sha256: "a".repeat(64) };
  return {
    schema_version: 2,
    status,
    created_at: createdAt,
    delivery_policy: "strict",
    certified_tier: null,
    capture_contract: {
      exact_fps: { numerator: 60, denominator: 1 },
      dimensions: {
        logical_width: 1920,
        logical_height: 1080,
        capture_dpr: 1,
        physical_width: 1920,
        physical_height: 1080,
        requested_output_width: 1920,
        requested_output_height: 1080,
      },
    },
    master: {
      ...artifact,
      relative_path: "master/video.mkv",
      codec: "ffv1",
      pixel_format: "bgra",
      frame_count: 1,
      exact_fps: { numerator: 60, denominator: 1 },
    },
    proxy: null,
    audio: [],
    evidence: {
      cadence_path: "evidence/cadence.json",
      quality_path: "evidence/quality.json",
    },
    sidecars: { actions_path: null },
    sequence_ledger_path: "evidence/sequence-ledger.jsonl",
    failure_codes: status === "quality_failed" ? ["artifact_hash_mismatch"] : [],
  };
}

async function createBundle(root: string, name: string, value: RecordingBundleV2): Promise<string> {
  const bundlePath = path.join(root, `${name}.sc-recording`);
  await fs.mkdir(bundlePath);
  await fs.writeFile(path.join(bundlePath, "manifest.json"), JSON.stringify(value));
  return bundlePath;
}

describe("failed recording bundle retention", () => {
  it("removes only failed bundles older than seven days", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-failed-retention-"));
    roots.push(root);
    const now = Date.parse("2026-07-19T00:00:00.000Z");
    const expired = await createBundle(
      root,
      "expired",
      manifest("quality_failed", new Date(now - FAILED_RECORDING_RETENTION_MS - 1).toISOString()),
    );
    const recent = await createBundle(
      root,
      "recent",
      manifest("quality_failed", new Date(now - FAILED_RECORDING_RETENTION_MS + 1).toISOString()),
    );
    const completed = await createBundle(
      root,
      "completed",
      manifest("completed", new Date(now - FAILED_RECORDING_RETENTION_MS - 1).toISOString()),
    );
    await fs.mkdir(path.join(root, "unrelated"));

    await expect(cleanupExpiredFailedRecordingBundles(root, now)).resolves.toEqual([expired]);
    await expect(fs.stat(expired)).rejects.toThrow();
    await expect(fs.stat(recent)).resolves.toBeDefined();
    await expect(fs.stat(completed)).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, "unrelated"))).resolves.toBeDefined();
  });

  it("preserves malformed bundles fail-closed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-failed-retention-"));
    roots.push(root);
    const bundle = path.join(root, "malformed.sc-recording");
    await fs.mkdir(bundle);
    await fs.writeFile(path.join(bundle, "manifest.json"), "{not-json");

    await expect(cleanupExpiredFailedRecordingBundles(root)).resolves.toEqual([]);
    await expect(fs.stat(bundle)).resolves.toBeDefined();
  });
});
