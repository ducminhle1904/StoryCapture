import {
  appendDiagnosticLogLine,
  type DiagnosticJsonValue,
  logFromFrontend,
  redactDiagnosticValue,
} from "./log-store";

export type RecordingLogLevel = "debug" | "info" | "warn" | "error";

export type RecordingLogEventNameV2 =
  | "recording.session.created"
  | "recording.lifecycle.transition"
  | "recording.preflight.completed"
  | "recording.readiness.completed"
  | "recording.readiness.degraded"
  | "recording.encoder.started"
  | "recording.encoder.exited"
  | "recording.bundle.committed"
  | "recording.bundle.failed"
  | "recording.recovery.discovered"
  | "recording.recovery.recovered"
  | "recording.recovery.discarded"
  | "recording.terminal"
  | "recording.target.resolved"
  | "recording.target.failed"
  | "recording.target.retry_scheduled"
  | "recording.target.candidate_validation_failed"
  | "recording.target.shadow_compared"
  | "recording.cursor.policy_selected"
  | "recording.cursor.target_shifted"
  | "recording.cursor.shadow_compared"
  | "recording.drag.started"
  | "recording.drag.completed"
  | "recording.drag.failed"
  | "recording.drag.shadow_compared"
  | "recording.upload.started"
  | "recording.upload.completed"
  | "recording.upload.failed"
  | "recording.scene.attempt_started"
  | "recording.scene.attempt_committed"
  | "recording.scene.attempt_failed"
  | "recording.scene.segment_frame_failed"
  | "recording.checkpoint.committed"
  | "recording.checkpoint.failed"
  | "recording.repair.required"
  | "recording.repair.resolved"
  | "recording.repair.expired"
  | "recording.repair.escalated"
  | "recording.stitch.started"
  | "recording.stitch.completed"
  | "recording.stitch.failed"
  | "recording.health.sampled"
  | "recording.health.state_changed"
  | "recording.health.publish_failed"
  | "recording.audio.track_state_changed"
  | "recording.audio.drift_detected"
  | "recording.audio.finalize_failed"
  | "recording.backend.probed"
  | "recording.backend.selected"
  | "recording.backend.fallback"
  | "recording.backend.target_lost"
  | "recording.backend.stopped"
  | "recording.backend.delivery_failed"
  | "recording.preview.started"
  | "recording.preview.first_frame"
  | "recording.preview.stopped"
  | "recording.outcome.shadow_mismatch"
  | "recording.sidecar.write_failed"
  | "recording.discovery.completed"
  | "recording.discovery.failed"
  | "recording.backend.spike_started"
  | "recording.backend.spike_completed"
  | "recording.backend.spike_failed";

export interface RecordingLogContext {
  request_id?: string;
  session_id?: string;
  take_id?: string;
  scene_id?: string;
  step_id?: string;
  attempt_id?: string;
  ordinal?: number;
  phase?: string;
  reason_code?: string;
  verdict?: "passed" | "repairable" | "failed" | "cancelled";
  backend_id?: string;
  track_id?: string;
  duration_ms?: number;
  artifact_relpath?: string;
}

export interface RecordingLogEventV2 extends RecordingLogContext {
  schema_version: 2;
  redaction_version: 1;
  emitted_at: string;
  level: RecordingLogLevel;
  event: RecordingLogEventNameV2;
  process_sequence: number;
  session_sequence?: number;
  error?: { name: string; message: string; stack?: string };
  details?: Record<string, DiagnosticJsonValue>;
}

export interface RecordingLogInput {
  level?: RecordingLogLevel;
  event: RecordingLogEventNameV2;
  context?: RecordingLogContext;
  details?: Record<string, unknown>;
  error?: unknown;
}

let processSequence = 0;
const sessionSequences = new Map<string, number>();
let writeFailureActive = false;
let suppressedWriteFailures = 0;

function structuredLoggingEnabled(): boolean {
  return process.env.STORYCAPTURE_RECORD_ENGINE_JSONL !== "0";
}

function diagnosticErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
}

