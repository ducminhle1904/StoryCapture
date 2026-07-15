import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  getName: vi.fn(() => "StoryCapture"),
  getPath: vi.fn(),
  getVersion: vi.fn(() => "0.0.0-test"),
}));

vi.mock("electron", () => ({
  app: electronMock,
}));

import { appendDiagnosticLogLine } from "./log-store";
import { logsHandlers } from "./logs";
import { recordEngineLog } from "./recording-observability";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-logs-test-"));
  electronMock.getPath.mockImplementation((name: string) => {
    if (name !== "userData") throw new Error(`Unexpected app path: ${name}`);
    return tempDir;
  });
});

afterEach(async () => {
  electronMock.getPath.mockReset();
  await fs.rm(tempDir, { force: true, recursive: true });
});

describe("logs IPC handlers", () => {
  it("normalizes and persists log config", async () => {
    const customDir = path.join(tempDir, "custom-logs");

    await expect(
      logsHandlers.set_log_config({
        config: {
          log_dir: ` ${customDir} `,
          max_file_size_bytes: 12.5 * 1024 * 1024,
          max_files: 3.7,
        },
      }),
    ).resolves.toMatchObject({
      effective_log_dir: customDir,
      log_dir_override: customDir,
      max_file_size_bytes: 13107200,
      max_files: 4,
      min_file_size_bytes: 1048576,
      max_allowed_files: 50,
    });

    await expect(logsHandlers.get_log_config()).resolves.toMatchObject({
      effective_log_dir: customDir,
      max_files: 4,
    });
  });

  it("creates the effective log directory", async () => {
    await expect(logsHandlers.open_log_dir()).resolves.toBe(path.join(tempDir, "logs"));
    await expect(fs.stat(path.join(tempDir, "logs"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("writes frontend log lines", async () => {
    await logsHandlers.log_from_frontend({
      payload: {
        level: "warn",
        source: "renderer",
        message: "hello\nworld",
        fields: [["key", "value\nwith whitespace"]],
        url: "https://example.com/path",
      },
    });

    const entries = await fs.readdir(path.join(tempDir, "logs"));
    expect(entries).toHaveLength(1);
    await expect(fs.readFile(path.join(tempDir, "logs", entries[0]), "utf8")).resolves.toContain(
      'WARN storycapture::frontend source="renderer" hello world key="value with whitespace"',
    );
  });

  it("redacts sensitive frontend fields before writing text logs", async () => {
    await logsHandlers.log_from_frontend({
      payload: {
        message: "capture_token=top-secret",
        fields: [
          ["capture_token", "top-secret"],
          ["upload_path", "/Users/alice/private.csv"],
        ],
        url: "https://example.com/private?token=top-secret",
        stack: "at /Users/alice/project/file.ts:10:2",
      },
    });

    const [entry] = await fs.readdir(path.join(tempDir, "logs"));
    const contents = await fs.readFile(path.join(tempDir, "logs", entry), "utf8");
    expect(contents).toContain('capture_token="[REDACTED]"');
    expect(contents).toContain('upload_path="[REDACTED_PATH]"');
    expect(contents).toContain('url="https://example.com"');
    expect(contents).not.toContain("top-secret");
    expect(contents).not.toContain("/Users/alice");
  });

  it("rotates and retains structured logs using the configured limits", async () => {
    await logsHandlers.set_log_config({
      config: {
        max_file_size_bytes: 1024 * 1024,
        max_files: 2,
      },
    });
    const largeLine = `${"x".repeat(700 * 1024)}\n`;
    await appendDiagnosticLogLine("record-engine", largeLine);
    await appendDiagnosticLogLine("record-engine", largeLine);
    await appendDiagnosticLogLine("record-engine", largeLine);

    const entries = (await fs.readdir(path.join(tempDir, "logs"))).filter((entry) =>
      entry.endsWith(".jsonl"),
    );
    expect(entries).toHaveLength(2);
  });

  it("exports a diagnostic bundle with copied logs and manifest", async () => {
    await logsHandlers.log_from_frontend({
      payload: {
        message: "bundle me capture_token=diagnostic-canary-token",
        fields: [
          ["story_source", "diagnostic canary story text"],
          ["upload_path", "/Users/canary/private/upload.txt"],
          ["selector", "#diagnostic-canary-selector"],
        ],
      },
    });
    await recordEngineLog({
      event: "recording.upload.failed",
      context: { session_id: "diagnostic-session" },
      details: {
        repair_token: "diagnostic-canary-token",
        story_source: "diagnostic canary story text",
        upload_path: "/Users/canary/private/upload.txt",
        selector: "#diagnostic-canary-selector",
      },
    });
    const parentDir = path.join(tempDir, "diagnostics");

    const result = await logsHandlers.export_diagnostic_bundle({ parentDir });

    expect(result).toMatchObject({ path: expect.stringContaining(parentDir) });
    const logEntries = await fs.readdir(path.join(result.path, "logs"));
    expect(logEntries).toHaveLength(2);
    const exportedLogs = (
      await Promise.all(
        logEntries.map((entry) => fs.readFile(path.join(result.path, "logs", entry), "utf8")),
      )
    ).join("\n");
    const manifest = await fs.readFile(path.join(result.path, "manifest.json"), "utf8");
    expect(manifest).toContain('"recording_schema_version": 2');
    expect(manifest).toContain('"log_redaction_version": 1');
    expect(manifest).toContain('"redaction_scope": "write_time_known_fields"');
    expect(manifest).not.toContain(tempDir);
    expect(exportedLogs).not.toContain("diagnostic-canary-token");
    expect(exportedLogs).not.toContain("diagnostic canary story text");
    expect(exportedLogs).not.toContain("/Users/canary");
    expect(exportedLogs).not.toContain("#diagnostic-canary-selector");
  });
});
