import { legacyHandlers } from "../legacy-command";
import type { InvokeHandlers } from "../types";

export const updaterHandlers = legacyHandlers([
  "plugin:updater|check",
  "plugin:updater|download",
  "plugin:updater|install",
  "plugin:updater|download_and_install",
]) satisfies InvokeHandlers;
