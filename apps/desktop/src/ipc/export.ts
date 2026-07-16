/**
 * Export IPC wrappers.
 *
 * Typed wrappers around `export_run`, `export_preflight`, and
 * `export_get_presets`. Consumed by the Post-Production editor's Export modal.
 */

import type {
  EncoderOptionsDto,
  ExportIssue,
  ExportPreflightResult,
} from "@storycapture/shared-types";
import { invoke } from "@tauri-apps/api/core";

export type ExportFormat = "mp4" | "webm" | "gif";
export type ExportResolution = "match-source" | "720p" | "1080p" | "4k" | "custom";
export type ExportQuality = "low" | "med" | "high";
export type ExportEncoderOptions = EncoderOptionsDto & { quality_value?: number | null };

export interface AiDisclosure {
  contains_ai_voiceover: boolean;
  embed_xmp: boolean;
}

export interface ExportOutput {
  format: ExportFormat | string;
  resolution: ExportResolution | string;
  output_width?: number | null;
  output_height?: number | null;
  fps: number;
  quality: ExportQuality | string;
  /** Export-only encoder knobs. Undefined → defaults. */
  encoder_options?: ExportEncoderOptions | null;
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
  ai_disclosure: AiDisclosure;
}

export interface ExportResult {
  batch_id: string;
  job_ids: string[];
  graph_snapshot_path: string;
}

export interface ExportPreflightArgs {
  graph_json: string;
  outputs: ExportOutput[];
  compiler_issues: ExportIssue[];
  ai_disclosure: AiDisclosure;
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

export async function exportPreflight(args: ExportPreflightArgs): Promise<ExportPreflightResult> {
  return invoke<ExportPreflightResult>("export_preflight", { args });
}
