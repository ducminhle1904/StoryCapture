import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const appHandlers = legacyHandlers([
  "ping",
  "app_info",
  "parse_story",
  "trigger_panic",
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
]) satisfies InvokeHandlers;
