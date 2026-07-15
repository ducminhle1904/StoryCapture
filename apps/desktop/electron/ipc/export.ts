import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const exportHandlers = legacyHandlers([
  "export_get_presets",
  "export_preflight",
  "export_validate_config",
  "export_run",
]) satisfies InvokeHandlers;
