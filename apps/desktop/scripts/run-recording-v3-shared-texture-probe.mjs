#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(desktopRoot, "release-electron");
const reportPath =
  process.env.STORYCAPTURE_SHARED_TEXTURE_PROBE_REPORT ??
  path.join(
    desktopRoot,
    "native",
    "macos-shared-texture-probe",
    "reports",
    "strict-browser-recording-v3-macos-spike.json",
  );

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? result.signal ?? "unknown"}`);
  }
}

async function findPackagedApp() {
  const entries = await fs.readdir(releaseRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || (entry.name !== "mac" && !entry.name.startsWith("mac-"))) continue;
    const appPath = path.join(releaseRoot, entry.name, "StoryCapture.app");
    try {
      await fs.access(appPath);
      return appPath;
    } catch {
      // Continue searching architecture-specific output folders.
    }
  }
  throw new Error(`packaged StoryCapture.app was not found under ${releaseRoot}`);
}

async function waitForReport(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      if (report.status === "passed" || report.status === "failed") return report;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`packaged shared-texture probe report timed out: ${reportPath}`);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("the shared-texture feasibility probe requires macOS arm64");
}

const appPath = await findPackagedApp();
const addonPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "native",
  "macos",
  "storycapture_shared_texture_probe.node",
);
run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", addonPath]);
run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
run("/usr/bin/codesign", ["--verify", "--strict", "--deep", "--verbose=2", appPath]);

const executablePath = path.join(appPath, "Contents", "MacOS", "StoryCapture");
await fs.rm(reportPath, { force: true });
const result = spawnSync(executablePath, [], {
  cwd: desktopRoot,
  encoding: "utf8",
  stdio: "inherit",
  env: {
    ...process.env,
    STORYCAPTURE_SHARED_TEXTURE_PROBE_REPORT: reportPath,
  },
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`packaged shared-texture probe failed; report: ${reportPath}`);
}
const report = await waitForReport();
if (report.status !== "passed" || report.evidence?.passed !== true) {
  throw new Error(`packaged shared-texture probe did not produce passing evidence: ${reportPath}`);
}
process.stdout.write(`Shared-texture feasibility probe passed: ${reportPath}\n`);
