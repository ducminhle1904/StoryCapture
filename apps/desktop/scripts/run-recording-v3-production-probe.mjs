#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(
  desktopRoot,
  "release-electron",
  process.arch === "arm64" ? "mac-arm64" : "mac",
  "StoryCapture.app",
);
const executable = path.join(appPath, "Contents", "MacOS", "StoryCapture");
const addonPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "native",
  "macos",
  "storycapture_recording_v3.node",
);
const reportPath = path.join(
  desktopRoot,
  "native",
  "macos-recording-v3",
  "reports",
  "production-600-frame-proof.json",
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? result.signal ?? "unknown"}`);
  }
}

async function runPackagedProbe() {
  process.stderr.write(`[recording-v3-runner] launching ${executable}\n`);
  const child = spawn(executable, [], {
    detached: true,
    env: { ...process.env, STORYCAPTURE_RECORDING_V3_PROBE_REPORT: reportPath },
    stdio: "inherit",
  });
  const heartbeat = setInterval(() => {
    process.stderr.write(`[recording-v3-runner] waiting for packaged report ${reportPath}\n`);
  }, 15_000);
  const timeout = setTimeout(() => {
    process.stderr.write("[recording-v3-runner] packaged probe exceeded 8 minute timeout\n");
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }, 5_000).unref();
  }, 8 * 60_000);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal) reject(new Error(`packaged Recording V3 probe terminated by ${signal}`));
        else resolve(code);
      });
    });
    if (exitCode !== 0) {
      let detail = "";
      try {
        const failedReport = JSON.parse(await fs.readFile(reportPath, "utf8"));
        detail = ` (${failedReport.phase ?? "runtime"}: ${failedReport.failure ?? "unknown"})`;
      } catch {
        // The exit itself remains actionable when bootstrap could not write a report.
      }
      throw new Error(`packaged Recording V3 probe exited ${exitCode}${detail}`);
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }
}

await fs.rm(reportPath, { force: true });
process.stderr.write("[recording-v3-runner] applying ad-hoc signature\n");
run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", addonPath], {
  timeout: 120_000,
});
run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], {
  timeout: 120_000,
});
process.stderr.write("[recording-v3-runner] verifying packaged signature\n");
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
  timeout: 120_000,
});
await runPackagedProbe();
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
if (report.passed !== true) throw new Error(`Recording V3 production probe failed: ${reportPath}`);
process.stdout.write(
  `Recording V3 production probe passed: ${report.native.nativeCommits} native commits, ${report.decodedFrames} decoded frames, ${report.jsFrameBytes} JS frame bytes\n`,
);
