import { legacyHandlers } from "../legacy-command";
import type { InvokeHandlers } from "../types";

export const dialogHandlers = legacyHandlers([
  "plugin:dialog|open",
  "plugin:dialog|save",
  "plugin:dialog|message",
]) satisfies InvokeHandlers;
