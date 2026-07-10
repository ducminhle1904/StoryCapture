import { app } from "electron";
import { legacyHandlers } from "./legacy-command";
import { userDataPath } from "./paths";
import { sessionId } from "./session";
import { parseStorySource } from "./story-parser";
import type { InvokeHandlers } from "./types";

export const appHandlers = {
  ping: () => "pong from storycapture",
  app_info: () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    data_dir: app.getPath("userData"),
    log_dir: userDataPath("logs"),
    session_id: sessionId,
    pid: process.pid,
  }),
  parse_story: (args) =>
    parseStorySource(String((args as { source?: string } | undefined)?.source ?? "")),
  trigger_panic: () => {
    throw new Error("trigger_panic requested");
  },
  ...legacyHandlers([
    "list_audio_inputs",
    "probe_hw_encoders",
    "refresh_hw_encoders",
    "list_displays",
    "list_windows",
    "list_capture_targets",
    "check_screen_capture_permission",
    "request_screen_capture_access",
    "open_screen_capture_prefs",
    "relaunch_app",
    "resolve_playwright_target",
    "is_stage_manager_enabled",
  ]),
} satisfies InvokeHandlers;
