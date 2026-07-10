/**
 * Sound library IPC wrappers.
 *
 * Typed wrappers around `sound_library_list`. Used by the
 * Post-Production editor's Sound drawer to populate SFX / BGM lists.
 */

import { invoke } from "@tauri-apps/api/core";

export type SoundCategory = "sfx" | "bgm";

export interface SoundLibraryEntry {
  id: string;
  /** "sfx" | "bgm" */
  category: string;
  name: string;
  file_path: string;
  duration_ms: number;
  license: string;
  source_url: string | null;
  author: string | null;
  bundled: boolean;
}

export const SOUND_LIBRARY_KEYS = {
  list: (category: SoundCategory) => ["sound-library", category] as const,
};

export async function soundLibraryList(category: SoundCategory): Promise<SoundLibraryEntry[]> {
  return invoke<SoundLibraryEntry[]>("sound_library_list", { category });
}
