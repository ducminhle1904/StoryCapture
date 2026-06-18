import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const renderHandlers = legacyHandlers([
  "render_enqueue",
  "render_cancel",
  "render_list_active",
  "stream_render_progress",
]) satisfies InvokeHandlers;
