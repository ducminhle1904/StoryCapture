#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const releaseRoot = path.join(desktopRoot, "release-electron");

async function executableExists(candidate) {
  try {
    await fs.access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function packagedExecutable() {
  const outputDirectories = await fs.readdir(releaseRoot, { withFileTypes: true });
  for (const entry of outputDirectories) {
    if (!entry.isDirectory()) continue;
    const output = path.join(releaseRoot, entry.name);
    const candidates =
      process.platform === "darwin"
        ? [path.join(output, "StoryCapture.app", "Contents", "MacOS", "StoryCapture")]
        : process.platform === "win32"
          ? [path.join(output, "StoryCapture.exe")]
          : [path.join(output, "storycapture"), path.join(output, "StoryCapture")];
    for (const candidate of candidates) {
      if (await executableExists(candidate)) return candidate;
    }
  }
  throw new Error(`Packaged StoryCapture executable not found under ${releaseRoot}`);
}

async function launchSmoke(executablePath, userDataPath, resultPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      executablePath,
      [
        `--user-data-dir=${userDataPath}`,
        `--storycapture-export-compositor-smoke-result=${resultPath}`,
      ],
      {
        cwd: desktopRoot,
        env: {
          ...process.env,
          STORYCAPTURE_DEV_APP: "0",
          STORYCAPTURE_EXPORT_COMPOSITOR_SMOKE_RESULT: resultPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const capture = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-8_000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(async () => {
      child.kill("SIGKILL");
      const partialResult = await fs.readFile(resultPath, "utf8").catch(() => "no result file");
      reject(
        new Error(
          `Packaged smoke timed out. Partial result:\n${partialResult}\nOutput:\n${output}`,
        ),
      );
    }, 180_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else {
        const partialResult = await fs.readFile(resultPath, "utf8").catch(() => "no result file");
        reject(
          new Error(
            `Packaged smoke exited with ${code ?? signal}. Partial result:\n${partialResult}\nOutput:\n${output}`,
          ),
        );
      }
    });
  });
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-artifact-smoke-"));
try {
  const resultPath = path.join(temporaryRoot, "result.json");
  await launchSmoke(await packagedExecutable(), path.join(temporaryRoot, "user-data"), resultPath);
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  if (!result.ok) throw new Error(`Packaged smoke failed: ${JSON.stringify(result.error)}`);
  console.log(JSON.stringify(result));
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
