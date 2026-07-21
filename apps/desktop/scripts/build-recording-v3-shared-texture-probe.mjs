#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { bundleSharedTypesPlugin } from "./esbuild-shared-types-plugin.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(desktopRoot, "native", "macos-shared-texture-probe");
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

async function buildNativeAddon() {
  if (process.platform !== "darwin") return;
  const electronExecutable = require("electron");
  const versionResult = spawnSync(electronExecutable, ["-p", "process.versions.node"], {
    cwd: desktopRoot,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (versionResult.error) throw versionResult.error;
  if (versionResult.status !== 0) {
    throw new Error(
      `failed to read Electron's Node version: ${(versionResult.stderr ?? "").trim()}`,
    );
  }
  const electronNodeVersion = versionResult.stdout.trim();
  const headers =
    process.env.STORYCAPTURE_ELECTRON_NODE_HEADERS_DIR ??
    path.join(
      os.homedir(),
      "Library",
      "Caches",
      "node-gyp",
      electronNodeVersion,
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
      path.join(desktopRoot, "scripts", "verify-recording-v3-shared-texture-addon.cjs"),
      path.join(buildRoot, "storycapture_shared_texture_probe.node"),
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
  );
}

async function buildPackagedEntry() {
  await mkdir(path.join(desktopRoot, "dist-electron"), { recursive: true });
  await build({
    bundle: true,
    platform: "node",
    target: "node22",
    sourcemap: true,
    logLevel: "info",
    packages: "external",
    external: ["electron"],
    plugins: [bundleSharedTypesPlugin()],
    entryPoints: [
      path.join(desktopRoot, "electron", "recording-v3-shared-texture-probe", "main.ts"),
    ],
    outfile: path.join(desktopRoot, "dist-electron", "recording-v3-shared-texture-probe.mjs"),
    format: "esm",
  });
}

const nativeOnly = process.argv.includes("--native-only");
const entryOnly = process.argv.includes("--entry-only");
if (!entryOnly) await buildNativeAddon();
if (!nativeOnly) await buildPackagedEntry();
