/**
 * Effect preset IPC wrappers.
 *
 * Typed wrappers around `preset_list` / `preset_import` / `preset_export`.
 * The preset picker consumes `usePresetList` via TanStack Query.
 */

import { invoke } from "@tauri-apps/api/core";

export type PresetScope = "project" | "global";

export interface EffectPreset {
  id: string;
  /** "project" | "global" */
  scope: string;
  name: string;
  description: string;
  ast_json: string;
  version: number;
  bundled: boolean;
  created_at: number;
  author: string | null;
  tags: string[];
}

export const PRESET_KEYS = {
  list: (scope: PresetScope) => ["presets", scope] as const,
};

export async function presetList(scope: PresetScope): Promise<EffectPreset[]> {
  return invoke<EffectPreset[]>("preset_list", { scope });
}

export async function presetImport(path: string, scope: PresetScope): Promise<string> {
  return invoke<string>("preset_import", { path, scope });
}

export async function presetExport(id: string, out: string): Promise<void> {
  await invoke<void>("preset_export", { id, out });
}
