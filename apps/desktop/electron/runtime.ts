import type { App } from "electron";
import path from "node:path";

import identity from "./identity.json";

export const DEV_RELAUNCH_EXIT_CODE = identity.devRelaunchExitCode;

export function isGeneratedDevAppExecutable(executablePath = process.execPath) {
  const expectedSegment = `${path.sep}.electron-dev${path.sep}${identity.devAppName}.app${path.sep}`;
  return executablePath.includes(expectedSegment);
}

export function isDevRuntime(
  app: Pick<App, "isPackaged">,
  env: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
) {
  return !app.isPackaged || (env[identity.devAppEnv] === "1" && isGeneratedDevAppExecutable(executablePath));
}

export function isPackagedRuntime(
  app: Pick<App, "isPackaged">,
  env: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
) {
  return !isDevRuntime(app, env, executablePath);
}
