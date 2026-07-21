#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { bundleSharedTypesPlugin } from "./esbuild-shared-types-plugin.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(desktopRoot, "dist-electron"), { recursive: true });
const sharedOptions = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  packages: "external",
  external: ["electron"],
  plugins: [bundleSharedTypesPlugin()],
  format: "esm",
};
await build({
  ...sharedOptions,
  entryPoints: [path.join(desktopRoot, "electron", "recording-v3-production-probe", "main.ts")],
  outfile: path.join(desktopRoot, "dist-electron", "recording-v3-production-probe-runner.mjs"),
});
await build({
  ...sharedOptions,
  entryPoints: [
    path.join(desktopRoot, "electron", "recording-v3-production-probe", "bootstrap.ts"),
  ],
  outfile: path.join(desktopRoot, "dist-electron", "recording-v3-production-probe.mjs"),
});
