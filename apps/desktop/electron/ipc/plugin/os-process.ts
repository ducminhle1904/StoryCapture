import { legacyHandlers } from "../legacy-command";
import type { InvokeHandlers } from "../types";

export const osProcessHandlers = legacyHandlers([
  "plugin:os|locale",
  "plugin:os|hostname",
  "plugin:process|restart",
  "plugin:process|exit",
]) satisfies InvokeHandlers;
