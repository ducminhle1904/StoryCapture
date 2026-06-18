import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const settingsHandlers = legacyHandlers([
  "get_app_settings",
  "set_app_settings",
  "reset_app_settings_category",
  "get_browser_language_options",
  "set_browser_executable",
  "set_browser_language",
]) satisfies InvokeHandlers;
