import { aiHandlers } from "./ai";
import { appHandlers } from "./app";
import { captureHandlers } from "./capture";
import { exportHandlers } from "./export";
import { logsHandlers } from "./logs";
import { pickerHandlers } from "./picker";
import { pluginHandlers } from "./plugin";
import { postProductionHandlers } from "./post-production";
import { previewHandlers } from "./preview";
import { projectsHandlers } from "./projects";
import { recordingHandlers } from "./recording";
import { renderHandlers } from "./render";
import { secretsHandlers } from "./secrets";
import { settingsHandlers } from "./settings";
import { simulatorHandlers } from "./simulator";
import type { InvokeHandlers } from "./types";
import { updatesHandlers } from "./updates";
import { webSyncHandlers } from "./web-sync";

export const handlers = {
  ...appHandlers,
  ...settingsHandlers,
  ...logsHandlers,
  ...updatesHandlers,
  ...recordingHandlers,
  ...previewHandlers,
  ...pickerHandlers,
  ...simulatorHandlers,
  ...renderHandlers,
  ...secretsHandlers,
  ...webSyncHandlers,
  ...aiHandlers,
  ...projectsHandlers,
  ...postProductionHandlers,
  ...exportHandlers,
  ...captureHandlers,
  ...pluginHandlers,
} satisfies InvokeHandlers;
