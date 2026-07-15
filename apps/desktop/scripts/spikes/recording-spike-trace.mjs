import fs from "node:fs/promises";
import path from "node:path";

const BACKEND_ID = "macos_screencapturekit";
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const FAILURE_REASONS = new Set([
  "spike_execution_failed",
  "spike_report_contract_invalid",
]);

function enabled() {
  return process.env.STORYCAPTURE_RECORD_ENGINE_JSONL !== "0";
}

function safeToken(value, fallback = "invalid") {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : fallback;
}

function safeTokens(values) {
  return Array.isArray(values) ? values.map((value) => safeToken(value)).slice(0, 50) : [];
}

function safeArtifactRelpath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === "..")
  )
    return null;
  return normalized;
}

function relativeReportPath(batchDirectory, reportPath) {
  if (typeof reportPath !== "string" || reportPath.length === 0) return null;
  const relative = path.relative(batchDirectory, reportPath);
  return safeArtifactRelpath(relative);
}

function errorIdentity(error) {
  const rawName = error instanceof Error ? error.name : "UnknownError";
  const rawCode = error && typeof error === "object" ? error.code : null;
  return {
    error_name: safeToken(rawName, "UnknownError"),
    error_code: safeToken(rawCode, "UNKNOWN"),
  };
}

function normalizeDecision(kind, decision) {
  if (kind === "native-capture") {
    if (typeof decision === "string" && decision.startsWith("go:"))
      return { decision: "go", reasonCode: "spike_gate_passed", level: "info" };
    if (decision === "no-go")
      return { decision: "no-go", reasonCode: "spike_gate_failed", level: "warn" };
  }
  if (kind === "system-audio") {
    if (decision === "PASS")
      return { decision: "pass", reasonCode: "spike_gate_passed", level: "info" };
    if (decision === "FAIL")
      return { decision: "fail", reasonCode: "spike_gate_failed", level: "warn" };
  }
  const error = new Error("native spike report returned an unsupported decision");
  error.code = "INVALID_REPORT_CONTRACT";
  throw error;
}

export function createRecordingSpikeTrace({
  batchDirectory,
  batchId,
  kind,
  matrix,
  profiles,
  durationScale,
}) {
  const safeBatchId = safeToken(batchId);
  const safeKind = kind === "system-audio" ? kind : "native-capture";
  const tracePath = path.join(
    batchDirectory,
    `storycapture-record-engine-spike-${safeBatchId}.jsonl`,
  );
  const baseDetails = {
    kind: safeKind,
    matrix: safeTokens(matrix),
    profiles: safeTokens(profiles),
    duration_scale: Number.isFinite(Number(durationScale)) ? Number(durationScale) : null,
  };
  let processSequence = 0;
  let appendQueue = Promise.resolve();

  function append({ event, level = "info", reasonCode, durationMs, artifactRelpath, details }) {
    if (!enabled()) return Promise.resolve(null);
    processSequence += 1;
    const item = {
      schema_version: 1,
      redaction_version: 1,
      emitted_at: new Date().toISOString(),
      level,
      event,
      process_sequence: processSequence,
      request_id: safeBatchId,
      attempt_id: safeBatchId,
      phase: "native_spike",
      backend_id: BACKEND_ID,
      ...(reasonCode ? { reason_code: reasonCode } : {}),
      ...(Number.isFinite(durationMs) && durationMs >= 0 ? { duration_ms: durationMs } : {}),
      ...(artifactRelpath ? { artifact_relpath: artifactRelpath } : {}),
      details,
    };
    const pending = appendQueue.then(async () => {
      try {
        await fs.appendFile(tracePath, `${JSON.stringify(item)}\n`, "utf8");
        return item;
      } catch {
        return null;
      }
    });
    appendQueue = pending.then(() => undefined);
    return pending;
  }

  return {
    tracePath,
    started() {
      return append({
        event: "recording.backend.spike_started",
        details: baseDetails,
      });
    },
    completed({ decision, reportPath, durationMs }) {
      const normalized = normalizeDecision(safeKind, decision);
      const reportRelpath = relativeReportPath(batchDirectory, reportPath);
      return append({
        event: "recording.backend.spike_completed",
        level: normalized.level,
        reasonCode: normalized.reasonCode,
        durationMs,
        artifactRelpath: "raw.json",
        details: {
          ...baseDetails,
          decision: normalized.decision,
          report_relpath: reportRelpath,
          report_external: reportRelpath === null,
        },
      });
    },
    failed({ reasonCode, error, durationMs }) {
      return append({
        event: "recording.backend.spike_failed",
        level: "error",
        reasonCode: FAILURE_REASONS.has(reasonCode) ? reasonCode : "spike_execution_failed",
        durationMs,
        details: { ...baseDetails, ...errorIdentity(error) },
      });
    },
  };
}
