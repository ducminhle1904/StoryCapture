import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const simulatorHandlers = legacyHandlers([
  "simulator_start",
  "simulator_step_to",
  "simulator_cancel",
  "simulator_promote_fallback",
  "dryrun_start",
  "dryrun_cancel",
]) satisfies InvokeHandlers;
