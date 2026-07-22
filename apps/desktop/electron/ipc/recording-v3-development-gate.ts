import type { App } from "electron";

import { isDevRuntime } from "../runtime";

export const RECORDING_V3_DEVELOPMENT_ENABLE_ENV =
  "STORYCAPTURE_ENABLE_UNCERTIFIED_RECORDING_V3" as const;

export function isRecordingV3DevelopmentEnabled(
  app: Pick<App, "isPackaged">,
  env: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
): boolean {
  return (
    env[RECORDING_V3_DEVELOPMENT_ENABLE_ENV] === "1" &&
    isDevRuntime(app, env, executablePath)
  );
}
