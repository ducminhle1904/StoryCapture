import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const pickerHandlers = legacyHandlers([
  "picker_start_author",
  "picker_start",
  "picker_cancel",
  "picker_is_active",
  "picker_stamp_step_id",
]) satisfies InvokeHandlers;
