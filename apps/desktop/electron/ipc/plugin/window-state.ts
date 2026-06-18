import { legacyHandlers } from "../legacy-command";
import type { InvokeHandlers } from "../types";

export const windowStateHandlers = legacyHandlers([
  "plugin:window-state|filename",
  "plugin:window-state|save_window_state",
  "plugin:window-state|restore_state",
]) satisfies InvokeHandlers;
