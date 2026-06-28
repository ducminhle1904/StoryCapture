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

import { logsHandlers } from "./logs";

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
    await expect(logsHandlers.open_log_dir()).resolves.toBe(
      path.join(tempDir, "logs"),
    );
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
    await expect(
      fs.readFile(path.join(tempDir, "logs", entries[0]), "utf8"),
    ).resolves.toContain(
      'WARN storycapture::frontend source="renderer" hello world key="value with whitespace"',
    );
  });

  it("exports a diagnostic bundle with copied logs and manifest", async () => {
    await logsHandlers.log_from_frontend({ payload: { message: "bundle me" } });
    const parentDir = path.join(tempDir, "diagnostics");

    const result = await logsHandlers.export_diagnostic_bundle({ parentDir });

    expect(result).toMatchObject({ path: expect.stringContaining(parentDir) });
    await expect(
      fs.readdir(path.join(result.path, "logs")),
    ).resolves.toHaveLength(1);
    await expect(
      fs.readFile(path.join(result.path, "manifest.json"), "utf8"),
    ).resolves.toContain('"version": "0.0.0-test"');
  });
});
