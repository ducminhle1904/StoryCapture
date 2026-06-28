#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareDevElectronApp } from "./prepare-dev-electron-app.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const identity = JSON.parse(
  await readFile(path.join(desktopRoot, "electron", "identity.json"), "utf8"),
);
const { executablePath } = await prepareDevElectronApp();
let child = null;
let stoppingSignal = null;

function startChild() {
  child = spawn(executablePath, [desktopRoot], {
    stdio: "inherit",
    env: {
      ...process.env,
      [identity.devAppEnv]: "1",
      [identity.devServerUrlEnv]:
        process.env[identity.devServerUrlEnv] ?? identity.defaultDevServerUrl,
    },
  });

  child.on("exit", (code, signal) => {
    if (stoppingSignal) {
      process.exit(0);
    }
    if (code === identity.devRelaunchExitCode) {
      startChild();
      return;
    }
    if (signal) {
      process.exit(128 + (signal === "SIGINT" ? 2 : 15));
      return;
    }
    process.exit(code ?? 0);
  });
}

startChild();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stoppingSignal = signal;
    child?.kill(signal);
  });
}
