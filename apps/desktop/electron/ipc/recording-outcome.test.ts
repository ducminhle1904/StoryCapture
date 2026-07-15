import { describe, expect, it } from "vitest";
import {
  classifyRecordingOutcome,
  classifyStrictRecordingOutcome,
  type RecordingOutcomeEvidenceV1,
  type RecordingStrictOutcomeEvidenceV1,
  recordingOutcomeMode,
  recordingTerminalEvent,
  recordingUiDisposition,
} from "./recording-outcome";

function healthyEvidence(
  overrides: Partial<RecordingOutcomeEvidenceV1> = {},
): RecordingOutcomeEvidenceV1 {
  return {
    session_id: "session-1",
    artifact_readable: true,
    automation: {
      exit_reason: "completed",
      total_steps: 2,
      succeeded: 2,
      failed: 0,
      failed_ordinal: null,
    },
    capture: {
      output_path: "/tmp/video.mp4",
      frames_written: 60,
      frames_dropped: 0,
      cadence_warning: null,
      finalized: true,
    },
    ...overrides,
  };
}

function healthyAutomation(): NonNullable<RecordingOutcomeEvidenceV1["automation"]> {
  const automation = healthyEvidence().automation;
  if (!automation) throw new Error("healthy evidence must include automation");
  return automation;
}

function healthyCapture(): NonNullable<RecordingOutcomeEvidenceV1["capture"]> {
  const capture = healthyEvidence().capture;
  if (!capture) throw new Error("healthy evidence must include capture");
  return capture;
}

function healthyStrictEvidence(
  overrides: Partial<RecordingStrictOutcomeEvidenceV1> = {},
): RecordingStrictOutcomeEvidenceV1 {
  return {
    ...healthyEvidence(),
    terminal_evidence_version: 1,
    preflight_verdict: "pass",
    readiness: {
      source_ready: true,
      encoded_frames: 60,
      tail_committed: true,
    },
    health_verdict: "pass",
    av_verdict: "pass",
    audio_requirement: "none",
    canonical_bundle_allocated: true,
    recovery_salvaged: false,
    ...overrides,
  };
}

describe("recording outcome classifier", () => {
  it("passes only complete automation with a readable finalized artifact", () => {
    expect(classifyRecordingOutcome(healthyEvidence())).toMatchObject({
      verdict: "passed",
      reason_code: "passed",
    });
  });

  it("keeps a finalized artifact repairable after an automation failure", () => {
    const evidence = healthyEvidence();
    evidence.automation = {
      ...healthyAutomation(),
      exit_reason: "failed",
      failed: 1,
      failed_ordinal: 2,
    };
    expect(classifyRecordingOutcome(evidence)).toMatchObject({
      verdict: "repairable",
      reason_code: "automation_failed",
      automation: { failed_ordinal: 2 },
    });
  });

  it("lets cancellation win over finalizer and automation failures", () => {
    expect(
      classifyRecordingOutcome(
        healthyEvidence({
          cancelled_by: "user",
          terminal_reason_code: "encode_failed",
        }),
      ),
    ).toMatchObject({ verdict: "cancelled", reason_code: "cancelled_by_user" });
  });

  it.each([
    "encode_failed",
    "artifact_missing",
    "bundle_commit_failed",
    "readiness_failed",
    "required_audio_failed",
    "terminal_evidence_missing",
  ] as const)("maps %s to a failed verdict", (terminalReason) => {
    expect(
      classifyRecordingOutcome(healthyEvidence({ terminal_reason_code: terminalReason })),
    ).toMatchObject({ verdict: "failed", reason_code: terminalReason });
  });

  it("rejects unsupported terminal evidence versions", () => {
    expect(
      classifyRecordingOutcome(healthyEvidence({ terminal_evidence_version: 2 })),
    ).toMatchObject({
      verdict: "failed",
      reason_code: "terminal_evidence_version_unsupported",
    });
  });

  it("classifies missing evidence and clamps malformed counters", () => {
    const outcome = classifyRecordingOutcome({
      session_id: "session-1",
      automation: null,
      capture: null,
    });
    expect(outcome).toMatchObject({
      verdict: "failed",
      reason_code: "terminal_evidence_missing",
      automation: { failed: 0 },
      capture: { frames_written: 0 },
    });
  });

  it("classifies degraded and recovered artifacts as repairable", () => {
    expect(
      classifyRecordingOutcome(
        healthyEvidence({
          capture: { ...healthyCapture(), frames_dropped: 1 },
        }),
      ),
    ).toMatchObject({ verdict: "repairable", reason_code: "capture_degraded" });
    expect(
      classifyRecordingOutcome(healthyEvidence({ terminal_reason_code: "recovery_salvaged" })),
    ).toMatchObject({ verdict: "repairable", reason_code: "recovery_salvaged" });
  });

  it("preserves a non-blocking preflight reason and de-duplicates warnings", () => {
    expect(
      classifyRecordingOutcome(
        healthyEvidence({
          terminal_reason_code: "preflight_warning",
          warnings: ["optional_audio_failed", "optional_audio_failed"],
        }),
      ),
    ).toMatchObject({
      verdict: "passed",
      reason_code: "preflight_warning",
      warnings: ["optional_audio_failed"],
    });
  });

  it("defaults unknown rollout values to legacy", () => {
    expect(recordingOutcomeMode("legacy")).toBe("legacy");
    expect(recordingOutcomeMode("shadow")).toBe("shadow");
    expect(recordingOutcomeMode("strict")).toBe("strict");
    expect(recordingOutcomeMode("unexpected")).toBe("legacy");
  });
});

