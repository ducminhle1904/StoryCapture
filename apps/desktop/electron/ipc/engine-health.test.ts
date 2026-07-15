import { describe, expect, it } from "vitest";
import {
  classifyEngineHealth,
  type EngineHealthInput,
  EngineHealthPublisher,
} from "./engine-health";
import type { RecordingHealthUpdateV1, RecordingHealthV1 } from "./recording-health";

function recordingHealth(verdict: RecordingHealthV1["verdict"] = "pass"): RecordingHealthV1 {
  return {
    version: 1,
    session_id: "session-1",
    profile: "1080p30",
    capture_path: "raw_bgra",
    requested_fps: 30,
    expected_frames: 30,
    requested_frames: 30,
    source_frames: 30,
    submitted_frames: 30,
    encoded_frames: 30,
    dropped_frames: 0,
    skipped_frames: 0,
    observed_fps: 30,
    loss_ratio: 0,
    frame_gap_p95_ms: 33,
    frame_gap_max_ms: 34,
    backpressure_events: 0,
    backpressure_total_ms: 0,
    backpressure_high_water: 0,
    action_to_presentation_p95_ms: 16,
    first_encoded_frame_ms: 10,
    output_readable: true,
    finalized: false,
    verdict,
    reasons: [],
  };
}

function input(overrides: Partial<EngineHealthInput> = {}): EngineHealthInput {
  const healthUpdate: RecordingHealthUpdateV1 = {
    event: "health-update",
    phase: "snapshot",
    health: recordingHealth(),
  };
  return {
    sessionId: "session-1",
    observedAtMs: 2_000,
    lifecycle: "recording",
    healthUpdate,
    effectiveFps: 30,
    sourceCaptureFps: 30,
    sourceFramesReceived: 30,
    lateFrames: 0,
    encoderBackpressured: false,
    encoderBackpressureEvents: 0,
    captureDurationMsP95: 4,
    lastCommittedPtsUs: 1_000_000,
    encoderAlive: true,
    audioTracks: [],
    targetLiveness: { state: "live", last_observed_at_ms: 2_000, reason: null },
    diskFreeBytes: 20 * 1024 ** 3,
    terminalHealth: { state: "none", reason_codes: [] },
    repairAvailable: false,
    ...overrides,
  };
}

describe("engine health", () => {
  it("keeps a static but progressing encoder healthy", () => {
    expect(classifyEngineHealth(input(), 1)).toMatchObject({
      state: "healthy",
      encoder_alive: true,
      target_liveness: { state: "live" },
    });
  });

  it("maps REC-060 warning and hard verdicts without redefining thresholds", () => {
    const warning = input({
      healthUpdate: {
        event: "health-update",
        phase: "snapshot",
        health: recordingHealth("degraded"),
      },
    });
    const hard = input({
      healthUpdate: {
        event: "health-update",
        phase: "snapshot",
        health: recordingHealth("fail"),
      },
    });
    expect(classifyEngineHealth(warning, 1).state).toBe("constrained");
    expect(classifyEngineHealth(hard, 1).state).toBe("degraded");
  });

  it("surfaces encoder death immediately and exposes only host-approved actions", () => {
    expect(
      classifyEngineHealth(
        input({
          encoderAlive: false,
          repairAvailable: true,
          terminalHealth: { state: "repairable", reason_codes: ["encoder_exit"] },
        }),
        1,
      ),
    ).toMatchObject({
      state: "stalled",
      reason_codes: expect.arrayContaining(["encoder_not_alive", "encoder_exit"]),
      allowed_actions: ["stop", "cancel", "repair"],
    });
  });

  it("lets required audio and critical disk degrade the aggregate", () => {
    const snapshot = classifyEngineHealth(
      input({
        diskFreeBytes: 1,
        audioTracks: [
          {
            track_id: "mic",
            role: "microphone",
            requirement: "required",
            state: "failed",
            samples_received: 0,
            last_sample_pts_us: null,
            terminal_reason: "device_lost",
          },
        ],
      }),
      1,
    );
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.disk.state).toBe("critical");
    expect(snapshot.reason_codes).toEqual(
      expect.arrayContaining(["disk_critical", "required_audio_failed"]),
    );
  });

  it("coalesces steady snapshots but emits transitions and preserves peak evidence", () => {
    const publisher = new EngineHealthPublisher();
    expect(publisher.update(input())).toMatchObject({ sequence: 1, state: "healthy" });
    expect(publisher.update(input({ observedAtMs: 2_500 }))).toBeNull();
    expect(publisher.update(input({ observedAtMs: 3_000 }))).toMatchObject({ sequence: 2 });
    expect(publisher.update(input({ observedAtMs: 3_100, encoderAlive: false }))).toMatchObject({
      sequence: 3,
      state: "stalled",
    });
    expect(publisher.evidence()).toMatchObject({
      peak_state: "stalled",
      latest: { sequence: 3 },
    });
  });

  it("caps a ten-minute steady stream at one periodic event per second", () => {
    const publisher = new EngineHealthPublisher();
    const emittedAtMs: number[] = [];
    for (let tick = 0; tick <= 6_000; tick += 1) {
      const observedAtMs = tick * 100;
      const snapshot = publisher.update(
        input({
          observedAtMs,
          targetLiveness: { state: "live", last_observed_at_ms: observedAtMs, reason: null },
        }),
      );
      if (snapshot) emittedAtMs.push(snapshot.observed_at_ms);
    }

    expect(emittedAtMs).toHaveLength(601);
    expect(emittedAtMs.every((atMs, index) => index === 0 || atMs - emittedAtMs[index - 1]! >= 1_000)).toBe(
      true,
    );

    const critical = publisher.update(input({ observedAtMs: 600_050, diskFreeBytes: 1 }));
    expect(critical).toMatchObject({ state: "degraded", disk: { state: "critical" } });
    const recovered = publisher.update(input({ observedAtMs: 600_100 }));
    expect(recovered).toMatchObject({ state: "healthy", disk: { state: "ok" } });
  });
});
