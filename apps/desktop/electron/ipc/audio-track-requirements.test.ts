import { describe, expect, it } from "vitest";
import { classifyStrictRecordingOutcome } from "./recording-outcome";

function evidence(audioRequirement: "required" | "optional", avVerdict: "pass" | "fail") {
  return {
    terminal_evidence_version: 1 as const,
    session_id: "session-1",
    automation: {
      exit_reason: "completed" as const,
      total_steps: 1,
      succeeded: 1,
      failed: 0,
      failed_ordinal: null,
    },
    capture: {
      output_path: "/take/video.mp4",
      frames_written: 30,
      frames_dropped: 0,
      cadence_warning: null,
      finalized: true,
    },
    artifact_readable: true,
    cancelled_by: null,
    preflight_verdict: "pass" as const,
    readiness: { source_ready: true, encoded_frames: 30, tail_committed: true },
    health_verdict: "pass" as const,
    av_verdict: avVerdict,
    audio_requirement: audioRequirement,
    canonical_bundle_allocated: true,
    recovery_salvaged: false,
  };
}

describe("multitrack requirement outcome policy", () => {
  it("makes required audio failure repairable", () => {
    expect(classifyStrictRecordingOutcome(evidence("required", "fail"))).toMatchObject({
      verdict: "repairable",
      reason_code: "required_audio_failed",
    });
  });

  it("keeps optional audio failure passing with a warning", () => {
    expect(classifyStrictRecordingOutcome(evidence("optional", "fail"))).toMatchObject({
      verdict: "passed",
      warnings: ["optional_audio_failed"],
    });
  });
});
