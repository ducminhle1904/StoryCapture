import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workspaceRoot = path.resolve(root, "..", "..");
const outdir = path.join(root, "dist-electron");

const workspaceRuntimeAliases = {
  "@storycapture/shared-types/export-composition": path.join(
    workspaceRoot,
    "packages/shared-types/src/export-composition.ts",
  ),
  "@storycapture/shared-types/recording-v2": path.join(
    workspaceRoot,
    "packages/shared-types/src/recording-v2.ts",
  ),
};

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
  alias: workspaceRuntimeAliases,
  metafile: true,
};

const builds = await Promise.all([
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

const externalWorkspaceImports = builds.flatMap((result) =>
  Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports
      .filter((entry) => entry.external && entry.path.startsWith("@storycapture/"))
      .map((entry) => entry.path),
  ),
);

if (externalWorkspaceImports.length > 0) {
  throw new Error(
    `Electron bundles must not externalize workspace runtime modules: ${[
      ...new Set(externalWorkspaceImports),
    ].join(", ")}`,
  );
}
