import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const previewHandlers = legacyHandlers([
  "launch_automation",
  "start_preview_stream",
  "stop_preview_stream",
  "start_author_preview",
  "stop_author_preview",
  "pause_author_preview",
  "resume_author_preview",
  "set_author_preview_viewport",
  "set_author_preview_url",
  "author_preview_back",
  "author_preview_forward",
  "author_preview_reload",
  "attach_author_driver",
  "author_dispatch_input",
  "author_snapshot_list",
  "author_snapshot_get",
  "author_snapshot_capture",
  "author_snapshot_validate",
]) satisfies InvokeHandlers;
