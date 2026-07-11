import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { app, protocol } from "electron";
import { assetPathFromUrl, isPathUnderRoot, LOCAL_ASSET_SCHEME } from "./local-asset-url";
import { parseByteRange } from "./local-assets-range";

const PROJECTS_REGISTRY_FILENAME = "projects.json";
const ROOT_CACHE_MS = 2_000;
const STREAM_CHUNK_SIZE = 64 * 1024;

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
  const configuredRoots = [
    path.join(userData, "simulator-runs"),
    path.join(userData, "exports"),
    path.join(app.getAppPath(), "assets"),
    path.join(process.resourcesPath, "assets"),
    ...projectFolders,
  ];
  const roots = await Promise.all(
    configuredRoots.map(async (root) => fs.realpath(root).catch(() => root)),
  );
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

function streamFileRange(
  handle: FileHandle,
  start: number,
  end: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let position = start;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    await handle.close();
  };
  const abort = () => {
    void close().catch(() => undefined);
  };

  signal.addEventListener("abort", abort, { once: true });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        await close().catch(() => undefined);
        controller.error(signal.reason ?? new Error("Request aborted"));
        return;
      }

      try {
        const length = Math.min(STREAM_CHUNK_SIZE, end - position + 1);
        if (length <= 0) {
          await close();
          controller.close();
          return;
        }
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead === 0) {
          await close();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        await close().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await close();
    },
  });
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
        stream: true,
      },
    },
  ]);
}

export function registerLocalAssetProtocol(): void {
  protocol.handle(LOCAL_ASSET_SCHEME, async (request) => {
    const filePath = assetPathFromUrl(request.url);
    const roots = await localAssetRoots();
    try {
      const realFilePath = await fs.realpath(filePath);
      if (!roots.some((root) => isPathUnderRoot(realFilePath, root))) {
        return new Response("Not found", { status: 404 });
      }
      const handle = await fs.open(realFilePath, "r");
      let streamOwnsHandle = false;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return new Response("Not found", { status: 404 });
        const range = parseByteRange(request.headers.get("range"), stat.size);
        const commonHeaders = {
          "content-type": contentTypeFor(realFilePath),
          "access-control-allow-origin": "*",
          "accept-ranges": "bytes",
        };
        if (range.kind === "unsatisfiable") {
          return new Response(null, {
            status: 416,
            headers: { ...commonHeaders, "content-range": `bytes */${stat.size}` },
          });
        }

        const start = range.kind === "partial" ? range.start : 0;
        const end = range.kind === "partial" ? range.end : stat.size - 1;
        const stream = stat.size === 0 ? null : streamFileRange(handle, start, end, request.signal);
        streamOwnsHandle = stream !== null;
        const response = new Response(stream, {
          status: range.kind === "partial" ? 206 : 200,
          headers: {
            ...commonHeaders,
            "content-length": String(Math.max(0, end - start + 1)),
            ...(range.kind === "partial"
              ? { "content-range": `bytes ${start}-${end}/${stat.size}` }
              : {}),
          },
        });
        return response;
      } finally {
        // A response stream owns the descriptor; early-return paths still close it here.
        if (!streamOwnsHandle) await handle.close().catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") return new Response("Not found", { status: 404 });
      return new Response("Not found", { status: 404 });
    }
  });
}
