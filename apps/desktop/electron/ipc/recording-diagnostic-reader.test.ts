import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = path.resolve(process.cwd(), "scripts/recording-diagnostics.mjs");
let tempDir: string;
let input: string;

function event(sequence: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    redaction_version: 1,
    emitted_at: new Date(1_700_000_000_000 + sequence * 10).toISOString(),
    level: "info",
    event: name,
    process_sequence: sequence,
    session_id: "session-reader",
    session_sequence: sequence,
    ...overrides,
  };
}

function processEvent(sequence: number, name: string, overrides: Record<string, unknown> = {}) {
  const { session_id: _sessionId, session_sequence: _sessionSequence, ...item } = event(
    sequence,
    name,
    overrides,
  );
  return item;
}

async function writeEvents(events: unknown[]) {
  await fs.writeFile(input, `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

async function writeEventsTo(file: string, events: unknown[]) {
  await fs.writeFile(file, `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

function run(session = "session-reader") {
  return spawnSync(process.execPath, [script, "--input", input, "--session", session, "--json"], {
    encoding: "utf8",
  });
}

function runProcess(processInput = input) {
  return spawnSync(process.execPath, [script, "--input", processInput, "--process", "--json"], {
    encoding: "utf8",
  });
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recording-reader-test-"));
  input = path.join(tempDir, "recording.jsonl");
});

afterEach(async () => {
  await fs.rm(tempDir, { force: true, recursive: true });
});

describe("recording diagnostics reader", () => {
  it("reconstructs a coherent golden recording", async () => {
    await writeEvents([
      event(1, "recording.session.created", { phase: "starting" }),
      event(2, "recording.lifecycle.transition", {
        phase: "recording",
        details: { from_state: "starting", to_state: "recording" },
      }),
      event(3, "recording.drag.started", { scene_id: "scene-1", step_id: "step-1" }),
      event(4, "recording.drag.completed", { scene_id: "scene-1", step_id: "step-1" }),
      event(5, "recording.bundle.committed", {
        take_id: "take-1",
        artifact_relpath: "manifest.json",
      }),
      event(6, "recording.terminal", {
        take_id: "take-1",
        verdict: "passed",
        reason_code: "passed",
      }),
    ]);

    const result = run();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      status: "coherent",
      session_id: "session-reader",
      take_id: "take-1",
      issues: [],
    });
    expect(report.artifacts).toEqual([
      { event: "recording.bundle.committed", path: "manifest.json", take_id: "take-1" },
    ]);
    expect(report.phase_durations).toEqual([
      expect.objectContaining({ phase: "drag", result: "completed", duration_ms: 10 }),
    ]);
  });

  it("reports duplicate sequences, take mismatch, unclosed phases, and events after terminal", async () => {
    await writeEvents([
      event(1, "recording.session.created"),
      event(2, "recording.upload.started", { step_id: "step-1", take_id: "take-1" }),
      event(2, "recording.terminal", { take_id: "take-2", verdict: "failed" }),
      event(4, "recording.health.sampled"),
    ]);

    const result = run();
    expect(result.status).toBe(1);
    const codes = JSON.parse(result.stdout).issues.map((issue: { code: string }) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "duplicate_sequence",
        "out_of_order_sequence",
        "sequence_gap",
        "take_mismatch",
        "unclosed_phase",
        "event_after_terminal",
      ]),
    );
  });

  it("uses exit code 2 when the requested session is absent", async () => {
    await writeEvents([event(1, "recording.session.created")]);
    const result = run("missing-session");
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).issues).toContainEqual(
      expect.objectContaining({ code: "session_not_found" }),
    );
  });

  it("uses exit code 2 for malformed or unsupported event input", async () => {
    await writeEvents([
      event(1, "recording.session.created"),
      { ...event(2, "recording.terminal"), schema_version: 2 },
    ]);
    const result = run();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).issues).toContainEqual(
      expect.objectContaining({ code: "invalid_schema" }),
    );
  });

  it("validates process sequences independently for each JSONL file", async () => {
    const first = path.join(tempDir, "process-a.jsonl");
    const second = path.join(tempDir, "process-b.jsonl");
    await writeEventsTo(first, [processEvent(1, "recording.discovery.completed")]);
    await writeEventsTo(second, [
      processEvent(1, "recording.backend.spike_started", { attempt_id: "batch-1" }),
      processEvent(2, "recording.backend.spike_completed", { attempt_id: "batch-1" }),
    ]);

    const result = runProcess(tempDir);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ status: "coherent", mode: "process", issues: [] });
    expect(report.files).toEqual([
      expect.objectContaining({ file: "process-a.jsonl", event_count: 1, status: "coherent" }),
      expect.objectContaining({ file: "process-b.jsonl", event_count: 2, status: "coherent" }),
    ]);
  });

  it("reports duplicate, reversed, and interrupted process traces", async () => {
    await writeEvents([
      processEvent(2, "recording.backend.spike_started", { attempt_id: "batch-open" }),
      processEvent(2, "recording.discovery.completed"),
      processEvent(1, "recording.discovery.failed"),
    ]);

    const result = runProcess();
    expect(result.status).toBe(1);
    const codes = JSON.parse(result.stdout).issues.map((issue: { code: string }) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "duplicate_process_sequence",
        "out_of_order_process_sequence",
        "unclosed_phase",
      ]),
    );
  });

  it("uses exit code 2 when process and session selectors are both present", async () => {
    await writeEvents([processEvent(1, "recording.discovery.completed")]);
    const result = spawnSync(
      process.execPath,
      [script, "--input", input, "--session", "session-reader", "--process", "--json"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--session <session-id> | --process");
  });

  it("accepts the argument separator forwarded by the pnpm package command", async () => {
    await writeEvents([processEvent(1, "recording.discovery.completed")]);
    const result = spawnSync(
      process.execPath,
      [script, "--", "--input", input, "--process", "--json"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "coherent", mode: "process" });
  });
});
