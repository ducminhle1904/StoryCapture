import type {
  RecordingAudioRequirement,
  RecordingOutcomeV1,
  RecordingReasonCode,
  RecordingTerminalArtifactV1,
  RecordingTerminalEventV1,
  RecordingUiDispositionV1,
  RecordingWarningCode,
} from "@storycapture/shared-types";

export type RecordingOutcomeMode = "legacy" | "shadow" | "strict";

export interface RecordingOutcomeEvidenceV1 {
  session_id: string;
  automation?: RecordingOutcomeV1["automation"] | null;
  capture?: RecordingOutcomeV1["capture"] | null;
  artifact_readable?: boolean;
  cancelled_by?: "user" | "host" | null;
  terminal_evidence_version?: number;
  terminal_reason_code?: RecordingReasonCode | null;
  warnings?: readonly RecordingWarningCode[];
}

export interface RecordingStrictOutcomeEvidenceV1 extends RecordingOutcomeEvidenceV1 {
  terminal_evidence_version: 1;
  preflight_verdict: "pass" | "warn" | "block" | null;
  readiness: {
    source_ready: boolean;
    encoded_frames: number;
    tail_committed: boolean;
  } | null;
  health_verdict: "pass" | "degraded" | "fail" | null;
  av_verdict: "pass" | "degraded" | "fail" | null;
  audio_requirement: RecordingAudioRequirement;
  canonical_bundle_allocated: boolean;
  recovery_salvaged: boolean;
}

const FAILED_REASONS = new Set<RecordingReasonCode>([
  "encode_failed",
  "artifact_missing",
  "bundle_commit_failed",
  "readiness_failed",
  "capture_health_failed",
  "capture_target_lost",
  "required_audio_failed",
  "terminal_evidence_missing",
  "terminal_evidence_version_unsupported",
]);

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeWarnings(
  warnings: readonly RecordingWarningCode[] | undefined,
): RecordingWarningCode[] {
  return [...new Set(warnings ?? [])];
}

function missingAutomation(): RecordingOutcomeV1["automation"] {
  return {
    exit_reason: "failed",
    total_steps: 0,
    succeeded: 0,
    failed: 0,
    failed_ordinal: null,
  };
}

function normalizeAutomation(
  automation: RecordingOutcomeEvidenceV1["automation"],
): RecordingOutcomeV1["automation"] {
  if (!automation) return missingAutomation();
  const exitReason = ["completed", "failed", "cancelled", "paused"].includes(automation.exit_reason)
    ? automation.exit_reason
    : "failed";
  const failed = nonNegativeInteger(automation.failed);
  const failedOrdinal =
    automation.failed_ordinal == null
      ? null
      : nonNegativeInteger(automation.failed_ordinal) || null;
  return {
    exit_reason: exitReason,
    total_steps: nonNegativeInteger(automation.total_steps),
    succeeded: nonNegativeInteger(automation.succeeded),
    failed,
    failed_ordinal: failed > 0 ? failedOrdinal : null,
  };
}

function normalizeCapture(
  capture: RecordingOutcomeEvidenceV1["capture"],
): RecordingOutcomeV1["capture"] {
  return {
    output_path:
      typeof capture?.output_path === "string" && capture.output_path.length > 0
        ? capture.output_path
        : null,
    frames_written: nonNegativeInteger(capture?.frames_written),
    frames_dropped: nonNegativeInteger(capture?.frames_dropped),
    cadence_warning:
      typeof capture?.cadence_warning === "string" && capture.cadence_warning.length > 0
        ? capture.cadence_warning
        : null,
    finalized: capture?.finalized === true,
  };
}

export function recordingOutcomeMode(
  value = process.env.STORYCAPTURE_RECORDING_OUTCOME_MODE,
  legacyKillSwitch = process.env.STORYCAPTURE_RECORDING_OUTCOME_LEGACY_KILL_SWITCH,
): RecordingOutcomeMode {
  if (legacyKillSwitch === "1") return "legacy";
  return value === "shadow" || value === "strict" ? value : "legacy";
}

function outcome(
  evidence: RecordingOutcomeEvidenceV1,
  verdict: RecordingOutcomeV1["verdict"],
  reasonCode: RecordingReasonCode,
  warnings: readonly RecordingWarningCode[],
): RecordingOutcomeV1 {
  return {
    version: 1,
    session_id: evidence.session_id,
    verdict,
    reason_code: reasonCode,
    warnings: normalizeWarnings(warnings),
    automation: normalizeAutomation(evidence.automation),
    capture: normalizeCapture(evidence.capture),
  };
}

