#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(desktopRoot, "release-electron");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: desktopRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}

async function findDirectory(predicate) {
  const entries = await fs.readdir(releaseRoot, { withFileTypes: true });
  const match = entries.find((entry) => entry.isDirectory() && predicate(entry.name));
  if (!match) throw new Error(`Packaged application directory was not found under ${releaseRoot}`);
  return path.join(releaseRoot, match.name);
}

if (process.platform === "darwin") {
  const macRoot = await findDirectory((name) => name === "mac" || name.startsWith("mac-"));
  await run(process.execPath, [
    "native/macos-screen-capture/verify-packaged-helper.mjs",
    path.join(macRoot, "StoryCapture.app"),
  ]);
} else if (process.platform === "win32") {
  const unpackedRoot = await findDirectory(
    (name) => name.startsWith("win-") && name.endsWith("unpacked"),
  );
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  await run("pwsh", [
    "-NoProfile",
    "-File",
    "native/windows-capture/verify-package.ps1",
    "-ResourcesPath",
    path.join(unpackedRoot, "resources"),
    "-Architecture",
    architecture,
  ]);
} else {
  throw new Error(`Packaged native capture verification is unsupported on ${process.platform}`);
}
