#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(desktopRoot, "native", "macos-recording-v3");
const buildRoot = path.join(nativeRoot, ".build");
const require = createRequire(import.meta.url);

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

if (process.platform === "darwin") {
  const electronExecutable = require("electron");
  const version = spawnSync(electronExecutable, ["-p", "process.versions.node"], {
    cwd: desktopRoot,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (version.error) throw version.error;
  if (version.status !== 0) {
    throw new Error(`failed to read Electron's Node version: ${(version.stderr ?? "").trim()}`);
  }
  const headers =
    process.env.STORYCAPTURE_ELECTRON_NODE_HEADERS_DIR ??
    path.join(
      os.homedir(),
      "Library",
      "Caches",
      "node-gyp",
      version.stdout.trim(),
      "include",
      "node",
    );
  await access(path.join(headers, "node_api.h"));
  await mkdir(buildRoot, { recursive: true });
  run("cmake", [
    "-S",
    nativeRoot,
    "-B",
    buildRoot,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DELECTRON_NODE_HEADERS_DIR=${headers}`,
  ]);
  run("cmake", ["--build", buildRoot, "--config", "Release"]);
  run(
    electronExecutable,
    [
      path.join(desktopRoot, "scripts", "verify-recording-v3-native-addon.cjs"),
      path.join(buildRoot, "storycapture_recording_v3.node"),
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
  );
}