async function writeObservabilityFallback(
  message: "recording.observability.write_failed" | "recording.observability.write_recovered",
  fields: Array<[string, string]>,
): Promise<void> {
  try {
    await logFromFrontend({
      level: message.endsWith("write_failed") ? "error" : "info",
      source: "record-engine",
      message,
      fields: [["stream", "record-engine"], ...fields],
    });
  } catch {
    const errorCode = fields.find(([key]) => key === "error_code")?.[1] ?? "UNKNOWN";
    try {
      process.stderr.write(
        `${message} stream=record-engine error_code=${errorCode} fallback=text_log_failed\n`,
      );
    } catch {
      // There is no remaining local diagnostic sink; recording behavior still wins.
    }
  }
}

function sanitizedError(error: unknown): RecordingLogEventV2["error"] {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) {
    return {
      name: String(redactDiagnosticValue(error.name, "error_name")),
      message: String(redactDiagnosticValue(error.message, "error_message")),
      ...(error.stack ? { stack: String(redactDiagnosticValue(error.stack, "stack")) } : {}),
    };
  }
  return {
    name: "UnknownError",
    message: String(redactDiagnosticValue(error, "error_message")),
  };
}

function nextSessionSequence(sessionId: string | undefined): number | undefined {
  if (!sessionId) return undefined;
  const next = (sessionSequences.get(sessionId) ?? 0) + 1;
  sessionSequences.set(sessionId, next);
  return next;
}

function sanitizedContext(context: RecordingLogContext): RecordingLogContext {
  const sanitized = redactDiagnosticValue(context) as Record<string, DiagnosticJsonValue>;
  const result: RecordingLogContext = {};
  const stringFields = [
    "request_id",
    "session_id",
    "take_id",
    "scene_id",
    "step_id",
    "attempt_id",
    "phase",
    "reason_code",
    "backend_id",
    "track_id",
  ] as const;
  for (const key of stringFields) {
    const value = sanitized[key];
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  if (typeof sanitized.ordinal === "number" && Number.isFinite(sanitized.ordinal))
    result.ordinal = sanitized.ordinal;
  if (
    typeof sanitized.duration_ms === "number" &&
    Number.isFinite(sanitized.duration_ms) &&
    sanitized.duration_ms >= 0
  )
    result.duration_ms = sanitized.duration_ms;
  if (
    sanitized.verdict === "passed" ||
    sanitized.verdict === "repairable" ||
    sanitized.verdict === "failed" ||
    sanitized.verdict === "cancelled"
  )
    result.verdict = sanitized.verdict;
  if (
    typeof sanitized.artifact_relpath === "string" &&
    sanitized.artifact_relpath !== "[REDACTED_PATH]"
  )
    result.artifact_relpath = sanitized.artifact_relpath;
  return result;
}

export async function recordEngineLog(
  input: RecordingLogInput,
): Promise<RecordingLogEventV2 | null> {
  if (!structuredLoggingEnabled()) return null;
  const context = sanitizedContext(input.context ?? {});
  processSequence += 1;
  const sessionSequence = nextSessionSequence(context.session_id);
  const details = input.details
    ? (redactDiagnosticValue(input.details) as Record<string, DiagnosticJsonValue>)
    : undefined;
  const event: RecordingLogEventV2 = {
    schema_version: 2,
    redaction_version: 1,
    emitted_at: new Date().toISOString(),
    level: input.level ?? "info",
    event: input.event,
    process_sequence: processSequence,
    ...context,
    ...(sessionSequence === undefined ? {} : { session_sequence: sessionSequence }),
    ...(input.error === undefined ? {} : { error: sanitizedError(input.error) }),
    ...(details === undefined ? {} : { details }),
  };
  try {
    await appendDiagnosticLogLine("record-engine", `${JSON.stringify(event)}\n`);
    if (writeFailureActive) {
      const suppressedCount = suppressedWriteFailures;
      writeFailureActive = false;
      suppressedWriteFailures = 0;
      await writeObservabilityFallback("recording.observability.write_recovered", [
        ["suppressed_count", String(suppressedCount)],
      ]);
    }
    return event;
  } catch (error) {
    // Observability must never alter the recording outcome it describes.
    if (writeFailureActive) {
      suppressedWriteFailures += 1;
      return null;
    }
    writeFailureActive = true;
    suppressedWriteFailures = 0;
    await writeObservabilityFallback("recording.observability.write_failed", [
      ["error_code", diagnosticErrorCode(error)],
      ["suppressed_count", "0"],
    ]);
    return null;
  }
}

export function resetRecordingObservabilityForTest(): void {
  processSequence = 0;
  sessionSequences.clear();
  writeFailureActive = false;
  suppressedWriteFailures = 0;
}
