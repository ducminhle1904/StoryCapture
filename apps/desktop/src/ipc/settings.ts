/**
 * App-settings IPC wrappers.
 *
 * Keeps the `invoke<AppSettings>("get_app_settings")` call in one
 * place so UI components don't re-describe the IPC shape inline.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettingsDto,
  AppSettingsUpdate,
  AudioInputDefault,
  BrowserLanguageOptionDto,
  CaptureDefaults,
  ColorProfile,
  DiagnosticBundleResult,
  GeneralSettings,
  LogConfigDto,
  LogConfigUpdate,
  PrivacySettings,
  RenderDefaults,
  SettingsCategory,
  StartupBehavior,
  UpdateSettings,
} from "@storycapture/shared-types";

export type AppSettings = AppSettingsDto;
export type BrowserLanguageOption = BrowserLanguageOptionDto;
export type LogConfig = LogConfigDto;
export type {
  AppSettingsUpdate,
  AudioInputDefault,
  CaptureDefaults,
  ColorProfile,
  DiagnosticBundleResult,
  GeneralSettings,
  LogConfigUpdate,
  PrivacySettings,
  RenderDefaults,
  SettingsCategory,
  StartupBehavior,
  UpdateSettings,
};

export function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export function setAppSettings(update: AppSettingsUpdate): Promise<AppSettings> {
  return invoke<AppSettings>("set_app_settings", { update });
}

export function resetAppSettingsCategory(category: SettingsCategory): Promise<AppSettings> {
  return invoke<AppSettings>("reset_app_settings_category", { category });
}

export function getBrowserLanguageOptions(): Promise<BrowserLanguageOption[]> {
  return invoke<BrowserLanguageOption[]>("get_browser_language_options");
}

export function setBrowserExecutable(
  path: string | null,
): Promise<AppSettings> {
  return invoke<AppSettings>("set_browser_executable", { path });
}

export function setBrowserLanguage(language: string): Promise<AppSettings> {
  return invoke<AppSettings>("set_browser_language", { language });
}

export function getLogConfig(): Promise<LogConfig> {
  return invoke<LogConfig>("get_log_config");
}

export function setLogConfig(config: LogConfigUpdate): Promise<LogConfig> {
  return invoke<LogConfig>("set_log_config", { config });
}

export function openLogDir(): Promise<string> {
  return invoke<string>("open_log_dir");
}

export function exportDiagnosticBundle(parentDir: string): Promise<DiagnosticBundleResult> {
  return invoke<DiagnosticBundleResult>("export_diagnostic_bundle", { parentDir });
}
