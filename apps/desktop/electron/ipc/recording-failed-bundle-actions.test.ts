import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RecordingBundleV2 } from "@storycapture/shared-types/recording-v2";
import { afterEach, describe, expect, it } from "vitest";
import { deleteFailedRecordingBundle } from "./recording-failed-bundle-actions";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function failedManifest(): RecordingBundleV2 {
  return {
    schema_version: 2,
    status: "quality_failed",
    created_at: new Date().toISOString(),
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
      relative_path: "master/video.mkv",
      bytes: 1,
      sha256: "a".repeat(64),
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
    failure_codes: ["artifact_hash_mismatch"],
  };
}

async function fixture(): Promise<{ project: string; bundle: string }> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-delete-failed-"));
  roots.push(project);
  const exportsDir = path.join(project, "exports");
  const bundle = path.join(exportsDir, "failed.sc-recording");
  await fs.mkdir(bundle, { recursive: true });
  await fs.writeFile(path.join(bundle, "manifest.json"), JSON.stringify(failedManifest()));
  return { project, bundle };
}

describe("deleteFailedRecordingBundle", () => {
  it("deletes a validated failed bundle inside project exports", async () => {
    const { project, bundle } = await fixture();
    await deleteFailedRecordingBundle(project, bundle);
    await expect(fs.stat(bundle)).rejects.toThrow();
  });

  it("rejects paths outside project exports and completed bundles", async () => {
    const { project, bundle } = await fixture();
    const outside = path.join(project, "outside.sc-recording");
    await fs.mkdir(outside);
    await expect(deleteFailedRecordingBundle(project, outside)).rejects.toThrow(/outside/);

    const completed = failedManifest();
    completed.status = "completed";
    await fs.writeFile(path.join(bundle, "manifest.json"), JSON.stringify(completed));
    await expect(deleteFailedRecordingBundle(project, bundle)).rejects.toThrow(/quality-failed/);
    await expect(fs.stat(bundle)).resolves.toBeDefined();
  });
});
