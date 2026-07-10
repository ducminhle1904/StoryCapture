import os from "node:os";
import path from "node:path";
import { readJson, writeJson } from "./json-store";
import { userDataPath } from "./paths";
import type { InvokeHandlers } from "./types";

function defaultProjectsFolder(): string {
  return path.join(os.homedir(), "StoryCapture");
}

function defaultSettings() {
  return {
    browser_executable: null,
    browser_language: "system",
    general: {
      projects_folder: null,
      startup_behavior: "last_project",
      autosave_enabled: true,
      autosave_interval_sec: 5,
      dock_progress_badge: process.platform === "darwin",
    },
    capture: {
      capture_fps: 60,
      include_cursor_default: false,
      audio_input_default: "none",
      color_profile: "srgb_rec709",
    },
    render: {
      parallel_renders: 2,
    },
    privacy: {
      crash_reports_enabled: false,
      usage_analytics_enabled: false,
      prompt_redaction_enabled: true,
      diagnostic_bundle_enabled: true,
    },
    updates: {
      check_updates_on_launch: false,
    },
    default_projects_folder: defaultProjectsFolder(),
    dock_progress_badge_supported: process.platform === "darwin",
  };
}

async function getSettings() {
  const settings = await readJson(userDataPath("app_settings.json"), defaultSettings());
  return {
    ...defaultSettings(),
    ...settings,
    default_projects_folder: defaultProjectsFolder(),
    dock_progress_badge_supported: process.platform === "darwin",
  };
}

async function setSettings(update: unknown) {
  const base = await getSettings();
  const next = { ...base, ...(update as object) };
  await writeJson(userDataPath("app_settings.json"), next);
  return next;
}

async function resetSettingsCategory(category: string) {
  const base = await getSettings();
  const defaults = defaultSettings();
  const next =
    category === "all"
      ? defaults
      : {
          ...base,
          [category]: (defaults as Record<string, unknown>)[category],
        };
  await writeJson(userDataPath("app_settings.json"), next);
  return next;
}

async function updateSettingsField(
  field: "browser_executable" | "browser_language",
  value: unknown,
) {
  const base = await getSettings();
  const next = { ...base, [field]: value };
  await writeJson(userDataPath("app_settings.json"), next);
  return next;
}

export const settingsHandlers = {
  get_app_settings: () => getSettings(),
  set_app_settings: (args) =>
    setSettings((args as { update?: unknown } | undefined)?.update ?? args),
  reset_app_settings_category: (args) =>
    resetSettingsCategory(String((args as { category?: string } | undefined)?.category ?? "all")),
  get_browser_language_options: () => [{ value: "system", label: "System default" }],
  set_browser_executable: (args) =>
    updateSettingsField(
      "browser_executable",
      (args as { path?: string | null } | undefined)?.path ?? null,
    ),
  set_browser_language: (args) =>
    updateSettingsField(
      "browser_language",
      (args as { language?: string } | undefined)?.language ?? "system",
    ),
} satisfies InvokeHandlers;
