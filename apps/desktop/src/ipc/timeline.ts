/**
 * Timeline persistence IPC wrappers.
 *
 * Typed wrappers around `timeline_load` / `timeline_save`. The
 * Post-Production editor serialises its Zustand layout slice to
 * `layout_json` when the user saves; the host-side guard rejects
 * payloads > 1 MiB.
 */

import { invoke } from "@tauri-apps/api/core";

export interface TimelineState {
  story_id: string;
  layout_json: string;
  last_modified: number;
}

export const TIMELINE_KEYS = {
  load: (storyId: string) => ["timeline", storyId] as const,
};

export async function timelineLoad(
  storyId: string,
): Promise<TimelineState | null> {
  return invoke<TimelineState | null>("timeline_load", { storyId });
}

export async function timelineSave(
  storyId: string,
  layoutJson: string,
): Promise<void> {
  await invoke<void>("timeline_save", { storyId, layoutJson });
}
