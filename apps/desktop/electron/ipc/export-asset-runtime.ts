import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import bundledAssetManifestSource from "../../../../assets/bundled-asset-manifest.json";
import { assetPathFromUrl, convertLocalAssetPath } from "../local-asset-url";

const BUNDLED_ASSET_SCHEMA_VERSION = 1;
const BUNDLED_ASSET_CATEGORIES = new Set(["cosmic", "glass", "macos"]);
const PROJECTS_REGISTRY_FILENAME = "projects.json";

export interface BundledAssetManifestEntry {
  assetId: string;
  path: string;
  mimeType: string;
}

export interface BundledAssetManifest {
  schemaVersion: number;
  assets: BundledAssetManifestEntry[];
}

export type ExportAssetResolutionErrorCode =
  | "invalid-manifest"
  | "unknown-asset-id"
  | "invalid-local-reference"
  | "outside-allowed-roots"
  | "not-a-file";

export class ExportAssetResolutionError extends Error {
  override readonly name = "ExportAssetResolutionError";

  constructor(
    readonly code: ExportAssetResolutionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ProjectRecord {
  folder_path?: unknown;
}

export interface ExportAssetAppPaths {
  getAppPath(): string;
  getPath(name: "userData"): string;
}

export interface ExportGraphLike {
  video?: Array<Record<string, unknown>>;
}

export interface ResolveExportGraphAssetsOptions {
  app: ExportAssetAppPaths;
  devRuntime: boolean;
  allowedRoots?: string[];
}

function manifestEntryStem(entryPath: string): string {
  return path.posix.basename(entryPath, path.posix.extname(entryPath));
}

export function validateBundledAssetManifest(value: unknown): BundledAssetManifest {
  if (!value || typeof value !== "object") {
    throw new ExportAssetResolutionError("invalid-manifest", "Bundled asset manifest is missing");
  }
  const candidate = value as Partial<BundledAssetManifest>;
  if (
    candidate.schemaVersion !== BUNDLED_ASSET_SCHEMA_VERSION ||
    !Array.isArray(candidate.assets)
  ) {
    throw new ExportAssetResolutionError(
      "invalid-manifest",
      "Bundled asset manifest has an unsupported schema",
    );
  }

  const seen = new Set<string>();
  const assets = candidate.assets.map((entry, index) => {
    if (
      !entry ||
      typeof entry.assetId !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.mimeType !== "string"
    ) {
      throw new ExportAssetResolutionError(
        "invalid-manifest",
        `Bundled asset manifest entry ${index} is invalid`,
      );
    }
    const normalizedPath = path.posix.normalize(entry.path);
    const category = normalizedPath.split("/", 1)[0];
    const expectedAssetId = `${category}:${manifestEntryStem(normalizedPath)}`;
    if (
      normalizedPath !== entry.path ||
      normalizedPath.startsWith("../") ||
      path.posix.isAbsolute(normalizedPath) ||
      !BUNDLED_ASSET_CATEGORIES.has(category) ||
      entry.assetId !== expectedAssetId ||
      seen.has(entry.assetId)
    ) {
      throw new ExportAssetResolutionError(
        "invalid-manifest",
        `Bundled asset manifest entry ${entry.assetId} is unsafe or duplicated`,
      );
    }
    seen.add(entry.assetId);
    return { ...entry };
  });

  return { schemaVersion: BUNDLED_ASSET_SCHEMA_VERSION, assets };
}

export const BUNDLED_ASSET_MANIFEST = validateBundledAssetManifest(bundledAssetManifestSource);

const bundledAssetById = new Map(
  BUNDLED_ASSET_MANIFEST.assets.map((entry) => [entry.assetId, entry] as const),
);

export function bundledAssetRootForRuntime(appPath: string, devRuntime: boolean): string {
  return devRuntime
    ? path.resolve(appPath, "../..", "assets")
    : path.join(appPath, "dist", "bundled-assets");
}

async function readProjectFolders(userDataPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(userDataPath, PROJECTS_REGISTRY_FILENAME), "utf8");
    const records = JSON.parse(raw) as ProjectRecord[];
    if (!Array.isArray(records)) return [];
    return records
      .map((record) => record.folder_path)
      .filter((folder): folder is string => typeof folder === "string" && folder.length > 0);
  } catch {
    return [];
  }
}

