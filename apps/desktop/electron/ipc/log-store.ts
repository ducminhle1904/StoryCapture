import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";
import { userDataPath } from "./paths";
import { sessionId } from "./session";

export interface LogConfigUpdate {
  log_dir?: string | null;
  max_file_size_bytes?: number | null;
  max_files?: number | null;
}

export interface FrontendLogPayload {
  level?: string;
  source?: string;
  message?: string;
  fields?: Array<[string, string]>;
  stack?: string | null;
  url?: string | null;
}

export type DiagnosticJsonValue =
  | boolean
  | number
  | string
  | null
  | DiagnosticJsonValue[]
  | { [key: string]: DiagnosticJsonValue };

export type DiagnosticLogStream = "application" | "record-engine";

const LOG_MIN_FILE_SIZE_BYTES = 1024 * 1024;
const LOG_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const LOG_MIN_FILES = 1;
const LOG_MAX_FILES = 50;
const LOG_VALUE_MAX_DEPTH = 4;
const LOG_VALUE_MAX_ITEMS = 50;
const LOG_VALUE_MAX_STRING_LENGTH = 2000;
const REDACTED = "[REDACTED]";
const REDACTED_PATH = "[REDACTED_PATH]";
const SENSITIVE_KEY =
  /(^|_)(authorization|cookie|password|secret|token|api_?key|capture_token|repair_token)($|_)/i;
const PRIVATE_CONTENT_KEY =
  /(^|_)(dom|html|story|story_source|typed_text|input_text|filename|file_name)($|_)/i;
const SELECTOR_KEY = /(^|_)(selector|selectors)($|_)/i;
const PATH_KEY = /(^|_)(path|dir|directory)($|_)/i;

let appendQueue = Promise.resolve();
const prunedStreams = new Set<string>();

export function defaultLogDir(): string {
  return userDataPath("logs");
}

function logConfigPath(): string {
  return userDataPath("log-config.json");
}

function normalizeLogConfig(update: LogConfigUpdate = {}): Required<LogConfigUpdate> {
  const maxFileSize = Number(update.max_file_size_bytes ?? 10 * 1024 * 1024);
  const maxFiles = Number(update.max_files ?? 10);
  return {
    log_dir: update.log_dir?.trim() ? update.log_dir.trim() : null,
    max_file_size_bytes: Math.min(
      LOG_MAX_FILE_SIZE_BYTES,
      Math.max(LOG_MIN_FILE_SIZE_BYTES, Math.round(maxFileSize)),
    ),
    max_files: Math.min(LOG_MAX_FILES, Math.max(LOG_MIN_FILES, Math.round(maxFiles))),
  };
}

async function readLogConfig(): Promise<Required<LogConfigUpdate>> {
  return normalizeLogConfig(await readJson<LogConfigUpdate>(logConfigPath(), {}));
}

export async function writeLogConfig(update: LogConfigUpdate): Promise<unknown> {
  const current = await readLogConfig();
  const next = normalizeLogConfig({ ...current, ...update });
  await writeJson(logConfigPath(), next);
  return buildLogConfigDto(next);
}

function buildLogConfigDto(config: Required<LogConfigUpdate>) {
  const defaultDir = defaultLogDir();
  return {
    effective_log_dir: config.log_dir ?? defaultDir,
    log_dir_override: config.log_dir,
    default_log_dir: defaultDir,
    max_file_size_bytes: config.max_file_size_bytes,
    max_files: config.max_files,
    min_file_size_bytes: LOG_MIN_FILE_SIZE_BYTES,
    max_allowed_file_size_bytes: LOG_MAX_FILE_SIZE_BYTES,
    min_files: LOG_MIN_FILES,
    max_allowed_files: LOG_MAX_FILES,
  };
}

export async function getLogConfig() {
  return buildLogConfigDto(await readLogConfig());
}

function logFileName(stream: DiagnosticLogStream, rotation = 0): string {
  const stem =
    stream === "record-engine"
      ? `storycapture-record-engine-${sessionId}`
      : `storycapture-${sessionId}`;
  const extension = stream === "record-engine" ? "jsonl" : "log";
  return `${stem}${rotation > 0 ? `.${rotation}` : ""}.${extension}`;
}

function selectorDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sanitizedUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.origin === "null" ? `${url.protocol}//` : url.origin;
  } catch {
    return REDACTED;
  }
}

function sanitizeDiagnosticString(value: string, key = ""): string {
  if (/url/i.test(key)) return sanitizedUrl(value);
  if (SELECTOR_KEY.test(key)) return `[REDACTED_SELECTOR:${selectorDigest(value)}]`;
  if (key === "artifact_relpath") {
    const normalized = value.replaceAll("\\", "/");
    if (
      path.posix.isAbsolute(normalized) ||
      normalized.split("/").some((part) => part === "..") ||
      normalized.length === 0
    ) {
      return REDACTED_PATH;
    }
    return normalized.slice(0, LOG_VALUE_MAX_STRING_LENGTH);
  }
  if (PATH_KEY.test(key)) return REDACTED_PATH;

  return value
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replaceAll(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replaceAll(
      /\b(capture_token|repair_token|api_?key|password|secret)=([^\s&]+)/gi,
      "$1=[REDACTED]",
    )
    .replaceAll(/\/Users\/[^/\s]+(?:\/[^\s:),]+)*/g, REDACTED_PATH)
    .replaceAll(/\/home\/[^/\s]+(?:\/[^\s:),]+)*/g, REDACTED_PATH)
    .replaceAll(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s:),]+/g, REDACTED_PATH)
    .replaceAll(/https?:\/\/[^\s]+/g, (url) => sanitizedUrl(url))
    .replaceAll(/\s+/g, " ")
    .slice(0, LOG_VALUE_MAX_STRING_LENGTH);
}

