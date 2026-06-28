import type { InvokeHandlers } from "../types";
import { dialogHandlers } from "./dialog";
import { eventsHandlers } from "./events";
import { fsHandlers } from "./fs";
import { osProcessHandlers } from "./os-process";
import { shellHandlers } from "./shell";
import { storeHandlers } from "./store";
import { updaterHandlers } from "./updater";
import { windowStateHandlers } from "./window-state";

export const pluginHandlers = {
  ...dialogHandlers,
  ...eventsHandlers,
  ...osProcessHandlers,
  ...updaterHandlers,
  ...windowStateHandlers,
  ...shellHandlers,
  ...storeHandlers,
  ...fsHandlers,
} satisfies InvokeHandlers;
