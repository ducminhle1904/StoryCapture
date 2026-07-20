#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

if (process.platform === "darwin") {
  await run(process.execPath, ["native/macos-screen-capture/build-helper.mjs"]);
} else if (process.platform === "win32") {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const args = [
    "-NoProfile",
    "-File",
    "native/windows-capture/build.ps1",
    "-Configuration",
    "Release",
    "-Architecture",
    architecture,
  ];
  if (
    process.env.STORYCAPTURE_REQUIRE_SIGNED_NATIVE_HELPERS === "1" ||
    process.env.STORYCAPTURE_WINDOWS_CERT_THUMBPRINT
  ) {
    args.push("-Sign");
  }
  await run("pwsh", args);
} else {
  process.stdout.write(`No native capture helper is built for ${process.platform}.\n`);
}
