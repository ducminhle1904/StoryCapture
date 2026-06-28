import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, desktopCapturer, systemPreferences, type WebContents } from "electron";
import identity from "../../identity.json";
import { screenCapturePermissionReport } from "../../permissions/screen-capture";
import { isPackagedRuntime } from "../../runtime";
import { readJson } from "../json-store";
import { userDataPath } from "../paths";
import { parseStorySource } from "../story-parser";
import type { InvokeArgs } from "../types";
import {
  channelIdFrom,
  type FsFileResource,
  type FsResource,
  fsResources,
  type LspDocument,
  type LspPosition,
  lspDocuments,
  type StoreRecord,
  sendChannel,
  shellProcesses,
  stores,
  takeNextResourceId,
} from "./shared";

export let screenSourceProbe: Promise<number> | null = null;

export function enumerateScreenSourcesForPermission(): Promise<number> {
  screenSourceProbe ??= desktopCapturer
    .getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    })
    .then((sources) => sources.length)
    .finally(() => {
      screenSourceProbe = null;
    });
  return screenSourceProbe;
}

export function screenPermissionReport(probe: boolean) {
  return screenCapturePermissionReport(
    {
      platform: process.platform,
      isPackaged: isPackagedRuntime(app),
      executablePath: process.execPath,
      fallbackAppName: app.getName(),
      debugBypassAllowed: process.env[identity.debugTccBypassEnv] === "1",
      getMediaAccessStatus: () => systemPreferences.getMediaAccessStatus("screen"),
      enumerateScreenSources: enumerateScreenSourcesForPermission,
    },
    { probe },
  );
}

export function getStore(rid: unknown): StoreRecord {
  if (typeof rid !== "number") throw new Error(`Invalid store rid: ${String(rid)}`);
  const store = stores.get(rid);
  if (!store) throw new Error(`Unknown store rid: ${rid}`);
  return store;
}

export async function loadStore(storePath: string): Promise<number> {
  const existing = [...stores.entries()].find(([, store]) => store.path === storePath);
  if (existing) return existing[0];
  const rid = takeNextResourceId();
  stores.set(rid, {
    path: storePath,
    data: await readJson(userDataPath("stores", storePath), {}),
    dirty: false,
  });
  return rid;
}

export function normalizeFsPath(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  return decoded.startsWith("file:") ? fileURLToPath(decoded) : decoded;
}

export function pathFromFsArgs(
  args: InvokeArgs,
  options?: { headers?: Record<string, string> },
): string {
  if (args && typeof args === "object" && "path" in args) return normalizeFsPath(String(args.path));
  const headerPath = options?.headers?.path;
  if (headerPath) return normalizeFsPath(headerPath);
  throw new Error("Missing file path");
}

