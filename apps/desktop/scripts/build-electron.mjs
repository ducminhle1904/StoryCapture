import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outdir = path.join(root, "dist-electron");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  packages: "external",
  external: ["electron"],
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [path.join(root, "electron/main.ts")],
    outfile: path.join(outdir, "main.mjs"),
    format: "esm",
  }),
  build({
    ...shared,
    entryPoints: [path.join(root, "electron/preload.ts")],
    outfile: path.join(outdir, "preload.cjs"),
    format: "cjs",
  }),
]);
