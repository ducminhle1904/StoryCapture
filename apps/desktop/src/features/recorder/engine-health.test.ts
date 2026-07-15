import { describe, expect, it } from "vitest";
import type { EngineHealthSnapshotDto } from "@/ipc/encode";
import {
  engineHealthCopy,
  initialRecorderEngineHealthState,
  reduceRecorderEngineHealth,
} from "./engine-health";

function snapshot(
  sessionId: string,
  sequence: number,
  state: EngineHealthSnapshotDto["state"] = "healthy",
): EngineHealthSnapshotDto {
  return {
    schema_version: 1,
    session_id: sessionId,
    sequence,
    observed_at_ms: 1,
    state,
    reason_codes: state === "stalled" ? ["encoder_not_alive"] : [],
    requested_fps: 30,
    effective_fps: 30,
    actual_capture_fps: 30,
    source_capture_fps: 30,
    committed_frames: 1,
    source_frames_received: 1,
    frames_dropped: 0,
    skipped_ticks: 0,
    late_frames: 0,
    encoder_backpressured: false,
    encoder_backpressure_events: 0,
    capture_duration_ms_p95: 1,
    last_committed_pts_us: 1,
    encoder_alive: state !== "stalled",
    audio_tracks: [],
    target_liveness: { state: "live", last_observed_at_ms: 1, reason: null },
    disk: { free_bytes: 1_000, threshold_bytes: 100, state: "ok" },
    terminal_health: { state: "none", reason_codes: [] },
    allowed_actions: ["stop", "cancel"],
  };
}

describe("recorder engine health reducer", () => {
  it("discards stale sessions and non-monotonic sequences", () => {
    const current = reduceRecorderEngineHealth(
      initialRecorderEngineHealthState,
      "session-1",
      snapshot("session-1", 2),
    );
    expect(reduceRecorderEngineHealth(current, "session-1", snapshot("session-1", 1))).toBe(
      current,
    );
    expect(reduceRecorderEngineHealth(current, "session-1", snapshot("session-old", 3))).toBe(
      current,
    );
  });

  it("maps fatal state to persistent non-color-only copy", () => {
    expect(engineHealthCopy(snapshot("session-1", 1, "stalled"))).toEqual({
      label: "Engine stalled",
      summary: "encoder not alive",
      severity: "danger",
      persistent: true,
    });
  });
});
