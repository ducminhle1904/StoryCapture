import { checkElectronUpdate, installElectronUpdate } from "./update-store";
import type { InvokeHandlers } from "./types";

export const updatesHandlers = {
  check_update: () => checkElectronUpdate(),
  install_update: () => installElectronUpdate(),
} satisfies InvokeHandlers;
