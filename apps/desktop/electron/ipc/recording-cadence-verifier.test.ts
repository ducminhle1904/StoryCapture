import { describe, expect, it } from "vitest";

import type { RecordingProbeResult } from "./media-probe";
import {
  applyProbeToCadenceObservation,
  firstStickyCadenceFailure,
  probePtsAnomalies,
  verifyRecordingCadence,
} from "./recording-cadence-verifier";
import {
  createPassingCadenceObservation,
  injectArtifactFault,
  injectCadenceFault,
  type RecordingCadenceFault,
} from "./recording-verifier-faults";

const cadenceFaults: Array<[RecordingCadenceFault, string]> = [
  ["missing_source_sequence", "source_sequence_missing"],
  ["source_sequence_gap", "source_sequence_gap"],
  ["stale_reuse", "source_stale_reuse"],
  ["scheduled_skip", "scheduled_slot_skipped"],
  ["submitted_drop", "submitted_frame_dropped"],
  ["ring_overflow", "frame_ring_overflow"],
  ["backpressure_deadline_miss", "encoder_deadline_missed"],
  ["pts_gap", "artifact_pts_gap"],
  ["pts_duplicate", "artifact_pts_duplicate"],
  ["source_59_94", "source_rate_mismatch"],
];

function passingProbe(): Extract<RecordingProbeResult, { status: "valid" }> {
  return {
    status: "valid",
    duration_ms: 200,
    width: 1920,
    height: 1080,
    codec: "ffv1",
    profile: null,
    pixel_format: "bgra",
    color: { range: "pc", space: "gbr", transfer: null, primaries: null },
    container: "matroska",
    bitrate: 40_000_000,
    real_frame_rate: { numerator: 60, denominator: 1 },
    average_frame_rate: { numerator: 60, denominator: 1 },
    stream_time_base: { numerator: 1, denominator: 60_000 },
    declared_frames: 12,
    counted_frames: 12,
    frames: Array.from({ length: 12 }, (_, index) => ({
      index,
      pts: index * 1000,
      pts_time_seconds: index / 60,
      duration: 1000,
      duration_time_seconds: 1 / 60,
      best_effort_timestamp: index * 1000,
      best_effort_timestamp_time_seconds: index / 60,
    })),
    full_decode_succeeded: true,
  };
}

describe("recording cadence verifier", () => {
  it("passes only when all strict counters and the full artifact decode agree", () => {
    const evidence = verifyRecordingCadence(createPassingCadenceObservation(300));

    expect(evidence.verdict).toBe("passed");
    expect(evidence.failure_codes).toEqual([]);
    expect(evidence.expected_slots).toBe(300);
  });

  it.each(cadenceFaults)("rejects the %s fault with sticky code %s", (fault, code) => {
    const first = verifyRecordingCadence(
      injectCadenceFault(createPassingCadenceObservation(), fault),
    );
    expect(first.verdict).toBe("failed");
    expect(first.failure_codes).toContain(code);

    const later = verifyRecordingCadence({
      ...createPassingCadenceObservation(),
      failure_codes: first.failure_codes,
      stale_reuses: 1,
    });
    expect(firstStickyCadenceFailure(later)).toBe(first.failure_codes[0]);
    expect(later.failure_codes).toContain("source_stale_reuse");
  });

  it("keeps backpressure diagnostic-only until it causes a deadline miss", () => {
    const evidence = verifyRecordingCadence({
      ...createPassingCadenceObservation(),
      backpressure_events: 3,
    });
    expect(evidence.verdict).toBe("passed");
  });

  it("derives PTS gaps and duplicates from every probed frame", () => {
    const probe = passingProbe();
    probe.frames[4] = {
      ...probe.frames[4],
      pts: probe.frames[3].pts,
      pts_time_seconds: probe.frames[3].pts_time_seconds,
      best_effort_timestamp: probe.frames[3].best_effort_timestamp,
      best_effort_timestamp_time_seconds: probe.frames[3].best_effort_timestamp_time_seconds,
    };
    probe.frames[8] = {
      ...probe.frames[8],
      pts: 10_000,
      pts_time_seconds: 10 / 60,
      best_effort_timestamp: 10_000,
      best_effort_timestamp_time_seconds: 10 / 60,
    };

    expect(probePtsAnomalies(probe, { numerator: 60, denominator: 1 })).toEqual({
      pts_gaps: 2,
      pts_duplicates: 2,
    });
  });

  it.each([
    ["truncation", "artifact_truncated"],
    ["resolution_mismatch", "artifact_resolution_mismatch"],
  ] as const)("rejects the %s artifact fault", (fault, expectedCode) => {
    const observation = createPassingCadenceObservation(12);
    const probed = applyProbeToCadenceObservation(
      observation,
      injectArtifactFault(passingProbe(), fault),
      { width: 1920, height: 1080, codec: "ffv1" },
    );
    const evidence = verifyRecordingCadence(probed);

    expect(evidence.failure_codes).toContain(expectedCode);
    expect(evidence.verdict).toBe("failed");
  });

  it("rejects an invalid probe without manufacturing artifact metadata", () => {
    const observation = applyProbeToCadenceObservation(
      createPassingCadenceObservation(12),
      { status: "invalid", reason: "unsupported_or_corrupt" },
      { width: 1920, height: 1080 },
    );
    const evidence = verifyRecordingCadence(observation);
    expect(evidence.failure_codes).toContain("artifact_probe_failed");
    expect(evidence.failure_codes).toContain("artifact_decode_failed");
  });

  it("proves nominal metadata and counts cannot hide a failed full decode", () => {
    const probe = { ...passingProbe(), full_decode_succeeded: false };
    const observation = applyProbeToCadenceObservation(createPassingCadenceObservation(12), probe, {
      width: 1920,
      height: 1080,
      codec: "ffv1",
    });
    const evidence = verifyRecordingCadence(observation);

    expect(probe).toMatchObject({
      width: 1920,
      height: 1080,
      counted_frames: 12,
      real_frame_rate: { numerator: 60, denominator: 1 },
    });
    expect(evidence.failure_codes).toEqual(["artifact_decode_failed"]);
    expect(evidence.verdict).toBe("failed");
  });
});
