/**
 * App-settings IPC wrappers. See
 * `apps/desktop/src-tauri/src/commands/app_settings.rs` (and
 * `set_browser_executable` in the browser-preset registration).
 *
 * Keeps the `invoke<AppSettings>("get_app_settings")` call in one
 * place so UI components don't re-describe the IPC shape inline.
 */

import { invoke } from "@tauri-apps/api/core";

export interface AppSettings {
  browser_executable: string | null;
  /** Persisted live-preview toggle. */
  live_preview_enabled: boolean;
}

export interface LogConfig {
  /** Effective on-disk directory tracing logs are written to. */
  effective_log_dir: string;
  /** Raw user override (null = use platform default). */
  log_dir_override: string | null;
  /** Platform default log directory; informational. */
  default_log_dir: string;
  max_file_size_bytes: number;
  max_files: number;
  min_file_size_bytes: number;
  max_allowed_file_size_bytes: number;
  min_files: number;
  max_allowed_files: number;
}

export interface LogConfigUpdate {
  log_dir: string | null;
  max_file_size_bytes: number;
  max_files: number;
}

export function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export function setBrowserExecutable(
  path: string | null,
): Promise<AppSettings> {
  return invoke<AppSettings>("set_browser_executable", { path });
}

export function setLivePreviewEnabled(enabled: boolean): Promise<AppSettings> {
  return invoke<AppSettings>("set_live_preview_enabled", { enabled });
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
