/**
 * Frontend → backend log bridge. Mirrors to `console.*` for DevTools and
 * forwards to `log_from_frontend` so the event lands in the canonical
 * tracing log file (target `storycapture::frontend`).
 *
 * ```ts
 * try { await invoke("start_recording", args); }
 * catch (err) {
 *   frontendLog.error("RecorderStartButton", "start_recording IPC failed", {
 *     fields: { project_id: id }, error: err,
 *   });
 * }
 * ```
 */

import { invoke } from "@tauri-apps/api/core";

export type FrontendLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface FrontendLogOptions {
  /** Structured context. Each key is rendered as `key="value"`. */
  fields?: Record<string, unknown>;
  /** An Error or anything thrown — `.message` and `.stack` are preserved. */
  error?: unknown;
  /** Defaults to current `location.pathname`. */
  url?: string;
}

interface SerializedError {
  message: string;
  stack?: string;
  name?: string;
}

/**
 * Format a thrown value into a single-line message. Host IPC errors
 * (`{ kind, message }`) get rendered as `kind: message` so the log line
 * stays readable — without this they'd be raw JSON.
 */
function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, name: err.name };
  }
  if (typeof err === "string") return { message: err };
  if (err && typeof err === "object") {
    const o = err as { kind?: unknown; message?: unknown };
    if (typeof o.kind === "string" && typeof o.message === "string") {
      return { message: `${o.kind}: ${o.message}`, name: o.kind };
    }
    try {
      return { message: JSON.stringify(err) };
    } catch {
      return { message: Object.prototype.toString.call(err) };
    }
  }
  return { message: String(err) };
}

function serializeFieldValue(v: unknown): string | null {
  if (v === undefined) return null;
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

function flattenFields(
  fields: Record<string, unknown> | undefined,
  err: SerializedError | null,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      const s = serializeFieldValue(v);
      if (s !== null) out.push([k, s]);
    }
  }
  if (err) {
    if (err.name && err.name !== "Error") out.push(["error_name", err.name]);
    out.push(["error_message", err.message]);
  }
  return out;
}

const CONSOLE_DISPATCH: Record<FrontendLogLevel, (...args: unknown[]) => void> = {
  // eslint-disable-next-line no-console
  trace: (...a) => console.trace(...a),
  // eslint-disable-next-line no-console
  debug: (...a) => console.debug(...a),
  // eslint-disable-next-line no-console
  info: (...a) => console.info(...a),
  // eslint-disable-next-line no-console
  warn: (...a) => console.warn(...a),
  // eslint-disable-next-line no-console
  error: (...a) => console.error(...a),
};

function hostInvokeAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function";
}

async function emit(
  level: FrontendLogLevel,
  source: string,
  message: string,
  opts: FrontendLogOptions = {},
): Promise<void> {
  const err = opts.error !== undefined ? serializeError(opts.error) : null;
  const fields = flattenFields(opts.fields, err);
  const url =
    opts.url ?? (typeof window !== "undefined" ? window.location.pathname : undefined);

  // Mirror to console first so DevTools shows the event even if the IPC
  // call below fails (offline, host crashed, etc.).
  const consoleArgs: unknown[] = [`[${source}] ${message}`];
  if (fields.length > 0) consoleArgs.push(Object.fromEntries(fields));
  if (err?.stack) consoleArgs.push(err.stack);
  CONSOLE_DISPATCH[level](...consoleArgs);

  if (!hostInvokeAvailable()) return;

  try {
    await invoke("log_from_frontend", {
      payload: {
        level,
        source,
        message,
        fields,
        stack: err?.stack ?? null,
        url: url ?? null,
      },
    });
  } catch (ipcErr) {
    // Logging-of-the-logger: if the bridge itself fails, fall back to
    // console — never re-throw, callers must not be killed by a log call.
    // eslint-disable-next-line no-console
    console.error("[frontendLog] failed to forward event to backend:", ipcErr, {
      original: { level, source, message },
    });
  }
}

export const frontendLog = {
  trace: (source: string, message: string, opts?: FrontendLogOptions) =>
    void emit("trace", source, message, opts),
  debug: (source: string, message: string, opts?: FrontendLogOptions) =>
    void emit("debug", source, message, opts),
  info: (source: string, message: string, opts?: FrontendLogOptions) =>
    void emit("info", source, message, opts),
  warn: (source: string, message: string, opts?: FrontendLogOptions) =>
    void emit("warn", source, message, opts),
  error: (source: string, message: string, opts?: FrontendLogOptions) =>
    void emit("error", source, message, opts),
};

let globalHandlersInstalled = false;

/**
 * Install browser-level handlers for unhandled errors and rejections so
 * any UI-side crash that escapes a try/catch lands in the log file.
 *
 * Idempotent.
 */
export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled || typeof window === "undefined") return;
  globalHandlersInstalled = true;

  window.addEventListener("error", (event) => {
    frontendLog.error("window.onerror", event.message || "uncaught error", {
      error: event.error,
      fields: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    frontendLog.error("unhandledrejection", "uncaught promise rejection", {
      error: event.reason,
    });
  });
}
