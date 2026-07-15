import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RecordingOutcomeV1 } from "@storycapture/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import {
  RecordingBundleCommitError,
  RecordingBundleWriter,
  readRecordingBundleManifest,
  recordingBundleMode,
  validateRecordingBundleRoot,
} from "./recording-bundle";

const roots: string[] = [];
const validProbe = async () => ({
  status: "valid" as const,
  duration_ms: 1000,
  width: 1280,
  height: 720,
  codec: "h264",
  container: "mov,mp4",
});

function outcome(sessionId: string): RecordingOutcomeV1 {
  return {
    version: 1,
    session_id: sessionId,
    verdict: "passed",
    reason_code: "passed",
    warnings: [],
    automation: {
      exit_reason: "completed",
      total_steps: 1,
      succeeded: 1,
      failed: 0,
      failed_ordinal: null,
    },
    capture: {
      output_path: "/final/video.mp4",
      frames_written: 30,
      frames_dropped: 0,
      cadence_warning: null,
      finalized: true,
    },
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-bundle-test-"));
  roots.push(root);
  const writer = await RecordingBundleWriter.allocate("session-1", root, { probe: validProbe });
  await fs.writeFile(writer.allocation.stagingVideoPath, "video");
  await fs.writeFile(writer.allocation.actionsPath, "{}\n");
  await fs.writeFile(writer.allocation.healthPath, "{}\n");
  return { root, writer };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("RecordingBundleWriter", () => {
  it("publishes the canonical tree with manifest last and a final-only output path", async () => {
    const { writer } = await fixture();
    const result = await writer.commit({
      outcome: outcome("session-1"),
      capture: {
        target_kind: "author_preview",
        width: 1280,
        height: 720,
        output_width: 1280,
        output_height: 720,
        requested_fps: 30,
        observed_fps: 30,
      },
    });
    expect(result.outputPath).toBe(writer.allocation.finalVideoPath);
    await expect(fs.stat(writer.allocation.stagingRoot)).rejects.toThrow();
    if (!result.outputPath) throw new Error("committed bundle did not return an output path");
    expect((await fs.stat(result.outputPath)).isFile()).toBe(true);
    expect(await readRecordingBundleManifest(writer.allocation.finalRoot)).toMatchObject({
      version: 1,
      take_id: writer.allocation.takeId,
      verdict: "passed",
    });
  });

  it("retains staging when a required artifact is missing", async () => {
    const { writer } = await fixture();
    await fs.rm(writer.allocation.actionsPath);
    await expect(
      writer.commit({
        outcome: outcome("session-1"),
        capture: {
          target_kind: "display",
          width: 1,
          height: 1,
          output_width: 1,
          output_height: 1,
          requested_fps: 30,
          observed_fps: 30,
        },
      }),
    ).rejects.toBeInstanceOf(RecordingBundleCommitError);
    expect((await fs.stat(writer.allocation.stagingRoot)).isDirectory()).toBe(true);
  });

  it("rejects traversal and detects post-manifest artifact changes", async () => {
    const { writer } = await fixture();
    expect(() => writer.registerArtifact("diagnostic", "../escape", false)).toThrow(
      RecordingBundleCommitError,
    );
    writer.registerArtifact("diagnostic", "diagnostic.txt", true);
    await fs.writeFile(path.join(writer.allocation.stagingRoot, "diagnostic.txt"), "before");
    const committed = await writer.commit({
      outcome: outcome("session-1"),
      capture: {
        target_kind: "display",
        width: 1,
        height: 1,
        output_width: 1,
        output_height: 1,
        requested_fps: 30,
        observed_fps: 30,
      },
    });
    await fs.writeFile(path.join(writer.allocation.finalRoot, "diagnostic.txt"), "after");
    await expect(
      validateRecordingBundleRoot(writer.allocation.finalRoot, validProbe),
    ).rejects.toThrow(/size mismatch|hash mismatch/);
    expect(committed.manifest.artifacts.some((item) => item.kind === "diagnostic")).toBe(true);
  });

  it("keeps unsupported rollout values off", () => {
    expect(recordingBundleMode("off")).toBe("off");
    expect(recordingBundleMode("shadow")).toBe("shadow");
    expect(recordingBundleMode("required")).toBe("required");
    expect(recordingBundleMode("other")).toBe("off");
  });
});
