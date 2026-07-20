import type {
  RecordingCadenceEvidenceV2,
  RecordingQualityFailureCode,
  RecordingRational,
} from "@storycapture/shared-types/recording-v2";

import type { RecordingProbeResult } from "./media-probe";

export type RecordingCadenceObservationV2 = Omit<
  RecordingCadenceEvidenceV2,
  "verdict" | "failure_codes"
> & {
  failure_codes?: readonly RecordingQualityFailureCode[];
};

export interface RecordingArtifactExpectation {
  width: number;
  height: number;
  codec?: string;
}

function addFailureCode(
  failureCodes: RecordingQualityFailureCode[],
  code: RecordingQualityFailureCode,
): void {
  if (!failureCodes.includes(code)) failureCodes.push(code);
}

export function rationalsEqual(
  left: RecordingRational | null,
  right: RecordingRational | null,
): boolean {
  if (!left || !right || left.denominator === 0 || right.denominator === 0) return false;
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

export function expectedStrictFrameSlots(activeDurationUs: number, fps: RecordingRational): number {
  if (
    !Number.isFinite(activeDurationUs) ||
    activeDurationUs < 0 ||
    !Number.isSafeInteger(fps.numerator) ||
    !Number.isSafeInteger(fps.denominator) ||
    fps.numerator <= 0 ||
    fps.denominator <= 0
  ) {
    throw new Error("Cadence duration and frame rate must be finite positive contract values.");
  }
  return Math.ceil((activeDurationUs * fps.numerator) / (1_000_000 * fps.denominator));
}

export function probePtsAnomalies(
  probe: Extract<RecordingProbeResult, { status: "valid" }>,
  requestedFps: RecordingRational,
): { pts_gaps: number; pts_duplicates: number } {
  const expectedSeconds = requestedFps.denominator / requestedFps.numerator;
  const tickSeconds = probe.stream_time_base
    ? probe.stream_time_base.numerator / probe.stream_time_base.denominator
    : 0;
  let ptsGaps = 0;
  let ptsDuplicates = 0;
  let previousSeconds: number | null = null;
  for (const frame of probe.frames) {
    const currentSeconds =
      frame.best_effort_timestamp_time_seconds ??
      frame.pts_time_seconds ??
      (frame.best_effort_timestamp !== null && probe.stream_time_base
        ? frame.best_effort_timestamp * tickSeconds
        : frame.pts !== null && probe.stream_time_base
          ? frame.pts * tickSeconds
          : null);
    if (currentSeconds === null) continue;
    if (previousSeconds !== null) {
      const delta = currentSeconds - previousSeconds;
      if (delta <= Math.max(Number.EPSILON, tickSeconds / 2)) ptsDuplicates += 1;
      else if (delta > expectedSeconds + Math.max(1e-9, tickSeconds / 2)) ptsGaps += 1;
    }
    previousSeconds = currentSeconds;
  }
  return { pts_gaps: ptsGaps, pts_duplicates: ptsDuplicates };
}

export function applyProbeToCadenceObservation(
  observation: RecordingCadenceObservationV2,
  probe: RecordingProbeResult,
  expectation: RecordingArtifactExpectation,
): RecordingCadenceObservationV2 {
  const failureCodes = [...(observation.failure_codes ?? [])];
  if (probe.status === "invalid") {
    addFailureCode(failureCodes, "artifact_probe_failed");
    if (probe.reason === "timeout") addFailureCode(failureCodes, "verification_timeout");
    return {
      ...observation,
      full_decode_succeeded: false,
      failure_codes: failureCodes,
    };
  }

  const pts = probePtsAnomalies(probe, observation.requested_fps);
  if (
    !rationalsEqual(probe.real_frame_rate, observation.requested_fps) ||
    !rationalsEqual(probe.average_frame_rate, observation.requested_fps)
  ) {
    addFailureCode(failureCodes, "source_rate_mismatch");
  }
  if (!probe.stream_time_base) addFailureCode(failureCodes, "artifact_probe_failed");
  if (probe.counted_frames === null) {
    addFailureCode(failureCodes, "artifact_probe_failed");
  } else if (probe.counted_frames !== observation.expected_slots) {
    addFailureCode(failureCodes, "artifact_frame_count_mismatch");
  }
  if (
    probe.counted_frames !== null &&
    (probe.frames.length !== probe.counted_frames ||
      probe.frames.some(
        (frame) =>
          (frame.best_effort_timestamp_time_seconds === null && frame.pts_time_seconds === null) ||
          frame.duration_time_seconds === null,
      ))
  ) {
    addFailureCode(failureCodes, "artifact_probe_failed");
  }
  if (
    probe.declared_frames !== null &&
    probe.counted_frames !== null &&
    probe.declared_frames !== probe.counted_frames
  ) {
    addFailureCode(failureCodes, "artifact_frame_count_mismatch");
  }
  if (pts.pts_gaps > 0) addFailureCode(failureCodes, "artifact_pts_gap");
  if (pts.pts_duplicates > 0) addFailureCode(failureCodes, "artifact_pts_duplicate");
  if (!probe.full_decode_succeeded) addFailureCode(failureCodes, "artifact_decode_failed");
  if (probe.width !== expectation.width || probe.height !== expectation.height) {
    addFailureCode(failureCodes, "artifact_resolution_mismatch");
  }
  if (expectation.codec && probe.codec.toLowerCase() !== expectation.codec.toLowerCase()) {
    addFailureCode(failureCodes, "artifact_codec_mismatch");
  }
  const expectedDurationMs = observation.active_duration_us / 1000;
  const frameDurationMs =
    (observation.requested_fps.denominator * 1000) / observation.requested_fps.numerator;
  if (probe.duration_ms !== null && probe.duration_ms + frameDurationMs / 2 < expectedDurationMs) {
    addFailureCode(failureCodes, "artifact_truncated");
  }

  return {
    ...observation,
    stream_time_base: probe.stream_time_base,
    artifact_decoded_frames: probe.counted_frames ?? observation.artifact_decoded_frames,
    pts_gaps: observation.pts_gaps + pts.pts_gaps,
    pts_duplicates: observation.pts_duplicates + pts.pts_duplicates,
    full_decode_succeeded: probe.full_decode_succeeded,
    failure_codes: failureCodes,
  };
}

export function verifyRecordingCadence(
  observation: RecordingCadenceObservationV2,
): RecordingCadenceEvidenceV2 {
  const failureCodes = [...(observation.failure_codes ?? [])];
  const add = (code: RecordingQualityFailureCode) => addFailureCode(failureCodes, code);

  if (!rationalsEqual(observation.requested_fps, { numerator: 60, denominator: 1 })) {
    add("contract_mismatch");
  }
  if (!rationalsEqual(observation.source_fps, observation.requested_fps)) {
    add("source_rate_mismatch");
  }
  let calculatedSlots: number | null = null;
  try {
    calculatedSlots = expectedStrictFrameSlots(
      observation.active_duration_us,
      observation.requested_fps,
    );
  } catch {
    add("contract_mismatch");
  }
  if (calculatedSlots === null || calculatedSlots !== observation.expected_slots) {
    add("contract_mismatch");
  }
  if (observation.source_presentations !== observation.expected_slots) {
    add("source_sequence_missing");
  }
  if (observation.source_sequence_gaps > 0) add("source_sequence_gap");
  if (observation.stale_reuses > 0) add("source_stale_reuse");
  if (
    observation.submitted_frames !== observation.expected_slots ||
    observation.skipped_slots > 0
  ) {
    add("scheduled_slot_skipped");
  }
  if (
    observation.encoder_acked_frames !== observation.submitted_frames ||
    observation.dropped_frames > 0
  ) {
    add("submitted_frame_dropped");
  }
  if (observation.deadline_misses > 0) add("encoder_deadline_missed");
  if (observation.ring_overflows > 0) add("frame_ring_overflow");
  if (observation.artifact_decoded_frames !== observation.encoder_acked_frames) {
    add("artifact_frame_count_mismatch");
  }
  if (observation.pts_gaps > 0) add("artifact_pts_gap");
  if (observation.pts_duplicates > 0) add("artifact_pts_duplicate");
  if (!observation.full_decode_succeeded) add("artifact_decode_failed");

  return {
    ...observation,
    failure_codes: failureCodes,
    verdict: failureCodes.length === 0 ? "passed" : "failed",
  };
}

export function firstStickyCadenceFailure(
  evidence: RecordingCadenceEvidenceV2,
): RecordingQualityFailureCode | null {
  return evidence.failure_codes[0] ?? null;
}
