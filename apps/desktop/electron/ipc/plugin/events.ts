import { legacyHandlers } from "../legacy-command";
import type { InvokeHandlers } from "../types";

export const eventsHandlers = legacyHandlers([
  "plugin:event|listen",
  "plugin:event|unlisten",
  "plugin:event|emit",
  "plugin:event|emit_to",
  "plugin:resources|close",
  "plugin:log|log",
]) satisfies InvokeHandlers;
