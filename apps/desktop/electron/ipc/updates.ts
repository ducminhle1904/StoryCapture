import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const updatesHandlers = legacyHandlers([
  "check_update",
  "install_update",
]) satisfies InvokeHandlers;
