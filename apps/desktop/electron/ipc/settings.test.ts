import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  getPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: electronMock,
}));

import { settingsHandlers } from "./settings";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "storycapture-settings-test-"),
  );
  electronMock.getPath.mockImplementation((name: string) => {
    if (name !== "userData") throw new Error(`Unexpected app path: ${name}`);
    return tempDir;
  });
});

afterEach(async () => {
  electronMock.getPath.mockReset();
  await fs.rm(tempDir, { force: true, recursive: true });
});

async function readStoredSettings() {
  return JSON.parse(
    await fs.readFile(path.join(tempDir, "app_settings.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("settings IPC handlers", () => {
  it("returns default settings when no settings file exists", async () => {
    await expect(settingsHandlers.get_app_settings()).resolves.toMatchObject({
      browser_executable: null,
      browser_language: "system",
      general: {
        projects_folder: null,
        startup_behavior: "last_project",
        autosave_enabled: true,
        autosave_interval_sec: 5,
      },
      default_projects_folder: path.join(os.homedir(), "StoryCapture"),
      dock_progress_badge_supported: process.platform === "darwin",
    });
  });

  it("shallow-merges updates and persists the settings file", async () => {
    const result = await settingsHandlers.set_app_settings({
      update: {
        browser_language: "en-US",
        general: { autosave_interval_sec: 15 },
      },
    });

    expect(result).toMatchObject({
      browser_language: "en-US",
      general: { autosave_interval_sec: 15 },
    });
    await expect(readStoredSettings()).resolves.toMatchObject({
      browser_language: "en-US",
      general: { autosave_interval_sec: 15 },
    });
  });

  it("resets one settings category or all settings", async () => {
    await settingsHandlers.set_app_settings({
      update: {
        browser_language: "fr-FR",
        capture: { capture_fps: 24 },
      },
    });

    await expect(
      settingsHandlers.reset_app_settings_category({ category: "capture" }),
    ).resolves.toMatchObject({
      browser_language: "fr-FR",
      capture: { capture_fps: 60 },
    });

    await expect(
      settingsHandlers.reset_app_settings_category({ category: "all" }),
    ).resolves.toMatchObject({
      browser_language: "system",
      capture: { capture_fps: 60 },
    });
  });

  it("keeps browser-specific command defaults", async () => {
    await expect(
      settingsHandlers.set_browser_executable({
        path: "/Applications/Browser.app",
      }),
    ).resolves.toMatchObject({
      browser_executable: "/Applications/Browser.app",
    });
    await expect(
      settingsHandlers.set_browser_executable({}),
    ).resolves.toMatchObject({
      browser_executable: null,
    });
    await expect(
      settingsHandlers.set_browser_language({}),
    ).resolves.toMatchObject({
      browser_language: "system",
    });
    expect(settingsHandlers.get_browser_language_options()).toEqual([
      { value: "system", label: "System default" },
    ]);
  });
});
