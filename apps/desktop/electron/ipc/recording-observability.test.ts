import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  getName: vi.fn(() => "StoryCapture"),
  getPath: vi.fn(),
  getVersion: vi.fn(() => "0.0.0-test"),
}));

vi.mock("electron", () => ({ app: electronMock }));

import { RecordingAudioTrackRegistry } from "./audio-tracks";
import { writeLogConfig } from "./log-store";
import { recordEngineLog, resetRecordingObservabilityForTest } from "./recording-observability";
import { RecordingRepairController } from "./recording-repair";
import { sessionId } from "./session";

let tempDir: string;
let logDir: string;

async function readStructuredEvents() {
  const entries = (await fs.readdir(logDir)).filter((entry) => entry.endsWith(".jsonl"));
  const contents = await Promise.all(
    entries.map((entry) => fs.readFile(path.join(logDir, entry), "utf8")),
  );
  return contents
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readApplicationLog(): Promise<string> {
  const entries = (await fs.readdir(logDir)).filter((entry) => entry.endsWith(".log"));
  return (await Promise.all(entries.map((entry) => fs.readFile(path.join(logDir, entry), "utf8"))))
    .join("");
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recording-log-test-"));
  logDir = path.join(tempDir, "logs");
  electronMock.getPath.mockImplementation((name: string) => {
    if (name !== "userData") throw new Error(`Unexpected app path: ${name}`);
    return tempDir;
  });
  delete process.env.STORYCAPTURE_RECORD_ENGINE_JSONL;
  resetRecordingObservabilityForTest();
  await writeLogConfig({ log_dir: logDir, max_files: 4 });
});

afterEach(async () => {
  electronMock.getPath.mockReset();
  delete process.env.STORYCAPTURE_RECORD_ENGINE_JSONL;
  await fs.rm(tempDir, { force: true, recursive: true });
});