export function classifyStrictRecordingOutcome(
  evidence: RecordingStrictOutcomeEvidenceV1,
): RecordingOutcomeV1 {
  const automation = normalizeAutomation(evidence.automation);
  const capture = normalizeCapture(evidence.capture);
  const warnings = normalizeWarnings(evidence.warnings);
  if (evidence.cancelled_by || automation.exit_reason === "cancelled") {
    return outcome(
      evidence,
      "cancelled",
      evidence.cancelled_by === "user" ? "cancelled_by_user" : "cancelled_by_host",
      warnings,
    );
  }
  if (evidence.terminal_evidence_version !== 1) {
    return outcome(evidence, "failed", "terminal_evidence_version_unsupported", warnings);
  }
  if (evidence.terminal_reason_code && FAILED_REASONS.has(evidence.terminal_reason_code)) {
    return outcome(evidence, "failed", evidence.terminal_reason_code, warnings);
  }
  if (
    !evidence.automation ||
    !evidence.capture ||
    !evidence.preflight_verdict ||
    !evidence.readiness ||
    !evidence.health_verdict ||
    !evidence.av_verdict
  ) {
    return outcome(evidence, "failed", "terminal_evidence_missing", warnings);
  }
  if (!evidence.canonical_bundle_allocated) {
    return outcome(evidence, "failed", "bundle_commit_failed", warnings);
  }
  if (
    !capture.finalized ||
    !capture.output_path ||
    capture.frames_written === 0 ||
    evidence.artifact_readable !== true
  ) {
    return outcome(evidence, "failed", "artifact_missing", warnings);
  }
  if (
    !evidence.readiness.source_ready ||
    evidence.readiness.encoded_frames === 0 ||
    !evidence.readiness.tail_committed
  ) {
    return outcome(evidence, "failed", "readiness_failed", warnings);
  }
  if (evidence.health_verdict === "fail") {
    return outcome(evidence, "failed", "capture_health_failed", warnings);
  }
  if (automation.failed > 0 || automation.exit_reason === "failed") {
    return outcome(evidence, "repairable", "automation_failed", warnings);
  }
  if (evidence.recovery_salvaged) {
    return outcome(evidence, "repairable", "recovery_salvaged", warnings);
  }
  if (evidence.preflight_verdict !== "pass") {
    return outcome(evidence, "repairable", "preflight_warning", warnings);
  }
  if (
    evidence.health_verdict === "degraded" ||
    capture.frames_dropped > 0 ||
    Boolean(capture.cadence_warning)
  ) {
    return outcome(evidence, "repairable", "capture_degraded", warnings);
  }
  if (evidence.audio_requirement === "required" && evidence.av_verdict !== "pass") {
    return outcome(evidence, "repairable", "required_audio_failed", warnings);
  }
  if (evidence.audio_requirement === "optional" && evidence.av_verdict !== "pass") {
    warnings.push("optional_audio_failed");
  }
  return outcome(evidence, "passed", "passed", warnings);
}

export function recordingUiDisposition(
  outcomeValue: RecordingOutcomeV1,
  canonicalBundleCommitted: boolean,
): RecordingUiDispositionV1 {
  if (outcomeValue.verdict === "passed" && canonicalBundleCommitted) {
    return {
      show_complete: true,
      can_publish: true,
      auto_open_take: true,
      open_repair: false,
      retain_bundle: true,
    };
  }
  if (outcomeValue.verdict === "repairable" && canonicalBundleCommitted) {
    return {
      show_complete: false,
      can_publish: false,
      auto_open_take: false,
      open_repair: true,
      retain_bundle: true,
    };
  }
  return {
    show_complete: false,
    can_publish: false,
    auto_open_take: false,
    open_repair: false,
    retain_bundle: canonicalBundleCommitted,
  };
}

function terminalArtifact(
  result: Record<string, unknown> | null,
): RecordingTerminalArtifactV1 | null {
  if (typeof result?.output_path !== "string" || result.output_path.length === 0) return null;
  return {
    output_path: result.output_path,
    duration_ms: nonNegativeInteger(result.duration_ms),
    frame_count: nonNegativeInteger(result.frame_count),
    output_width: nonNegativeInteger(result.output_width),
    output_height: nonNegativeInteger(result.output_height),
  };
}

export function recordingTerminalEvent(
  outcomeValue: RecordingOutcomeV1,
  legacyResult: Record<string, unknown> | null,
  canonicalBundleCommitted: boolean,
): RecordingTerminalEventV1 {
  return {
    event: "terminal",
    version: 1,
    outcome: outcomeValue,
    disposition: recordingUiDisposition(outcomeValue, canonicalBundleCommitted),
    artifact: terminalArtifact(legacyResult),
  };
}

export function classifyRecordingOutcome(evidence: RecordingOutcomeEvidenceV1): RecordingOutcomeV1 {
  const automation = normalizeAutomation(evidence.automation);
  const capture = normalizeCapture(evidence.capture);
  const warnings = normalizeWarnings(evidence.warnings);

  let verdict: RecordingOutcomeV1["verdict"];
  let reasonCode: RecordingReasonCode;

  if (evidence.cancelled_by || automation.exit_reason === "cancelled") {
    verdict = "cancelled";
    reasonCode = evidence.cancelled_by === "user" ? "cancelled_by_user" : "cancelled_by_host";
  } else if (
    evidence.terminal_evidence_version !== undefined &&
    evidence.terminal_evidence_version !== 1
  ) {
    verdict = "failed";
    reasonCode = "terminal_evidence_version_unsupported";
  } else if (evidence.terminal_reason_code && FAILED_REASONS.has(evidence.terminal_reason_code)) {
    verdict = "failed";
    reasonCode = evidence.terminal_reason_code;
  } else if (!evidence.automation || !evidence.capture) {
    verdict = "failed";
    reasonCode = "terminal_evidence_missing";
  } else if (
    !capture.finalized ||
    !capture.output_path ||
    capture.frames_written === 0 ||
    evidence.artifact_readable !== true
  ) {
    verdict = "failed";
    reasonCode = "artifact_missing";
  } else if (automation.failed > 0 || automation.exit_reason === "failed") {
    verdict = "repairable";
    reasonCode = "automation_failed";
  } else if (evidence.terminal_reason_code === "recovery_salvaged") {
    verdict = "repairable";
    reasonCode = "recovery_salvaged";
  } else if (
    evidence.terminal_reason_code === "capture_degraded" ||
    capture.frames_dropped > 0 ||
    capture.cadence_warning
  ) {
    verdict = "repairable";
    reasonCode = "capture_degraded";
  } else {
    verdict = "passed";
    reasonCode =
      evidence.terminal_reason_code === "preflight_warning" ? "preflight_warning" : "passed";
  }

  return {
    version: 1,
    session_id: evidence.session_id,
    verdict,
    reason_code: reasonCode,
    warnings,
    automation,
    capture,
  };
}
