import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function traceModule() {
  // @ts-expect-error The standalone Node helper intentionally has no TypeScript dependency.
  return import("../../scripts/spikes/recording-spike-trace.mjs");
}

async function makeBatch() {
  const batchDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "recording-spike-trace-"));
  roots.push(batchDirectory);
  return batchDirectory;
}

async function readEvents(tracePath: string) {
  return (await fs.readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

afterEach(async () => {
  delete process.env.STORYCAPTURE_RECORD_ENGINE_JSONL;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("recording native spike trace", () => {
  it("writes a correlated started/completed trace with relative artifacts", async () => {
    const batchDirectory = await makeBatch();
    const { createRecordingSpikeTrace } = await traceModule();
    const trace = createRecordingSpikeTrace({
      batchDirectory,
      batchId: "native-capture-batch-1",
      kind: "native-capture",
      matrix: ["baseline"],
      profiles: ["1080p30", "1440p30"],
      durationScale: 1,
    });

    await trace.started();
    await trace.completed({
      decision: "go: shared-surface",
      reportPath: path.join(batchDirectory, "native-capture-report.md"),
      durationMs: 250,
    });

    const events = await readEvents(trace.tracePath);
    expect(events.map((event) => event.event)).toEqual([
      "recording.backend.spike_started",
      "recording.backend.spike_completed",
    ]);
    expect(events.map((event) => event.process_sequence)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({
      request_id: "native-capture-batch-1",
      attempt_id: "native-capture-batch-1",
      backend_id: "macos_screencapturekit",
      reason_code: "spike_gate_passed",
      artifact_relpath: "raw.json",
      details: {
        decision: "go",
        report_relpath: "native-capture-report.md",
        report_external: false,
      },
    });
    expect(events[1]).not.toHaveProperty("session_id");
    expect(events[1]).not.toHaveProperty("session_sequence");
    expect(JSON.stringify(events)).not.toContain(batchDirectory);
  });

  it("writes allowlisted failure identity without raw errors or external paths", async () => {
    const batchDirectory = await makeBatch();
    const { createRecordingSpikeTrace } = await traceModule();
    const trace = createRecordingSpikeTrace({
      batchDirectory,
      batchId: "system-audio-batch-1",
      kind: "system-audio",
      matrix: ["permissions"],
      profiles: [],
      durationScale: 0.1,
    });
    const failure = Object.assign(new Error(`failed at ${batchDirectory}/private.swift`), {
      code: "EIO;PRIVATE",
    });

    await trace.started();
    await trace.failed({
      reasonCode: "spike_execution_failed",
      error: failure,
      durationMs: 10,
    });

    const events = await readEvents(trace.tracePath);
    expect(events[1]).toMatchObject({
      event: "recording.backend.spike_failed",
      reason_code: "spike_execution_failed",
      details: { error_name: "Error", error_code: "UNKNOWN" },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(batchDirectory);
    expect(serialized).not.toContain("private.swift");
    expect(serialized).not.toContain("EIO;PRIVATE");
  });

  it("keeps raw spike evidence enabled when structured tracing is disabled", async () => {
    process.env.STORYCAPTURE_RECORD_ENGINE_JSONL = "0";
    const batchDirectory = await makeBatch();
    const { createRecordingSpikeTrace } = await traceModule();
    const trace = createRecordingSpikeTrace({
      batchDirectory,
      batchId: "disabled-batch",
      kind: "native-capture",
      matrix: ["baseline"],
      profiles: ["1080p30"],
      durationScale: 1,
    });

    await expect(trace.started()).resolves.toBeNull();
    await expect(fs.stat(trace.tracePath)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(batchDirectory, "raw.json"), "{}\n");
    await expect(fs.stat(path.join(batchDirectory, "raw.json"))).resolves.toBeDefined();
  });
});
