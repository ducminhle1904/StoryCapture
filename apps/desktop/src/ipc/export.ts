/**
 * Export IPC wrappers (Plan 02-11 + 02-12a).
 *
 * Typed wrappers around `export_run` / `export_get_presets` /
 * `export_validate_config`. The Post-Production editor's Export modal
 * (Plan 02-12b) consumes these.
 */

import type { EncoderOptionsDto } from "@storycapture/shared-types";
import { invoke } from "@tauri-apps/api/core";

export type ExportFormat = "mp4" | "webm" | "gif";
export type ExportResolution = "720p" | "1080p" | "4k";
export type ExportQuality = "low" | "med" | "high";

export interface ExportOutput {
  format: ExportFormat | string;
  resolution: ExportResolution | string;
  fps: number;
  quality: ExportQuality | string;
  /** Phase 13 — export-only encoder knobs. Undefined → Phase 12 defaults. */
  encoder_options?: EncoderOptionsDto | null;
}

export interface ExportRunArgs {
  story_id: string;
  /** JSON-encoded `effects::Graph`. Caller stringifies. */
  graph_json: string;
  outputs: ExportOutput[];
  priority: number;
  output_folder: string;
  base_name: string;
  preset_id: string | null;
}

export interface ExportResult {
  batch_id: string;
  job_ids: string[];
  graph_snapshot_path: string;
}

export interface ExportPresetsCatalogue {
  formats: string[];
  resolutions: string[];
  fps: number[];
  qualities: string[];
}

export const EXPORT_KEYS = {
  presets: ["export", "presets"] as const,
};

export async function exportRun(args: ExportRunArgs): Promise<ExportResult> {
  return invoke<ExportResult>("export_run", { args });
}

export async function exportGetPresets(): Promise<ExportPresetsCatalogue> {
  return invoke<ExportPresetsCatalogue>("export_get_presets");
}

export async function exportValidateConfig(cfg: ExportOutput): Promise<void> {
  await invoke<void>("export_validate_config", { cfg });
}