describe("recordEngineLog", () => {
  it("keeps production record-engine paths off the application text sink", async () => {
    const producerFiles = [
      "electron/ipc/legacy/capture-preview.ts",
      "electron/ipc/legacy/recording.ts",
      "electron/ipc/legacy/story-runner.ts",
      "electron/ipc/recording-lifecycle.ts",
    ];
    const sources = await Promise.all(
      producerFiles.map((file) => fs.readFile(path.resolve(process.cwd(), file), "utf8")),
    );
    for (const source of sources) {
      expect(source).not.toMatch(/hostLog\([^\n]*["']recording[._]/);
    }

    const sharedSource = await fs.readFile(
      path.resolve(process.cwd(), "electron/ipc/legacy/shared.ts"),
      "utf8",
    );
    expect(sharedSource).not.toContain("recordEngineLog");
    expect(sharedSource).not.toContain("recording.legacy");
  });

  it("writes correlated events in emission order", async () => {
    await Promise.all(
      ["created", "ready", "terminal"].map((phase, index) =>
        recordEngineLog({
          event:
            index === 0
              ? "recording.session.created"
              : index === 2
                ? "recording.terminal"
                : "recording.readiness.completed",
          context: { session_id: "session-1", phase },
        }),
      ),
    );

    const events = await readStructuredEvents();
    expect(events.every((event) => event.schema_version === 2)).toBe(true);
    expect(events.map((event) => event.process_sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.session_sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.phase)).toEqual(["created", "ready", "terminal"]);
  });

  it("redacts secrets, content, paths, selectors, URLs, cycles, and error stacks", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await recordEngineLog({
      level: "error",
      event: "recording.upload.failed",
      context: {
        session_id: "session-privacy",
        artifact_relpath: "segments/scene-1.mp4",
      },
      details: {
        capture_token: "capture-secret",
        typed_text: "private story text",
        upload_path: "/Users/alice/private/customer.csv",
        selector: "#customer-secret",
        url: "https://example.com/private?token=secret",
        cyclic,
      },
      error: new Error("failed at /Users/alice/project/file.ts capture_token=secret-value"),
    });

    const [event] = await readStructuredEvents();
    const serialized = JSON.stringify(event);
    expect(event.artifact_relpath).toBe("segments/scene-1.mp4");
    expect(event.details.capture_token).toBe("[REDACTED]");
    expect(event.details.typed_text).toBe("[REDACTED]");
    expect(event.details.upload_path).toBe("[REDACTED_PATH]");
    expect(event.details.selector).toMatch(/^\[REDACTED_SELECTOR:[a-f0-9]{12}\]$/);
    expect(event.details.url).toBe("https://example.com");
    expect(event.details.cyclic.self).toBe("[CIRCULAR]");
    expect(serialized).not.toContain("capture-secret");
    expect(serialized).not.toContain("private story text");
    expect(serialized).not.toContain("customer.csv");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("/Users/alice");
  });

  it("omits invalid artifact paths and absent correlation fields", async () => {
    await recordEngineLog({
      event: "recording.bundle.failed",
      context: {
        session_id: "session-safe-path",
        artifact_relpath: "../private/take.mp4",
      },
    });

    const [event] = await readStructuredEvents();
    expect(event).not.toHaveProperty("artifact_relpath");
    expect(event).not.toHaveProperty("request_id");
    expect(event).not.toHaveProperty("take_id");
  });

  it("disables only structured logging through the kill switch", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.STORYCAPTURE_RECORD_ENGINE_JSONL = "0";
    await expect(
      recordEngineLog({
        event: "recording.session.created",
        context: { session_id: "disabled" },
      }),
    ).resolves.toBeNull();
    await expect(
      fs.readdir(logDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }),
    ).resolves.toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("records repair expiry and required audio failure without capture tokens", async () => {
    const repair = new RecordingRepairController("session-boundary", { ttlMs: 60_000 });
    repair.begin({
      session_id: "session-boundary",
      scene_id: "scene-1",
      step_id: "step-1",
      ordinal: 1,
      phase: "pre_input",
      reason_code: "target_missing",
      candidates: [],
      scene_retry_available: false,
    });
    repair.expireForTest();

    const tracks = new RecordingAudioTrackRegistry();
    const identity = {
      session_id: "session-boundary",
      track_id: "track-1",
      role: "microphone" as const,
      source_id: "device-1",
      capture_token: "capture-token-canary",
    };
    tracks.register({
      sessionId: identity.session_id,
      targetKind: "author_preview",
      originMonotonicEpochMs: 1_000,
      requests: [
        {
          track_id: identity.track_id,
          role: identity.role,
          requirement: "required",
          source_id: identity.source_id,
          capture_token: identity.capture_token,
        },
      ],
    });
    tracks.fail(identity, { sequence: 0, reason: "audio_zero_samples" });
    await recordEngineLog({
      event: "recording.health.sampled",
      context: { session_id: identity.session_id },
      details: { flush: true },
    });

    const events = await readStructuredEvents();
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "recording.repair.required",
        "recording.repair.expired",
        "recording.audio.track_state_changed",
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(identity.capture_token);
  });

  it("reports one sanitized fallback per write-failure episode and records recovery", async () => {
    await fs.mkdir(logDir, { recursive: true });
    const blockedStructuredLog = path.join(
      logDir,
      `storycapture-record-engine-${sessionId}.jsonl`,
    );
    await fs.mkdir(blockedStructuredLog);

    await expect(
      recordEngineLog({
        event: "recording.terminal",
        context: { session_id: "session-io-failure", verdict: "failed" },
      }),
    ).resolves.toBeNull();
    await expect(
      recordEngineLog({
        event: "recording.terminal",
        context: { session_id: "session-io-failure", verdict: "failed" },
      }),
    ).resolves.toBeNull();

    await fs.rm(blockedStructuredLog, { recursive: true });
    await expect(
      recordEngineLog({
        event: "recording.session.created",
        context: { session_id: "session-recovered" },
      }),
    ).resolves.toMatchObject({ event: "recording.session.created" });

    const textLog = await readApplicationLog();
    expect(textLog.match(/recording\.observability\.write_failed/g)).toHaveLength(1);
    expect(textLog).toContain("recording.observability.write_recovered");
    expect(textLog).toContain('suppressed_count="1"');
    expect(textLog).not.toContain(blockedStructuredLog);
  });

  it("falls back to a fixed stderr line when both local log streams are unwritable", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const blocked = path.join(tempDir, "blocked-file");
    await fs.writeFile(blocked, "not a directory");
    await writeLogConfig({ log_dir: blocked });
    await expect(
      recordEngineLog({
        event: "recording.terminal",
        context: { session_id: "session-io-failure", verdict: "failed" },
      }),
    ).resolves.toBeNull();
    expect(stderr).toHaveBeenCalledTimes(1);
    const fallback = String(stderr.mock.calls[0]?.[0]);
    expect(fallback).toContain("recording.observability.write_failed");
    expect(fallback).toContain("fallback=text_log_failed");
    expect(fallback).not.toContain(blocked);
    stderr.mockRestore();
  });
});
