/**
 * Automation IPC wrappers (Plan 01-06). Thin typed facade for the commands
 * defined in `apps/desktop/src-tauri/src/commands/automation.rs`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Mirror of `automation::ExecutorEvent` (Rust uses `#[serde(tag="type",
 * rename_all="snake_case")]`, so JSON looks like `{ type: "step_started", ... }`).
 */
export type ExecutorEvent =
  | { type: "story_started"; story_hash: string }
  | { type: "scene_entered"; name: string; ordinal: number }
  | { type: "step_started"; ordinal: number; command: unknown; driver_used: string }
  | { type: "step_attempt"; step_ordinal: number; attempt: unknown }
  | { type: "step_succeeded"; ordinal: number; duration_ms: number; cursor_x: number; cursor_y: number }
  | { type: "step_failed"; ordinal: number; attempts: unknown[]; error_message: string; screenshot_path?: string }
  | { type: "story_ended"; status: { total_steps: number; succeeded: number; failed: number; duration_ms: number } };

export interface LaunchAutomationArgs {
  storySource: string;
  projectFolder: string;
}

export async function launchAutomation(
  args: LaunchAutomationArgs,
  onEvent: (e: ExecutorEvent) => void,
): Promise<void> {
  const channel = new Channel<{ json: string }>();
  channel.onmessage = (wrapper) => {
    try {
      const parsed = JSON.parse(wrapper.json) as ExecutorEvent;
      onEvent(parsed);
    } catch {
      // ignore malformed events
    }
  };
  await invoke("launch_automation", {
    storySource: args.storySource,
    projectFolder: args.projectFolder,
    onEvent: channel,
  });
}