export function redactDiagnosticValue(
  value: unknown,
  key = "",
  depth = 0,
  seen = new WeakSet<object>(),
): DiagnosticJsonValue {
  if (SENSITIVE_KEY.test(key) || PRIVATE_CONTENT_KEY.test(key)) return REDACTED;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeDiagnosticString(value, key);
  if (typeof value === "boolean" || typeof value === "number")
    return Number.isFinite(value) || typeof value === "boolean" ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return sanitizeDiagnosticString(String(value), key);
  if (value instanceof Date) return value.toISOString();
  if (depth >= LOG_VALUE_MAX_DEPTH) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, LOG_VALUE_MAX_ITEMS)
        .map((item) => redactDiagnosticValue(item, key, depth + 1, seen));
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(0, LOG_VALUE_MAX_ITEMS);
    return Object.fromEntries(
      entries.map(([childKey, childValue]) => [
        childKey,
        redactDiagnosticValue(childValue, childKey, depth + 1, seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

function sanitizeLogField(value: unknown, key = ""): string {
  const sanitized = redactDiagnosticValue(value, key);
  const text = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  return (text ?? "").replaceAll(/\s+/g, " ").slice(0, LOG_VALUE_MAX_STRING_LENGTH);
}

async function rotateLogFiles(
  logDir: string,
  stream: DiagnosticLogStream,
  maxFiles: number,
): Promise<void> {
  const active = path.join(logDir, logFileName(stream));
  if (maxFiles === 1) {
    await fs.rm(active, { force: true });
    return;
  }
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const destination = path.join(logDir, logFileName(stream, index));
    const source = path.join(logDir, logFileName(stream, index - 1));
    if (index === maxFiles - 1) await fs.rm(destination, { force: true });
    try {
      await fs.rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function pruneLogFiles(
  logDir: string,
  stream: DiagnosticLogStream,
  maxFiles: number,
): Promise<void> {
  const entries = await fs.readdir(logDir, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => {
        if (!entry.isFile()) return false;
        if (stream === "record-engine")
          return /^storycapture-record-engine-.*\.jsonl$/.test(entry.name);
        return (
          /^storycapture-(?!record-engine-).*\.log$/.test(entry.name) &&
          !entry.name.includes("record-engine")
        );
      })
      .map(async (entry) => ({
        name: entry.name,
        mtimeMs: (await fs.stat(path.join(logDir, entry.name))).mtimeMs,
      })),
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(
    candidates
      .slice(maxFiles)
      .map((entry) => fs.rm(path.join(logDir, entry.name), { force: true })),
  );
}

async function appendDiagnosticLogLineNow(
  stream: DiagnosticLogStream,
  line: string,
): Promise<void> {
  const config = await readLogConfig();
  const logDir = config.log_dir ?? defaultLogDir();
  const maxFileSizeBytes = config.max_file_size_bytes ?? 10 * 1024 * 1024;
  const maxFiles = config.max_files ?? 10;
  await fs.mkdir(logDir, { recursive: true });
  const active = path.join(logDir, logFileName(stream));
  const streamKey = `${logDir}:${stream}:${maxFiles}`;
  let rotated = false;
  const currentBytes = await fs
    .stat(active)
    .then((stat) => stat.size)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
  if (currentBytes > 0 && currentBytes + Buffer.byteLength(line, "utf8") > maxFileSizeBytes) {
    await rotateLogFiles(logDir, stream, maxFiles);
    rotated = true;
  }
  await fs.appendFile(active, line, "utf8");
  if (rotated || !prunedStreams.has(streamKey)) {
    await pruneLogFiles(logDir, stream, maxFiles);
    prunedStreams.add(streamKey);
  }
}

export function appendDiagnosticLogLine(stream: DiagnosticLogStream, line: string): Promise<void> {
  const pending = appendQueue.then(() => appendDiagnosticLogLineNow(stream, line));
  appendQueue = pending.catch(() => undefined);
  return pending;
}

export async function logFromFrontend(payload: FrontendLogPayload): Promise<null> {
  const level = String(payload.level ?? "info").toUpperCase();
  const source = sanitizeLogField(payload.source ?? "frontend", "source");
  const message = sanitizeLogField(payload.message ?? "", "message");
  const fields = Array.isArray(payload.fields)
    ? payload.fields
        .map(
          ([key, value]) =>
            `${sanitizeLogField(key)}=${JSON.stringify(sanitizeLogField(value, key))}`,
        )
        .join(" ")
    : "";
  const url = payload.url ? ` url=${JSON.stringify(sanitizeLogField(payload.url, "url"))}` : "";
  const stack = payload.stack
    ? ` stack=${JSON.stringify(sanitizeLogField(payload.stack, "stack"))}`
    : "";
  const line = `${new Date().toISOString()} ${level} storycapture::frontend source=${JSON.stringify(source)} ${message}${fields ? ` ${fields}` : ""}${url}${stack}\n`;
  await appendDiagnosticLogLine("application", line);
  return null;
}

export async function exportDiagnosticBundle(parentDir: string) {
  const config = await readLogConfig();
  const effectiveLogDir = config.log_dir ?? defaultLogDir();
  const stamp = Math.floor(Date.now() / 1000);
  const outDir = path.join(parentDir, `storycapture-diagnostics-${stamp}`);
  const logsOut = path.join(outDir, "logs");
  await fs.mkdir(logsOut, { recursive: true });
  try {
    const entries = await fs.readdir(effectiveLogDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) =>
          fs.copyFile(path.join(effectiveLogDir, entry.name), path.join(logsOut, entry.name)),
        ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        app: {
          name: app.getName(),
          version: app.getVersion(),
          platform: process.platform,
        },
        privacy: {
          crash_reports_enabled: false,
          usage_analytics_enabled: false,
          prompt_redaction_enabled: false,
          log_redaction_version: 1,
          redaction_scope: "write_time_known_fields",
          export_resanitized: false,
        },
        logs: {
          source: "local_log_directory",
          recording_schema_version: 1,
          recording_format: "jsonl",
        },
        contents: ["logs", "manifest.json"],
        excluded: ["story source", "recordings", "project databases", "api keys"],
      },
      null,
      2,
    ),
    "utf8",
  );
  return { path: outDir };
}