export function fsPathField(args: InvokeArgs, field: string): string {
  if (
    args &&
    typeof args === "object" &&
    !(args instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(args) &&
    field in args
  ) {
    return normalizeFsPath(String(args[field]));
  }
  throw new Error(`Missing file path field: ${field}`);
}

export function fsInvokeOptions(
  args: InvokeArgs,
  options?: { headers?: Record<string, string> },
): Record<string, unknown> {
  if (
    args &&
    typeof args === "object" &&
    !(args instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(args) &&
    "options" in args
  ) {
    const rawOptions = args.options;
    return rawOptions && typeof rawOptions === "object"
      ? (rawOptions as Record<string, unknown>)
      : {};
  }
  const rawHeaderOptions = options?.headers?.options;
  if (!rawHeaderOptions) return {};
  try {
    const parsed = JSON.parse(rawHeaderOptions);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function nullableStatNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function fileInfoFromStats(stats: Stats) {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymlink: stats.isSymbolicLink(),
    size: stats.size,
    mtime: nullableStatNumber(stats.mtimeMs),
    atime: nullableStatNumber(stats.atimeMs),
    birthtime: nullableStatNumber(stats.birthtimeMs),
    readonly: (stats.mode & 0o222) === 0,
    fileAttributes: null,
    dev: nullableStatNumber(stats.dev),
    ino: nullableStatNumber(stats.ino),
    mode: nullableStatNumber(stats.mode),
    nlink: nullableStatNumber(stats.nlink),
    uid: nullableStatNumber(stats.uid),
    gid: nullableStatNumber(stats.gid),
    rdev: nullableStatNumber(stats.rdev),
    blksize: nullableStatNumber(stats.blksize),
    blocks: nullableStatNumber(stats.blocks),
  };
}

export async function fsEntrySize(file: string): Promise<number> {
  const stats = await fs.stat(file);
  if (!stats.isDirectory()) return stats.size;
  const entries = await fs.readdir(file, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += await fsEntrySize(path.join(file, entry.name));
  }
  return total;
}

export function bufferFromUnknown(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Buffer.from(value);
  throw new Error("Expected byte buffer");
}

export function fsResource(rid: unknown): FsResource {
  if (typeof rid !== "number") throw new Error(`Invalid filesystem rid: ${String(rid)}`);
  const resource = fsResources.get(rid);
  if (!resource) throw new Error(`Unknown filesystem rid: ${rid}`);
  return resource;
}

export function fsFileResource(rid: unknown): FsFileResource {
  const resource = fsResource(rid);
  if (resource.kind !== "file")
    throw new Error(`Filesystem rid is not a file handle: ${String(rid)}`);
  return resource;
}

export function fsOpenFlags(options: Record<string, unknown>): {
  append: boolean;
  flags: number;
  mode?: number;
} {
  const append = options.append === true;
  const write = options.write === true || append;
  const read = options.read !== false && !write ? true : options.read === true;
  const createNew = options.createNew === true;
  const create = options.create === true || createNew || append;
  const truncate = options.truncate === true;

  let flags =
    read && write ? fsConstants.O_RDWR : write ? fsConstants.O_WRONLY : fsConstants.O_RDONLY;
  if (append) flags |= fsConstants.O_APPEND;
  if (create) flags |= fsConstants.O_CREAT;
  if (createNew) flags |= fsConstants.O_EXCL;
  if (truncate) flags |= fsConstants.O_TRUNC;

  const mode = typeof options.mode === "number" ? options.mode : undefined;
  return { append, flags, mode };
}

export async function openFsFile(file: string, options: Record<string, unknown>): Promise<number> {
  const { append, flags, mode } = fsOpenFlags(options);
  if ((flags & fsConstants.O_CREAT) === fsConstants.O_CREAT) {
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  const handle = await fs.open(file, flags, mode);
  const rid = takeNextResourceId();
  fsResources.set(rid, {
    kind: "file",
    append,
    handle,
    path: file,
    position: append ? (await handle.stat()).size : 0,
  });
  return rid;
}

export function bytesWithReadCount(bytes: Buffer, bytesRead: number): number[] {
  const trailer = Buffer.alloc(8);
  trailer.writeBigUInt64BE(BigInt(bytesRead), 0);
  return Array.from(Buffer.concat([bytes.subarray(0, bytesRead), trailer]));
}

export function fsLineEncoding(args: InvokeArgs): BufferEncoding {
  const options = fsInvokeOptions(args);
  const encoding = typeof options.encoding === "string" ? options.encoding : "utf-8";
  return encoding.toLowerCase() as BufferEncoding;
}

export async function closeFsResource(rid: unknown): Promise<boolean> {
  if (typeof rid !== "number") throw new Error(`Invalid resource rid: ${String(rid)}`);
  const resource = fsResources.get(rid);
  if (!resource) return false;
  fsResources.delete(rid);
  if (resource.kind === "file") {
    await resource.handle.close();
  } else if (resource.kind === "watcher") {
    for (const watcher of resource.watchers) watcher.close();
  }
  return true;
}

export function closeShellResource(rid: unknown): boolean {
  if (typeof rid !== "number") throw new Error(`Invalid resource rid: ${String(rid)}`);
  const resource = shellProcesses.get(rid);
  if (!resource) return false;
  shellProcesses.delete(rid);
  if (!resource.child.killed) resource.child.kill();
  return true;
}

export const LSP_COMMAND_DOCS: Record<string, string> = {
  navigate: "Open a URL in the recording browser.",
  click: "Click an element matched by text, role, selector, testid, aria, or label.",
  type: "Type text into a matched input.",
  hover: "Move the cursor over a matched element.",
  assert: "Assert that a matched element is present.",
  select: "Select an option in a matched control.",
  upload: "Upload a local file through a matched file input.",
  scroll: "Scroll the page in a direction.",
  wait: "Wait for a duration, such as 500ms or 2s.",
  "wait-for": "Wait until an element appears.",
  screenshot: "Capture a named screenshot checkpoint.",
  pause: "Pause the story for author review.",
};

export function lspResponse(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

export function lspError(id: unknown, code: number, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

export function lspTextDocumentUri(params: unknown): string | null {
  const textDocument = (params as { textDocument?: { uri?: unknown } } | null)?.textDocument;
  return typeof textDocument?.uri === "string" ? textDocument.uri : null;
}

export function lspLineText(text: string, line: number): string {
  return text.split(/\r?\n/)[Math.max(0, line)] ?? "";
}

export function lspWordAt(text: string, position: LspPosition): string {
  const line = lspLineText(text, position.line);
  const at = Math.min(Math.max(0, position.character), line.length);
  const left = line.slice(0, at).match(/[a-zA-Z_-]+$/)?.[0] ?? "";
  const right = line.slice(at).match(/^[a-zA-Z_-]+/)?.[0] ?? "";
  return `${left}${right}`;
}

export function lspPosition(params: unknown): LspPosition {
  const position = (params as { position?: Partial<LspPosition> } | null)?.position ?? {};
  return {
    line: Number.isFinite(position.line) ? Number(position.line) : 0,
    character: Number.isFinite(position.character) ? Number(position.character) : 0,
  };
}

export function lspDiagnosticsFor(text: string) {
  const parsed = parseStorySource(text) as {
    diagnostics?: Array<{
      severity?: string;
      message?: string;
      span?: { line?: number; col?: number; start?: number; end?: number };
    }>;
  };
  return (parsed.diagnostics ?? []).map((diagnostic) => {
    const line = Math.max(0, Number(diagnostic.span?.line ?? 1) - 1);
    const character = Math.max(0, Number(diagnostic.span?.col ?? 1) - 1);
    const sourceLine = lspLineText(text, line);
    const endCharacter = Math.max(character + 1, sourceLine.length);
    return {
      range: {
        start: { line, character },
        end: { line, character: endCharacter },
      },
      severity: diagnostic.severity === "error" ? 1 : 2,
      source: "storycapture-electron",
      message: diagnostic.message ?? "Story syntax issue",
    };
  });
}

export function publishLspDiagnostics(
  sender: WebContents,
  channelId: number | null,
  uri: string,
  text: string,
): void {
  sendChannel(sender, channelId, {
    method: "textDocument/publishDiagnostics",
    params_json: JSON.stringify({ uri, diagnostics: lspDiagnosticsFor(text) }),
  });
}

export function lspCompletionItems() {
  return Object.entries(LSP_COMMAND_DOCS).map(([label, detail]) => ({
    label,
    kind: 14,
    detail,
    insertText: label,
  }));
}

export function lspHoverFor(text: string, position: LspPosition) {
  const word = lspWordAt(text, position);
  const detail = LSP_COMMAND_DOCS[word];
  if (!detail) return null;
  return {
    contents: {
      kind: "markdown",
      value: `**${word}**\n\n${detail}`,
    },
  };
}

export function lspInitializeResult() {
  return {
    capabilities: {
      textDocumentSync: 1,
      hoverProvider: true,
      completionProvider: { triggerCharacters: [" ", "<", '"', "'"] },
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    },
    serverInfo: {
      name: "StoryCapture Electron LSP",
      version: app.getVersion(),
    },
  };
}

export function lspDidOpen(params: unknown, sender: WebContents, channelId: number | null): void {
  const textDocument = (
    params as {
      textDocument?: { uri?: unknown; text?: unknown; version?: unknown };
    } | null
  )?.textDocument;
  if (typeof textDocument?.uri !== "string") return;
  const doc: LspDocument = {
    uri: textDocument.uri,
    text: typeof textDocument.text === "string" ? textDocument.text : "",
    version: Number.isFinite(textDocument.version) ? Number(textDocument.version) : 1,
  };
  lspDocuments.set(doc.uri, doc);
  publishLspDiagnostics(sender, channelId, doc.uri, doc.text);
}

export function lspDidChange(params: unknown, sender: WebContents, channelId: number | null): void {
  const uri = lspTextDocumentUri(params);
  if (!uri) return;
  const changes =
    (params as { contentChanges?: Array<{ text?: unknown }> } | null)?.contentChanges ?? [];
  const text =
    typeof changes.at(-1)?.text === "string"
      ? String(changes.at(-1)?.text)
      : (lspDocuments.get(uri)?.text ?? "");
  const version = Number(
    (params as { textDocument?: { version?: unknown } } | null)?.textDocument?.version ??
      lspDocuments.get(uri)?.version ??
      1,
  );
  const doc = { uri, text, version };
  lspDocuments.set(uri, doc);
  publishLspDiagnostics(sender, channelId, uri, text);
}

export function handleLspRequest(args: Record<string, unknown>, sender: WebContents): string {
  let envelope: { id?: unknown; method?: unknown; params?: unknown };
  try {
    envelope = JSON.parse(String(args.jsonrpcRequestJson ?? "null")) as typeof envelope;
  } catch (error) {
    return lspError(
      null,
      -32700,
      `invalid JSON-RPC envelope: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const id = envelope?.id;
  const method = typeof envelope?.method === "string" ? envelope.method : "";
  const params = envelope?.params;
  const channelId = channelIdFrom(args.onNotification);

  try {
    switch (method) {
      case "initialize":
        return lspResponse(id, lspInitializeResult());
      case "initialized":
        return "null";
      case "shutdown":
        return lspResponse(id, null);
      case "textDocument/didOpen":
        lspDidOpen(params, sender, channelId);
        return "null";
      case "textDocument/didChange":
        lspDidChange(params, sender, channelId);
        return "null";
      case "textDocument/didClose": {
        const uri = lspTextDocumentUri(params);
        if (uri) lspDocuments.delete(uri);
        return "null";
      }
      case "textDocument/completion":
        return lspResponse(id, {
          isIncomplete: false,
          items: lspCompletionItems(),
        });
      case "textDocument/hover": {
        const uri = lspTextDocumentUri(params);
        const doc = uri ? lspDocuments.get(uri) : null;
        return lspResponse(id, doc ? lspHoverFor(doc.text, lspPosition(params)) : null);
      }
      default:
        return id == null
          ? "null"
          : lspError(id, -32601, `method not found: ${method || "unknown"}`);
    }
  } catch (error) {
    return id == null
      ? "null"
      : lspError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}
