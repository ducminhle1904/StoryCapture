import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLED_ASSET_MANIFEST,
  bundledAssetRootForRuntime,
  ExportAssetResolutionError,
  resolveAllowedRealFile,
  resolveBundledAssetDataUrl,
  resolveExportGraphAssets,
  validateBundledAssetManifest,
} from "./export-asset-runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "../..");
const repositoryAssetRoot = path.resolve(desktopRoot, "../../assets");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-export-assets-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("bundled export asset manifest", () => {
  it("covers every source background with its stable category:stem id", async () => {
    const sourcePaths = (
      await Promise.all(
        ["cosmic", "glass", "macos"].map(async (category) =>
          (
            await fs.readdir(path.join(repositoryAssetRoot, category))
          )
            .filter((file) => /\.(?:jpe?g|png)$/i.test(file))
            .map((file) => `${category}/${file}`),
        ),
      )
    ).flat();
    const manifestPaths = BUNDLED_ASSET_MANIFEST.assets.map((asset) => asset.path);
    const manifestIds = BUNDLED_ASSET_MANIFEST.assets.map((asset) => asset.assetId);

    expect(manifestPaths.sort()).toEqual(sourcePaths.sort());
    expect(new Set(manifestIds).size).toBe(manifestIds.length);
    expect(manifestIds).toContain("macos:photo-1702539336564-b37d0f3276e7");
  });

  it("rejects traversal, mismatched ids, and duplicates", () => {
    expect(() =>
      validateBundledAssetManifest({
        schemaVersion: 1,
        assets: [{ assetId: "cosmic:outside", path: "../outside.jpg", mimeType: "image/jpeg" }],
      }),
    ).toThrow(ExportAssetResolutionError);
    expect(() =>
      validateBundledAssetManifest({
        schemaVersion: 1,
        assets: [
          { assetId: "cosmic:1", path: "cosmic/1.jpg", mimeType: "image/jpeg" },
          { assetId: "cosmic:1", path: "cosmic/1.jpg", mimeType: "image/jpeg" },
        ],
      }),
    ).toThrow(/duplicated/);
  });

  it("uses source assets in dev and emitted assets for build/package runtimes", () => {
    expect(bundledAssetRootForRuntime(desktopRoot, true)).toBe(repositoryAssetRoot);
    expect(bundledAssetRootForRuntime("/Applications/StoryCapture.app/app.asar", false)).toBe(
      "/Applications/StoryCapture.app/app.asar/dist/bundled-assets",
    );
  });

  it("resolves a bundled id from the dev source tree", async () => {
    const dataUrl = await resolveBundledAssetDataUrl("cosmic:1", desktopRoot, true);
    expect(dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(100);
  });

  it("resolves the same id from an emitted package layout", async () => {
    const appPath = await temporaryDirectory();
    const emittedAsset = path.join(appPath, "dist", "bundled-assets", "cosmic", "1.jpg");
    await fs.mkdir(path.dirname(emittedAsset), { recursive: true });
    await fs.writeFile(emittedAsset, Buffer.from([1, 2, 3]));

    await expect(resolveBundledAssetDataUrl("cosmic:1", appPath, false)).resolves.toBe(
      "data:image/jpeg;base64,AQID",
    );
  });
});

describe("export local asset access", () => {
  it("accepts a real file under an allowed root", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "background.png");
    await fs.writeFile(file, "fixture");

    await expect(resolveAllowedRealFile(file, [root])).resolves.toBe(await fs.realpath(file));
  });

  it("fails closed when a symlink inside a root escapes it", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const secret = path.join(outside, "secret.png");
    const link = path.join(root, "linked.png");
    await fs.writeFile(secret, "secret");
    await fs.symlink(secret, link);

    await expect(resolveAllowedRealFile(link, [root])).rejects.toMatchObject({
      code: "outside-allowed-roots",
    });
  });

  it("resolves local backgrounds only after the allowed-root check", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "background.png");
    await fs.writeFile(file, "fixture");
    const graph = {
      video: [
        {
          type: "background",
          kind: { kind: "image", asset_id: null, path: file },
        },
      ],
    };
    const app = { getAppPath: () => desktopRoot, getPath: () => root };

    const resolved = await resolveExportGraphAssets(graph, {
      app,
      devRuntime: true,
      allowedRoots: [root],
    });

    expect(resolved).not.toBe(graph);
    expect(resolved.video[0]?.kind.path).toMatch(/^storycapture-asset:\/\/local\//);
    expect(graph.video[0]?.kind.path).toBe(file);
  });

  it("rejects an unknown stable id instead of falling back to its path", async () => {
    const root = await temporaryDirectory();
    const graph = {
      video: [
        {
          type: "background",
          kind: { kind: "image", asset_id: "cosmic:not-real", path: "/tmp/fallback.jpg" },
        },
      ],
    };
    const app = { getAppPath: () => desktopRoot, getPath: () => root };

    await expect(
      resolveExportGraphAssets(graph, { app, devRuntime: true, allowedRoots: [root] }),
    ).rejects.toMatchObject({ code: "unknown-asset-id" });
  });
});
