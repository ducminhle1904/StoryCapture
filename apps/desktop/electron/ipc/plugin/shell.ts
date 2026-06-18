import { legacyHandlers } from "../legacy-command";
import type { InvokeHandlers } from "../types";

export const shellHandlers = legacyHandlers([
  "plugin:shell|open",
  "plugin:shell|execute",
  "plugin:shell|spawn",
  "plugin:shell|stdin_write",
  "plugin:shell|kill",
]) satisfies InvokeHandlers;
