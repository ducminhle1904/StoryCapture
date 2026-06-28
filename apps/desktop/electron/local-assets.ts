import { app, protocol } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { assetPathFromUrl, isPathUnderRoot, LOCAL_ASSET_SCHEME } from "./local-asset-url";

const PROJECTS_REGISTRY_FILENAME = "projects.json";
const ROOT_CACHE_MS = 2_000;

interface ProjectRecord {
  folder_path?: unknown;
}

let rootsCache: { expiresAt: number; roots: string[] } | null = null;

async function readProjectFolders(userDataPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(userDataPath, PROJECTS_REGISTRY_FILENAME), "utf8");
    const records = JSON.parse(raw) as ProjectRecord[];
    if (!Array.isArray(records)) return [];
    return records
      .map((record) => record.folder_path)
      .filter((folder): folder is string => typeof folder === "string" && folder.length > 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function localAssetRoots(): Promise<string[]> {
  if (rootsCache && rootsCache.expiresAt > Date.now()) return rootsCache.roots;
  const userData = app.getPath("userData");
  const projectFolders = await readProjectFolders(userData);
  const roots = [
    path.join(userData, "simulator-runs"),
    path.join(userData, "exports"),
    path.join(app.getAppPath(), "assets"),
    path.join(process.resourcesPath, "assets"),
    ...projectFolders,
  ];
  rootsCache = { expiresAt: Date.now() + ROOT_CACHE_MS, roots };
  return roots;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  return "application/octet-stream";
}

export function registerLocalAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        corsEnabled: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

export function registerLocalAssetProtocol(): void {
  protocol.handle(LOCAL_ASSET_SCHEME, async (request) => {
    const filePath = assetPathFromUrl(request.url);
    const roots = await localAssetRoots();
    try {
      const [realFilePath, realRoots] = await Promise.all([
        fs.realpath(filePath),
        Promise.all(roots.map(async (root) => fs.realpath(root).catch(() => root))),
      ]);
      if (!realRoots.some((root) => isPathUnderRoot(realFilePath, root))) {
        return new Response("Not found", { status: 404 });
      }
      const handle = await fs.open(realFilePath, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return new Response("Not found", { status: 404 });
        const bytes = await handle.readFile();
        return new Response(bytes, {
          headers: {
            "content-type": contentTypeFor(realFilePath),
            "access-control-allow-origin": "*",
          },
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") return new Response("Not found", { status: 404 });
      return new Response("Not found", { status: 404 });
    }
  });
}
