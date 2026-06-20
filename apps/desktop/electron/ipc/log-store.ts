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

const LOG_MIN_FILE_SIZE_BYTES = 1024 * 1024;
const LOG_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const LOG_MIN_FILES = 1;
const LOG_MAX_FILES = 50;

export function defaultLogDir(): string {
  return userDataPath("logs");
}

function logConfigPath(): string {
  return userDataPath("log-config.json");
}

function normalizeLogConfig(
  update: LogConfigUpdate = {},
): Required<LogConfigUpdate> {
  const maxFileSize = Number(update.max_file_size_bytes ?? 10 * 1024 * 1024);
  const maxFiles = Number(update.max_files ?? 10);
  return {
    log_dir: update.log_dir?.trim() ? update.log_dir.trim() : null,
    max_file_size_bytes: Math.min(
      LOG_MAX_FILE_SIZE_BYTES,
      Math.max(LOG_MIN_FILE_SIZE_BYTES, Math.round(maxFileSize)),
    ),
    max_files: Math.min(
      LOG_MAX_FILES,
      Math.max(LOG_MIN_FILES, Math.round(maxFiles)),
    ),
  };
}

async function readLogConfig(): Promise<Required<LogConfigUpdate>> {
  return normalizeLogConfig(
    await readJson<LogConfigUpdate>(logConfigPath(), {}),
  );
}

export async function writeLogConfig(
  update: LogConfigUpdate,
): Promise<unknown> {
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

function logFileName(): string {
  return `storycapture-${sessionId}.log`;
}

function sanitizeLogField(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").replaceAll(/\s+/g, " ").slice(0, 2000);
}

export async function logFromFrontend(
  payload: FrontendLogPayload,
): Promise<null> {
  const config = await readLogConfig();
  const logDir = config.log_dir ?? defaultLogDir();
  await fs.mkdir(logDir, { recursive: true });
  const level = String(payload.level ?? "info").toUpperCase();
  const source = sanitizeLogField(payload.source ?? "frontend");
  const message = sanitizeLogField(payload.message ?? "");
  const fields = Array.isArray(payload.fields)
    ? payload.fields
        .map(
          ([key, value]) =>
            `${sanitizeLogField(key)}=${JSON.stringify(sanitizeLogField(value))}`,
        )
        .join(" ")
    : "";
  const url = payload.url
    ? ` url=${JSON.stringify(sanitizeLogField(payload.url))}`
    : "";
  const stack = payload.stack
    ? ` stack=${JSON.stringify(sanitizeLogField(payload.stack))}`
    : "";
  const line = `${new Date().toISOString()} ${level} storycapture::frontend source=${JSON.stringify(source)} ${message}${fields ? ` ${fields}` : ""}${url}${stack}\n`;
  await fs.appendFile(path.join(logDir, logFileName()), line, "utf8");
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
          fs.copyFile(
            path.join(effectiveLogDir, entry.name),
            path.join(logsOut, entry.name),
          ),
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
          prompt_redaction_enabled: true,
        },
        logs: { source: effectiveLogDir },
        contents: ["logs", "manifest.json"],
        excluded: [
          "story source",
          "recordings",
          "project databases",
          "api keys",
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return { path: outDir };
}
