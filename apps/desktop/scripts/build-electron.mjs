import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workspaceRoot = path.resolve(root, "../..");
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
  alias: {
    "@storycapture/shared-types": path.join(workspaceRoot, "packages/shared-types/src/index.ts"),
    "@storycapture/shared-types/ipc": path.join(workspaceRoot, "packages/shared-types/src/ipc.ts"),
    "@storycapture/shared-types/export-composition": path.join(
      workspaceRoot,
      "packages/shared-types/src/export-composition.ts",
    ),
    "@storycapture/shared-types/recording-v4": path.join(
      workspaceRoot,
      "packages/shared-types/src/recording-v4.ts",
    ),
  },
  metafile: true,
};

const buildResults = await Promise.all([
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

const externalWorkspaceImports = buildResults.flatMap((result) =>
  Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports
      .filter((dependency) => dependency.external && dependency.path.startsWith("@storycapture/"))
      .map((dependency) => dependency.path),
  ),
);
if (externalWorkspaceImports.length > 0) {
  throw new Error(
    `Electron bundles cannot load workspace TypeScript at runtime: ${[
      ...new Set(externalWorkspaceImports),
    ].join(", ")}`,
  );
}
