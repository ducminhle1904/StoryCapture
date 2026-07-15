import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateRecordingRepair,
  RecordingRepairController,
  recordingRepairAllowedActions,
  recordingRepairController,
  recordingRepairControllerForSession,
} from "./recording-repair";

afterEach(() => {
  invalidateRecordingRepair("managed-session");
  vi.unstubAllEnvs();
});

function request(
  phase: "pre_input" | "input_emitted_presentation_pending" | "post_input_failed" = "pre_input",
) {
  return {
    session_id: "session-1",
    scene_id: "scene-1",
    step_id: "step-1",
    ordinal: 1,
    phase,
    reason_code: "target_missing",
    candidates: [{ key: "fallback-1", source: "sidecar_fallback", fallback_index: 0 }],
    scene_retry_available: true,
  } as const;
}

describe("recording repair controller", () => {
  it("locks phase-aware actions and never retries post-input side effects", () => {
    expect(
      recordingRepairAllowedActions({
        phase: "pre_input",
        attempt: 0,
        candidateCount: 1,
        sceneRetryAvailable: true,
      }),
    ).toEqual(["retry_step", "use_candidate_and_retry", "retry_scene", "abort_keep_salvage"]);
    expect(
      recordingRepairAllowedActions({
        phase: "input_emitted_presentation_pending",
        attempt: 0,
        candidateCount: 1,
        sceneRetryAvailable: false,
      }),
    ).toEqual(["await_presentation", "abort_keep_salvage"]);
    expect(
      recordingRepairAllowedActions({
        phase: "post_input_failed",
        attempt: 0,
        candidateCount: 1,
        sceneRetryAvailable: false,
      }),
    ).toEqual(["abort_keep_salvage"]);
  });

  it("consumes a valid token once and rejects replay", async () => {
    const controller = new RecordingRepairController("session-1");
    const pending = controller.begin(request());
    const accepted = controller.resolve({
      session_id: "session-1",
      repair_token: pending.event.repair_token,
      action: "retry_step",
    });

    await expect(pending.resolution).resolves.toEqual(accepted);
    expect(() =>
      controller.resolve({
        session_id: "session-1",
        repair_token: pending.event.repair_token,
        action: "retry_step",
      }),
    ).toThrowError(expect.objectContaining({ reason: "no_repair_pending" }));
  });

  it("rejects wrong owners, stale tokens, unsafe actions, and unknown candidates", () => {
    const controller = new RecordingRepairController("session-1");
    const pending = controller.begin(request("input_emitted_presentation_pending"));
    expect(() =>
      controller.resolve({
        session_id: "other",
        repair_token: pending.event.repair_token,
        action: "await_presentation",
      }),
    ).toThrowError(expect.objectContaining({ reason: "wrong_session" }));
    expect(() =>
      controller.resolve({
        session_id: "session-1",
        repair_token: "stale",
        action: "await_presentation",
      }),
    ).toThrowError(expect.objectContaining({ reason: "stale_or_replayed_token" }));
    expect(() =>
      controller.resolve({
        session_id: "session-1",
        repair_token: pending.event.repair_token,
        action: "retry_step",
      }),
    ).toThrowError(expect.objectContaining({ reason: "action_not_allowed" }));
    controller.invalidate();

    const second = new RecordingRepairController("session-1");
    const secondPending = second.begin(request());
    expect(() =>
      second.resolve({
        session_id: "session-1",
        repair_token: secondPending.event.repair_token,
        action: "use_candidate_and_retry",
        candidate_key: "unknown",
      }),
    ).toThrowError(expect.objectContaining({ reason: "candidate_not_allowed" }));
    second.invalidate();
  });

  it("enforces the three-attempt step limit", async () => {
    const controller = new RecordingRepairController("session-1");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = controller.begin(request());
      controller.resolve({
        session_id: "session-1",
        repair_token: pending.event.repair_token,
        action: "retry_step",
      });
      await pending.resolution;
    }
    const exhausted = controller.begin(request());
    expect(exhausted.event.attempt).toBe(3);
    expect(exhausted.event.allowed_actions).toEqual(["retry_scene", "abort_keep_salvage"]);
    controller.invalidate();
  });

  it("expires to abort-with-salvage and invalidates on session close", async () => {
    const controller = new RecordingRepairController("session-1", { ttlMs: 60_000 });
    const expired = controller.begin(request());
    controller.expireForTest();
    await expect(expired.resolution).resolves.toMatchObject({
      action: "abort_keep_salvage",
      reason: "expired",
    });

    const closing = controller.begin(request());
    controller.invalidate();
    await expect(closing.resolution).resolves.toMatchObject({
      action: "abort_keep_salvage",
      reason: "session_closed",
    });
  });

  it("keeps controllers in memory only and removes them on invalidation", () => {
    const controller = recordingRepairController("managed-session");
    expect(recordingRepairControllerForSession("managed-session")).toBe(controller);
    invalidateRecordingRepair("managed-session");
    expect(recordingRepairControllerForSession("managed-session")).toBeNull();
  });
});