export async function exportLocalAssetRoots(app: ExportAssetAppPaths): Promise<string[]> {
  const userDataPath = app.getPath("userData");
  return [
    path.join(userDataPath, "simulator-runs"),
    path.join(userDataPath, "exports"),
    ...(await readProjectFolders(userDataPath)),
  ];
}

export async function resolveAllowedRealFile(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<string> {
  let realFilePath: string;
  try {
    realFilePath = await fs.realpath(filePath);
  } catch (cause) {
    throw new ExportAssetResolutionError(
      "not-a-file",
      "Export asset does not resolve to a readable file",
      {},
      { cause },
    );
  }

  const realRoots = (
    await Promise.all(allowedRoots.map((root) => fs.realpath(root).catch(() => null)))
  ).filter((root): root is string => root !== null);
  const isAllowed = realRoots.some((root) => {
    const relative = path.relative(root, realFilePath);
    return (
      relative === "" ||
      Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });
  if (!isAllowed) {
    throw new ExportAssetResolutionError(
      "outside-allowed-roots",
      "Export asset is outside the allowed roots",
    );
  }

  const stat = await fs.stat(realFilePath).catch((cause) => {
    throw new ExportAssetResolutionError(
      "not-a-file",
      "Export asset does not resolve to a readable file",
      {},
      { cause },
    );
  });
  if (!stat.isFile()) {
    throw new ExportAssetResolutionError("not-a-file", "Export asset is not a file");
  }
  return realFilePath;
}

function localPathFromReference(reference: string): string {
  if (reference.startsWith("storycapture-asset:")) return assetPathFromUrl(reference);
  if (reference.startsWith("file:")) return fileURLToPath(reference);
  if (/^[a-z][a-z\d+.-]*:/i.test(reference) || !path.isAbsolute(reference)) {
    throw new ExportAssetResolutionError(
      "invalid-local-reference",
      "Export asset must be an absolute local file reference",
    );
  }
  return reference;
}

export async function resolveBundledAssetDataUrl(
  assetId: string,
  appPath: string,
  devRuntime: boolean,
): Promise<string> {
  const entry = bundledAssetById.get(assetId);
  if (!entry) {
    throw new ExportAssetResolutionError(
      "unknown-asset-id",
      `Unknown bundled asset id: ${assetId}`,
      { assetId },
    );
  }
  const root = bundledAssetRootForRuntime(appPath, devRuntime);
  const filePath = await resolveAllowedRealFile(path.join(root, entry.path), [root]);
  const bytes = await fs.readFile(filePath);
  return `data:${entry.mimeType};base64,${bytes.toString("base64")}`;
}

export async function resolveExportGraphAssets<T extends ExportGraphLike>(
  graph: T,
  options: ResolveExportGraphAssetsOptions,
): Promise<T> {
  if (!Array.isArray(graph.video)) return graph;
  const allowedRoots = options.allowedRoots ?? (await exportLocalAssetRoots(options.app));
  let changed = false;
  const video = await Promise.all(
    graph.video.map(async (node) => {
      if (node.type !== "background" || !node.kind || typeof node.kind !== "object") {
        return node;
      }
      const kind = node.kind as Record<string, unknown>;
      if (kind.kind !== "image") return node;

      const assetId = typeof kind.asset_id === "string" ? kind.asset_id : null;
      const assetPath = typeof kind.path === "string" ? kind.path : null;
      let resolvedPath: string;
      if (assetId) {
        resolvedPath = await resolveBundledAssetDataUrl(
          assetId,
          options.app.getAppPath(),
          options.devRuntime,
        );
      } else if (assetPath?.startsWith("data:")) {
        resolvedPath = assetPath;
      } else if (assetPath) {
        resolvedPath = convertLocalAssetPath(
          await resolveAllowedRealFile(localPathFromReference(assetPath), allowedRoots),
        );
      } else {
        throw new ExportAssetResolutionError(
          "invalid-local-reference",
          "Image background has neither a bundled asset id nor a local path",
        );
      }
      changed = true;
      return { ...node, kind: { ...kind, path: resolvedPath } };
    }),
  );

  return changed ? ({ ...graph, video } as T) : graph;
}
