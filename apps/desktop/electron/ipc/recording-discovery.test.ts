import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RecordingOutcomeV1 } from "@storycapture/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordEngineLogMock = vi.hoisted(() =>
  vi.fn(async (_input: { event: string; [key: string]: unknown }) => null),
);

vi.mock("./recording-observability", () => ({ recordEngineLog: recordEngineLogMock }));

import { RecordingBundleWriter } from "./recording-bundle";
import { discoverProjectRecordings } from "./recording-discovery";

const roots: string[] = [];
const validProbe = async () => ({
  status: "valid" as const,
  duration_ms: 1000,
  width: 1280,
  height: 720,
  codec: "h264",
  container: "mov,mp4",
});

function passedOutcome(sessionId: string, outputPath: string): RecordingOutcomeV1 {
  return {
    version: 1,
    session_id: sessionId,
    verdict: "passed",
    reason_code: "passed",
    warnings: [],
    automation: {
      exit_reason: "completed",
      total_steps: 0,
      succeeded: 0,
      failed: 0,
      failed_ordinal: null,
    },
    capture: {
      output_path: outputPath,
      frames_written: 1,
      frames_dropped: 0,
      cadence_warning: null,
      finalized: true,
    },
  };
}

function discoveryEvents() {
  return recordEngineLogMock.mock.calls
    .map(([input]) => input)
    .filter((input) => String(input?.event).startsWith("recording.discovery."));
}

beforeEach(() => {
  recordEngineLogMock.mockClear();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("discoverProjectRecordings", () => {
  it("lists committed bundles before compatible flat recordings and ignores staging", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-"));
    roots.push(project);
    const exportsDir = path.join(project, "exports");
    await fs.mkdir(exportsDir, { recursive: true });
    const legacy = path.join(exportsDir, "legacy.mp4");
    await fs.writeFile(legacy, "legacy");
    await fs.utimes(legacy, new Date(0), new Date(0));

    const writer = await RecordingBundleWriter.allocate("session-1", project, {
      probe: validProbe,
    });
    await fs.writeFile(writer.allocation.stagingVideoPath, "video");
    await fs.writeFile(writer.allocation.actionsPath, "{}\n");
    await fs.writeFile(writer.allocation.healthPath, "{}\n");
    await writer.commit({
      outcome: passedOutcome("session-1", writer.allocation.finalVideoPath),
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
    const interrupted = path.join(exportsDir, "takes", ".interrupted.staging.1");
    await fs.mkdir(interrupted, { recursive: true });

    const recordings = await discoverProjectRecordings(exportsDir, validProbe);
    expect(recordings.map((recording) => recording.path)).toEqual([
      writer.allocation.finalVideoPath,
      legacy,
    ]);
    expect(recordings[0]?.validation.status).toBe("valid");
    expect(discoveryEvents()).toEqual([
      expect.objectContaining({
        event: "recording.discovery.completed",
        details: expect.objectContaining({
          bundle_candidates: 1,
          bundle_accepted: 1,
          legacy_candidates: 1,
          legacy_accepted: 1,
          returned_count: 2,
          latest_validation_status: "valid",
        }),
      }),
    ]);
    expect(JSON.stringify(discoveryEvents())).not.toContain(project);
    expect(JSON.stringify(discoveryEvents())).not.toContain("legacy.mp4");
  });

  it("ignores final directories without a supported manifest", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-"));
    roots.push(project);
    const exportsDir = path.join(project, "exports");
    const invalid = path.join(exportsDir, "takes", "invalid");
    await fs.mkdir(path.join(invalid, "media"), { recursive: true });
    await fs.writeFile(path.join(invalid, "media", "video.mp4"), "video");
    await fs.writeFile(path.join(invalid, "manifest.json"), '{"version":2}\n');
    expect(await discoverProjectRecordings(exportsDir, validProbe)).toEqual([]);
    expect(discoveryEvents()[0]).toMatchObject({
      event: "recording.discovery.completed",
      details: { bundle_candidates: 1, bundle_accepted: 0, returned_count: 0 },
    });
  });

  it("keeps retained non-passed bundles out of normal recording discovery", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-"));
    roots.push(project);
    const writer = await RecordingBundleWriter.allocate("session-repair", project, {
      probe: validProbe,
    });
    await fs.writeFile(writer.allocation.stagingVideoPath, "video");
    await fs.writeFile(writer.allocation.actionsPath, "{}\n");
    await fs.writeFile(writer.allocation.healthPath, "{}\n");
    await writer.commit({
      outcome: {
        ...passedOutcome("session-repair", writer.allocation.finalVideoPath),
        verdict: "repairable",
        reason_code: "automation_failed",
      },
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

    expect(await discoverProjectRecordings(path.join(project, "exports"), validProbe)).toEqual([]);
  });

  it("treats a missing exports directory as a completed empty discovery", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-"));
    roots.push(project);

    await expect(discoverProjectRecordings(path.join(project, "missing"), validProbe)).resolves.toEqual(
      [],
    );
    expect(discoveryEvents()).toEqual([
      expect.objectContaining({
        event: "recording.discovery.completed",
        context: expect.objectContaining({ reason_code: "exports_missing" }),
        details: expect.objectContaining({ returned_count: 0, exports_present: false }),
      }),
    ]);
  });

  it("logs a failed summary and preserves a thrown probe failure", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-"));
    roots.push(project);
    const exportsDir = path.join(project, "exports");
    await fs.mkdir(exportsDir, { recursive: true });
    await fs.writeFile(path.join(exportsDir, "latest.mp4"), "video");

    await expect(
      discoverProjectRecordings(exportsDir, async () => {
        throw Object.assign(new Error(`probe failed at ${project}`), { code: "EIO" });
      }),
    ).rejects.toThrow("probe failed");
    expect(discoveryEvents()[0]).toMatchObject({
      event: "recording.discovery.failed",
      context: expect.objectContaining({ reason_code: "probe_failed" }),
      details: expect.objectContaining({ error_code: "EIO", returned_count: 1 }),
    });
    expect(JSON.stringify(discoveryEvents())).not.toContain(project);
  });
});
