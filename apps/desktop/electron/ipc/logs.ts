import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const logsHandlers = legacyHandlers([
  "get_log_config",
  "set_log_config",
  "open_log_dir",
  "log_from_frontend",
  "export_diagnostic_bundle",
]) satisfies InvokeHandlers;
