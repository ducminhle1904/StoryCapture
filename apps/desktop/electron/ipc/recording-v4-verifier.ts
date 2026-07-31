import {
  recordingV4AudioSyncPassed,
  recordingV4ExpectedFrameCount,
  recordingV4PtsUs,
  type RecordingV4AudioEvidence,
  type RecordingV4AudioRole,
  type RecordingV4CadenceEvidence,
  type RecordingV4EncoderEnvelope,
  type RecordingV4EncoderEvidence,
  type RecordingV4FailureCode,
  type RecordingV4QualityEvidence,
} from "@storycapture/shared-types/recording-v4";

export interface RecordingV4EncoderCalibration {
  source: RecordingV4EncoderEnvelope["source"];
  encoder_id: string;
  minimum_required_bitrate_bps: number;
  sustained_bitrate_bps: number;
  peak_bitrate_bps: number;
}

export function selectRecordingV4EncoderEnvelope(
  calibration: RecordingV4EncoderCalibration,
  safetyHeadroomRatio: number,
): RecordingV4EncoderEnvelope | null {
  if (!Number.isSafeInteger(calibration.minimum_required_bitrate_bps) ||
    !Number.isSafeInteger(calibration.sustained_bitrate_bps) ||
    !Number.isSafeInteger(calibration.peak_bitrate_bps) ||
    calibration.minimum_required_bitrate_bps <= 0 || calibration.sustained_bitrate_bps <= 0 ||
    calibration.peak_bitrate_bps < calibration.sustained_bitrate_bps ||
    typeof safetyHeadroomRatio !== "number" || safetyHeadroomRatio <= 0 || safetyHeadroomRatio >= 1 ||
    !calibration.encoder_id) return null;
  const target = Math.floor(calibration.sustained_bitrate_bps * (1 - safetyHeadroomRatio));
  if (target < calibration.minimum_required_bitrate_bps) return null;
  return {
    source: calibration.source,
    encoder_id: calibration.encoder_id,
    minimum_bitrate_bps: calibration.minimum_required_bitrate_bps,
    target_bitrate_bps: target,
    maximum_bitrate_bps: calibration.peak_bitrate_bps,
    safety_headroom_ratio: safetyHeadroomRatio,
  };
}

function uniqueFailures(failures: RecordingV4FailureCode[]): RecordingV4FailureCode[] {
  return [...new Set(failures)];
}

export function verifyRecordingV4Cadence(
  evidence: RecordingV4CadenceEvidence,
): RecordingV4FailureCode[] {
  const failures: RecordingV4FailureCode[] = [];
  const expected = recordingV4ExpectedFrameCount(evidence.active_duration_us);
  if (evidence.expected_output_frames !== expected || evidence.output_frames !== expected ||
    evidence.submitted_frames !== expected || evidence.acknowledged_frames !== expected) {
    failures.push("output_frame_count_mismatch");
  }
  if (evidence.ledger.length !== expected ||
    evidence.ledger.filter((entry) => entry.held_from_slot !== null).length !== evidence.held_frames ||
    evidence.source_updates + evidence.held_frames !== expected) failures.push("frame_ledger_invalid");
  for (let slot = 0; slot < evidence.ledger.length; slot += 1) {
    const entry = evidence.ledger[slot];
    if (entry.slot !== slot || entry.pts_us !== recordingV4PtsUs(slot) ||
      entry.acknowledged_at_us < entry.submitted_at_us) failures.push("output_pts_invalid");
    if (entry.held_from_slot !== null && (entry.held_from_slot >= slot ||
      evidence.ledger[entry.held_from_slot]?.source_sequence !== entry.source_sequence)) {
      failures.push("frame_ledger_invalid");
    }
  }
  return uniqueFailures([...failures, ...evidence.failure_codes]);
}

export function verifyRecordingV4Encoder(
  evidence: RecordingV4EncoderEvidence,
): RecordingV4FailureCode[] {
  const envelope = evidence.envelope;
  return evidence.hardware_accelerated && evidence.encoder_id === envelope.encoder_id &&
    evidence.requested_bitrate_bps === envelope.target_bitrate_bps &&
    evidence.average_bitrate_bps >= envelope.minimum_bitrate_bps &&
    evidence.average_bitrate_bps <= envelope.maximum_bitrate_bps &&
    evidence.peak_bitrate_bps >= evidence.average_bitrate_bps &&
    evidence.peak_bitrate_bps <= envelope.maximum_bitrate_bps
    ? [] : ["bitrate_outside_envelope"];
}

export function verifyRecordingV4Audio(
  requestedRoles: readonly RecordingV4AudioRole[],
  evidence: readonly RecordingV4AudioEvidence[],
  activeDurationUs: number,
): RecordingV4FailureCode[] {
  const failures: RecordingV4FailureCode[] = [];
  const requested = [...new Set(requestedRoles)].sort();
  const provided = evidence.map((item) => item.role).sort();
  if (JSON.stringify(requested) !== JSON.stringify(provided)) failures.push("audio_device_unavailable");
  for (const audio of evidence) {
    if (audio.status !== "captured" || audio.sample_rate_hz <= 0 || audio.channels <= 0 ||
      !["pcm_f32le", "pcm_s16le", "aac"].includes(audio.codec)) failures.push("audio_format_invalid");
    if (audio.continuity_gaps !== 0 || audio.ledger.length === 0) failures.push("audio_continuity_failed");
    if (!audio.pause_mapping_valid || !recordingV4AudioSyncPassed(
      audio.started_offset_us, audio.end_drift_us, audio.sync_tolerance_us,
    ) || Math.abs(audio.duration_us - activeDurationUs) > audio.sync_tolerance_us) {
      failures.push("audio_sync_failed");
    }
    failures.push(...audio.failure_codes);
  }
  return uniqueFailures(failures);
}

export function verifyRecordingV4Quality(
  evidence: RecordingV4QualityEvidence,
  requiredReferenceIds: readonly string[],
): RecordingV4FailureCode[] {
  const ids = new Set(evidence.checkpoints.map((checkpoint) => checkpoint.reference_id));
  const metricsPass = evidence.checkpoints.every((checkpoint) =>
    checkpoint.full_frame_luma_ssim.passed && checkpoint.text_edge_roi_ssim.passed &&
    checkpoint.edge_spread_increase_px.passed && checkpoint.color_channel_delta.passed);
  return evidence.verdict === "passed" && evidence.failure_codes.length === 0 && metricsPass &&
    requiredReferenceIds.every((id) => ids.has(id))
    ? [] : uniqueFailures(["quality_checkpoint_failed", ...evidence.failure_codes]);
}
