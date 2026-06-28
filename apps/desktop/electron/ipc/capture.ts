import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const captureHandlers = legacyHandlers([
  "get_capture_target",
  "set_capture_target",
  "capture_target_thumbnail",
  "start_capture",
  "start_capture_target",
  "stop_capture",
]) satisfies InvokeHandlers;