describe("strict recording outcome decision table", () => {
  it("passes only when every strict gate is healthy", () => {
    expect(classifyStrictRecordingOutcome(healthyStrictEvidence())).toEqual({
      version: 1,
      session_id: "session-1",
      verdict: "passed",
      reason_code: "passed",
      warnings: [],
      automation: healthyEvidence().automation,
      capture: healthyEvidence().capture,
    });
  });

  it.each([
    ["user", "cancelled_by_user"],
    ["host", "cancelled_by_host"],
  ] as const)("lets explicit %s cancellation win over every failed gate", (actor, reasonCode) => {
    const outcome = classifyStrictRecordingOutcome(
      healthyStrictEvidence({
        cancelled_by: actor,
        terminal_reason_code: "bundle_commit_failed",
        artifact_readable: false,
        canonical_bundle_allocated: false,
        health_verdict: "fail",
        av_verdict: "fail",
      }),
    );

    expect(outcome).toMatchObject({
      verdict: "cancelled",
      reason_code: reasonCode,
    });
  });

  const missingGateCases: Array<[string, Partial<RecordingStrictOutcomeEvidenceV1>]> = [
    ["automation", { automation: null }],
    ["capture", { capture: null }],
    ["preflight", { preflight_verdict: null }],
    ["readiness", { readiness: null }],
    ["health", { health_verdict: null }],
    ["A/V", { av_verdict: null }],
  ];

  it.each(missingGateCases)("fails when %s evidence is missing", (_gate, overrides) => {
    expect(classifyStrictRecordingOutcome(healthyStrictEvidence(overrides))).toMatchObject({
      verdict: "failed",
      reason_code: "terminal_evidence_missing",
    });
  });

  it("fails unsupported terminal evidence versions", () => {
    const evidence = {
      ...healthyStrictEvidence(),
      terminal_evidence_version: 2,
    } as unknown as RecordingStrictOutcomeEvidenceV1;

    expect(classifyStrictRecordingOutcome(evidence)).toMatchObject({
      verdict: "failed",
      reason_code: "terminal_evidence_version_unsupported",
    });
  });

  const failedGateCases: Array<[string, Partial<RecordingStrictOutcomeEvidenceV1>, string]> = [
    ["canonical bundle allocation", { canonical_bundle_allocated: false }, "bundle_commit_failed"],
    ["readable artifact", { artifact_readable: false }, "artifact_missing"],
    [
      "finalized capture",
      { capture: { ...healthyCapture(), finalized: false } },
      "artifact_missing",
    ],
    [
      "source readiness",
      {
        readiness: {
          source_ready: false,
          encoded_frames: 60,
          tail_committed: true,
        },
      },
      "readiness_failed",
    ],
    [
      "encoded-frame readiness",
      {
        readiness: {
          source_ready: true,
          encoded_frames: 0,
          tail_committed: true,
        },
      },
      "readiness_failed",
    ],
    [
      "tail readiness",
      {
        readiness: {
          source_ready: true,
          encoded_frames: 60,
          tail_committed: false,
        },
      },
      "readiness_failed",
    ],
    ["capture health", { health_verdict: "fail" }, "capture_health_failed"],
    ["capture target loss", { terminal_reason_code: "capture_target_lost" }, "capture_target_lost"],
    ["final encode", { terminal_reason_code: "encode_failed" }, "encode_failed"],
    [
      "bundle publication",
      { terminal_reason_code: "bundle_commit_failed" },
      "bundle_commit_failed",
    ],
  ];

  it.each(failedGateCases)("fails the %s gate", (_gate, overrides, reasonCode) => {
    expect(classifyStrictRecordingOutcome(healthyStrictEvidence(overrides))).toMatchObject({
      verdict: "failed",
      reason_code: reasonCode,
    });
  });

  const repairableCases: Array<[string, Partial<RecordingStrictOutcomeEvidenceV1>, string]> = [
    [
      "automation failure",
      {
        automation: {
          exit_reason: "failed",
          total_steps: 2,
          succeeded: 1,
          failed: 1,
          failed_ordinal: 2,
        },
      },
      "automation_failed",
    ],
    ["recovery salvage", { recovery_salvaged: true }, "recovery_salvaged"],
    ["accepted preflight warning", { preflight_verdict: "warn" }, "preflight_warning"],
    ["degraded capture health", { health_verdict: "degraded" }, "capture_degraded"],
    [
      "dropped capture frames",
      { capture: { ...healthyCapture(), frames_dropped: 1 } },
      "capture_degraded",
    ],
  ];

  it.each(
    repairableCases,
  )("keeps a usable bundle repairable after %s", (_case, overrides, reasonCode) => {
    expect(classifyStrictRecordingOutcome(healthyStrictEvidence(overrides))).toMatchObject({
      verdict: "repairable",
      reason_code: reasonCode,
    });
  });

  it("makes required audio failure repairable only while video remains usable", () => {
    expect(
      classifyStrictRecordingOutcome(
        healthyStrictEvidence({
          audio_requirement: "required",
          av_verdict: "fail",
        }),
      ),
    ).toMatchObject({
      verdict: "repairable",
      reason_code: "required_audio_failed",
    });

    expect(
      classifyStrictRecordingOutcome(
        healthyStrictEvidence({
          artifact_readable: false,
          audio_requirement: "required",
          av_verdict: "fail",
        }),
      ),
    ).toMatchObject({
      verdict: "failed",
      reason_code: "artifact_missing",
    });
  });

  it("allows optional audio failure to warn without hiding an independent failure", () => {
    expect(
      classifyStrictRecordingOutcome(
        healthyStrictEvidence({
          audio_requirement: "optional",
          av_verdict: "fail",
        }),
      ),
    ).toMatchObject({
      verdict: "passed",
      reason_code: "passed",
      warnings: ["optional_audio_failed"],
    });

    expect(
      classifyStrictRecordingOutcome(
        healthyStrictEvidence({
          audio_requirement: "optional",
          av_verdict: "fail",
          health_verdict: "fail",
        }),
      ),
    ).toMatchObject({
      verdict: "failed",
      reason_code: "capture_health_failed",
    });
  });

  it("lets the independent legacy kill switch override configured outcome modes", () => {
    expect(recordingOutcomeMode("strict", "1")).toBe("legacy");
    expect(recordingOutcomeMode("shadow", "1")).toBe("legacy");
    expect(recordingOutcomeMode("strict", "0")).toBe("strict");
    expect(recordingOutcomeMode("shadow", "0")).toBe("shadow");
  });

  it.each([
    [
      "passed",
      healthyStrictEvidence(),
      true,
      {
        show_complete: true,
        can_publish: true,
        auto_open_take: true,
        open_repair: false,
        retain_bundle: true,
      },
    ],
    [
      "passed without a committed bundle",
      healthyStrictEvidence(),
      false,
      {
        show_complete: false,
        can_publish: false,
        auto_open_take: false,
        open_repair: false,
        retain_bundle: false,
      },
    ],
    [
      "repairable",
      healthyStrictEvidence({ recovery_salvaged: true }),
      true,
      {
        show_complete: false,
        can_publish: false,
        auto_open_take: false,
        open_repair: true,
        retain_bundle: true,
      },
    ],
    [
      "repairable without a committed bundle",
      healthyStrictEvidence({ recovery_salvaged: true }),
      false,
      {
        show_complete: false,
        can_publish: false,
        auto_open_take: false,
        open_repair: false,
        retain_bundle: false,
      },
    ],
    [
      "failed without a canonical bundle",
      healthyStrictEvidence({ artifact_readable: false }),
      false,
      {
        show_complete: false,
        can_publish: false,
        auto_open_take: false,
        open_repair: false,
        retain_bundle: false,
      },
    ],
    [
      "failed with a diagnostic bundle",
      healthyStrictEvidence({ health_verdict: "fail" }),
      true,
      {
        show_complete: false,
        can_publish: false,
        auto_open_take: false,
        open_repair: false,
        retain_bundle: true,
      },
    ],
    [
      "cancelled without a committed bundle",
      healthyStrictEvidence({ cancelled_by: "user" }),
      false,
      {
        show_complete: false,
        can_publish: false,
        auto_open_take: false,
        open_repair: false,
        retain_bundle: false,
      },
    ],
    [
      "cancelled with a committed bundle",
      healthyStrictEvidence({ cancelled_by: "host" }),
      true,
      {
        show_complete: false,
        can_publish: false,
        auto_open_take: false,
        open_repair: false,
        retain_bundle: true,
      },
    ],
  ] as const)("maps $0 to its exact UI disposition", (_case, evidence, committed, expected) => {
    const outcome = classifyStrictRecordingOutcome(evidence);
    expect(recordingUiDisposition(outcome, committed)).toEqual(expected);
  });

  it("maps the authoritative outcome and artifact into one terminal event", () => {
    const outcome = classifyStrictRecordingOutcome(healthyStrictEvidence());
    const terminal = recordingTerminalEvent(
      outcome,
      {
        output_path: "/tmp/video.mp4",
        duration_ms: 2_000,
        frame_count: 60,
        output_width: 1920,
        output_height: 1080,
      },
      true,
    );

    expect(terminal).toEqual({
      event: "terminal",
      version: 1,
      outcome,
      disposition: {
        show_complete: true,
        can_publish: true,
        auto_open_take: true,
        open_repair: false,
        retain_bundle: true,
      },
      artifact: {
        output_path: "/tmp/video.mp4",
        duration_ms: 2_000,
        frame_count: 60,
        output_width: 1920,
        output_height: 1080,
      },
    });

    expect(recordingTerminalEvent(outcome, null, true).artifact).toBeNull();
  });
});
