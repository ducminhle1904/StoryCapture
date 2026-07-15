import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetRoot = path.resolve(here, "../../assets");
const bundledAssetManifestPath = path.join(assetRoot, "bundled-asset-manifest.json");

interface BundledAssetManifest {
  schemaVersion: number;
  assets: Array<{ assetId: string; path: string; mimeType: string }>;
}

function copyBundledAssets(): Plugin {
  return {
    name: "storycapture-bundled-assets",
    apply: "build",
    async writeBundle(outputOptions) {
      const outputRoot = path.resolve(here, outputOptions.dir ?? "dist");
      const outputAssetRoot = path.join(outputRoot, "bundled-assets");
      const manifest = JSON.parse(
        await readFile(bundledAssetManifestPath, "utf8"),
      ) as BundledAssetManifest;

      await Promise.all(
        manifest.assets.map(async (asset) => {
          const sourcePath = path.resolve(assetRoot, asset.path);
          const relativeSourcePath = path.relative(assetRoot, sourcePath);
          if (relativeSourcePath.startsWith("..") || path.isAbsolute(relativeSourcePath)) {
            throw new Error(`Bundled asset escapes the asset root: ${asset.path}`);
          }
          const outputPath = path.join(outputAssetRoot, asset.path);
          await mkdir(path.dirname(outputPath), { recursive: true });
          await copyFile(sourcePath, outputPath);
        }),
      );
      await writeFile(
        path.join(outputAssetRoot, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), copyBundledAssets()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    port: 1420,
    strictPort: true,
    host: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(here, "./src"),
      "@shared-types": path.resolve(here, "../../packages/shared-types/src"),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
