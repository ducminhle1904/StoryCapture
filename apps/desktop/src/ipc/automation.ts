/**
 * Automation IPC wrappers (Plan 01-06). Thin typed facade for the commands
 * defined in `apps/desktop/src-tauri/src/commands/automation.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

export interface LaunchAutomationArgs {
  source: string;
}

export function launchAutomation(args: LaunchAutomationArgs): Promise<unknown> {
  return invoke("launch_automation", { ...args });
}
