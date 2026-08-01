import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const postProductionHandlers = legacyHandlers([
  "get_project_workflow",
  "update_project_workflow",
  "timeline_load",
  "timeline_save",
  "preset_list",
  "preset_import",
  "preset_export",
  "sound_library_list",
]) satisfies InvokeHandlers;
