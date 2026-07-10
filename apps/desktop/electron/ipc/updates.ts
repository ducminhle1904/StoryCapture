import type { InvokeHandlers } from "./types";
import { checkElectronUpdate, installElectronUpdate } from "./update-store";

export const updatesHandlers = {
  check_update: () => checkElectronUpdate(),
  install_update: () => installElectronUpdate(),
} satisfies InvokeHandlers;
