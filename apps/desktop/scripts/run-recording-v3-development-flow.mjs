#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareDevElectronApp } from "./prepare-dev-electron-app.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = JSON.parse(
  await fs.readFile(path.join(desktopRoot, "electron", "identity.json"), "utf8"),
);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Recording V3 development flow requires macOS on Apple silicon.");
}

function waitForServer(url, timeoutMs = 60_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) < 500) {
          resolve();
          return;
        }
        retry();
      });
      request.once("error", retry);
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Vite did not become ready at ${url}`));
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}

const { executablePath } = await prepareDevElectronApp();
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v3-development-e2e-"));
const reportPath = path.join(temporaryRoot, "development-flow-report.json");
const vite = spawn(
  pnpmCommand,
  ["exec", "vite", "--host", "127.0.0.1", "--strictPort"],
  { cwd: desktopRoot, stdio: "inherit" },
);

try {
  await waitForServer(identity.defaultDevServerUrl);
  const electron = spawn(
    executablePath,
    [
      desktopRoot,
      `--storycapture-recording-v3-development-flow-result=${reportPath}`,
    ],
    {
      cwd: desktopRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        [identity.devAppEnv]: "1",
        [identity.devServerUrlEnv]: identity.defaultDevServerUrl,
        STORYCAPTURE_ENABLE_UNCERTIFIED_RECORDING_V3: "1",
      },
    },
  );
  const close = new Promise((resolve, reject) => {
    electron.once("error", reject);
    electron.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  let terminateTimer;
  let killTimer;
  const boundedTimeout = new Promise((_, reject) => {
    terminateTimer = setTimeout(() => {
      electron.kill("SIGTERM");
      killTimer = setTimeout(() => {
        electron.kill("SIGKILL");
        reject(
          new Error(
            `Recording V3 development flow exceeded 5 minutes; report: ${reportPath}`,
          ),
        );
      }, 5_000);
    }, 5 * 60_000);
  });
  let exitCode;
  try {
    exitCode = await Promise.race([close, boundedTimeout]);
  } finally {
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
  }
  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`Recording V3 development flow did not produce ${reportPath}`, {
      cause: error,
    });
  }
  if (exitCode !== 0 || report.passed !== true) {
    throw new Error(
      `Recording V3 development flow failed (${report.error ?? `exit ${exitCode}`}); report: ${reportPath}`,
    );
  }
  process.stdout.write(
    `Recording V3 development flow passed: ${report.result.cadence_evidence.source_presentations} source frames, ${report.export_path}\n`,
  );
} finally {
  vite.kill("SIGTERM");
}
