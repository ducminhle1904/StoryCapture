import { describe, expect, it, vi } from "vitest";
import {
  type RecordingCapturePath,
  RecordingHealthAccumulator,
  type RecordingHealthAccumulatorOptions,
  type RecordingHealthV1,
  recordingHealthMode,
} from "./recording-health";

function accumulator(
  overrides: Partial<RecordingHealthAccumulatorOptions> = {},
): RecordingHealthAccumulator {
  return new RecordingHealthAccumulator({
    sessionId: "session-1",
    capturePath: "raw_bgra",
    outputWidth: 1_920,
    outputHeight: 1_080,
    requestedFps: 30,
    startedAtMs: 0,
    now: () => 0,
    ...overrides,
  });
}

function recordFrames(
  health: RecordingHealthAccumulator,
  ptsUs: readonly number[],
  committedAtMs = 100,
): void {
  ptsUs.forEach((pts, frameIndex) => {
    health.recordScheduledSlot({ slot: frameIndex, ptsUs: pts });
    health.recordSourceFrame(frameIndex);
    health.recordSubmission({ slot: frameIndex, ptsUs: pts });
    health.recordSinkAck({ frameIndex, ptsUs: pts, committedAtMs: committedAtMs + frameIndex });
  });
}

function sealPlayable(
  health: RecordingHealthAccumulator,
  ptsUs: readonly number[],
  overrides: {
    activeMediaMs?: number;
    outputReadable?: boolean;
    outputFrames?: number | null;
    encoderSucceeded?: boolean;
    firstFrame?: "committed" | "degraded" | "failed" | "observed_only";
  } = {},
): RecordingHealthV1 {
  health.recordFirstFrameBarrier(overrides.firstFrame ?? "committed");
  health.recordOutputProbe({
    readable: overrides.outputReadable ?? true,
    videoFrameCount: overrides.outputFrames ?? ptsUs.length,
  });
  return health.seal({
    activeMediaMs: overrides.activeMediaMs ?? (ptsUs.at(-1) ?? 0) / 1_000,
    encoderSucceeded: overrides.encoderSucceeded ?? true,
  });
}

function framePts(frameIndex: number): number {
  return Math.round((frameIndex * 1_000_000) / 30);
}

function lossFixture(total: number, skipped: number, activeMediaMs: number): RecordingHealthV1 {
  const health = accumulator();
  const submitted = total - skipped;
  for (let slot = 0; slot < total; slot += 1) {
    const ptsUs = framePts(slot);
    health.recordScheduledSlot({ slot, ptsUs });
    if (slot >= submitted) {
      health.recordSkipped(slot, "scheduler_late");
      continue;
    }
    health.recordSourceFrame(slot);
    health.recordSubmission({ slot, ptsUs });
    health.recordSinkAck({ frameIndex: slot, ptsUs, committedAtMs: slot + 1 });
  }
  return sealPlayable(
    health,
    Array.from({ length: submitted }, (_, index) => framePts(index)),
    { activeMediaMs, outputFrames: submitted },
  );
}

describe("RecordingHealthAccumulator", () => {
  it.each([
    "raw_bgra",
    "png",
  ] as const)("computes %s observed FPS only from encoded sink PTS", (capturePath: RecordingCapturePath) => {
    const health = accumulator({ capturePath, requestedFps: 60 });
    const ptsUs = [0, 40_000, 80_000];
    recordFrames(health, ptsUs);

    const final = sealPlayable(health, ptsUs);

    expect(final.observed_fps).toBe(25);
    expect(final.observed_fps).not.toBe(final.requested_fps);
  });

  it("returns null observed FPS and gaps for zero or one encoded frame", () => {
    const zero = accumulator();
    const zeroFinal = sealPlayable(zero, [], { outputFrames: 0 });
    expect(zeroFinal).toMatchObject({
      observed_fps: null,
      frame_gap_p95_ms: null,
      frame_gap_max_ms: null,
    });

    const one = accumulator();
    recordFrames(one, [0]);
    const oneFinal = sealPlayable(one, [0]);
    expect(oneFinal).toMatchObject({
      verdict: "degraded",
      observed_fps: null,
      frame_gap_p95_ms: null,
      frame_gap_max_ms: null,
    });
    expect(oneFinal.reasons).toContain("insufficient_encoded_frames");
  });

  it("reports nearest-rank frame-gap p95 and maximum", () => {
    const health = accumulator();
    const ptsUs = [0, 20_000, 60_000, 160_000];
    recordFrames(health, ptsUs);

    const final = sealPlayable(health, ptsUs);

    expect(final.frame_gap_p95_ms).toBe(100);
    expect(final.frame_gap_max_ms).toBe(100);
  });

  it("keeps skipped and dropped losses disjoint", () => {
    const health = accumulator();
    for (let slot = 0; slot < 4; slot += 1) {
      health.recordScheduledSlot({ slot, ptsUs: framePts(slot) });
    }
    for (let slot = 0; slot < 3; slot += 1) {
      health.recordSubmission({ slot, ptsUs: framePts(slot) });
    }
    health.recordSinkAck({ frameIndex: 0, ptsUs: framePts(0), committedAtMs: 1 });
    health.recordSinkAck({ frameIndex: 1, ptsUs: framePts(1), committedAtMs: 2 });
    health.recordDropped(2, "sink_not_acknowledged");
    health.recordSkipped(3, "scheduler_late");

    const final = sealPlayable(health, [framePts(0), framePts(1)], {
      activeMediaMs: framePts(3) / 1_000,
    });

    expect(final).toMatchObject({ dropped_frames: 1, skipped_frames: 1 });
    expect(final.loss_ratio).toBe(0.5);
    expect(final.reasons).not.toContain("health_invariant_violation");
  });

  it("requires loss to be strictly below the 0.1% supported-profile boundary", () => {
    const below = lossFixture(1_001, 1, 33_333.334);
    const exact = lossFixture(1_000, 1, 33_300);
    const above = lossFixture(1_000, 2, 33_300);

    expect(below.loss_ratio).toBeCloseTo(1 / 1_001, 12);
    expect(below.verdict).toBe("pass");
    expect(exact.loss_ratio).toBe(0.001);
    expect(exact).toMatchObject({ verdict: "degraded" });
    expect(exact.reasons).toContain("loss_gate_failed");
    expect(above.loss_ratio).toBe(0.002);
    expect(above.reasons).toContain("loss_gate_failed");
  });

  it.each([
    [1_920, 1_080, "1080p30"],
    [2_560, 1_440, "1440p30"],
  ] as const)("passes the healthy %s x %s profile as %s", (width, height, profile) => {
    const health = accumulator({ outputWidth: width, outputHeight: height });
    const ptsUs = [0, framePts(1), framePts(2)];
    recordFrames(health, ptsUs);

    expect(sealPlayable(health, ptsUs)).toMatchObject({ profile, verdict: "pass" });
  });

  it("applies the one-frame action-to-presentation gate and reports missing samples", () => {
    const atGate = accumulator();
    const ptsUs = [0, framePts(1), framePts(2)];
    recordFrames(atGate, ptsUs);
    atGate.recordActionPresentation({ frameIndex: 0, ptsUs: 0 }, { frameIndex: 1, ptsUs: 33_340 });
    const atGateFinal = sealPlayable(atGate, ptsUs);
    expect(atGateFinal.action_to_presentation_p95_ms).toBe(33.34);
    expect(atGateFinal.reasons).not.toContain("presentation_latency_gate_failed");

    const overGate = accumulator();
    recordFrames(overGate, ptsUs);
    overGate.recordActionPresentation(
      { frameIndex: 0, ptsUs: 0 },
      { frameIndex: 1, ptsUs: 33_341 },
    );
    const overGateFinal = sealPlayable(overGate, ptsUs);
    expect(overGateFinal.reasons).toContain("presentation_latency_gate_failed");

    const missing = accumulator();
    recordFrames(missing, ptsUs);
    missing.recordActionPresentation({ frameIndex: 0, ptsUs: 0 }, null);
    const missingFinal = sealPlayable(missing, ptsUs);
    expect(missingFinal.reasons).toContain("presentation_sample_missing");
  });

  it("classifies unreadable output, zero frames, and first-frame failures", () => {
    const ptsUs = [0, framePts(1)];
    const unreadable = accumulator();
    recordFrames(unreadable, ptsUs);
    expect(sealPlayable(unreadable, ptsUs, { outputReadable: false })).toMatchObject({
      verdict: "fail",
      reasons: expect.arrayContaining(["output_unreadable"]),
    });

    const zero = accumulator();
    expect(sealPlayable(zero, [], { outputFrames: 0 })).toMatchObject({
      verdict: "fail",
      first_encoded_frame_ms: null,
      reasons: expect.arrayContaining(["zero_encoded_frames"]),
    });

    const barrier = accumulator();
    recordFrames(barrier, ptsUs, 125);
    expect(sealPlayable(barrier, ptsUs, { firstFrame: "failed" })).toMatchObject({
      verdict: "fail",
      first_encoded_frame_ms: 125,
      reasons: expect.arrayContaining(["first_frame_barrier_failed"]),
    });
  });

  it("reports backpressure spans without changing a healthy verdict", () => {
    const health = accumulator();
    const ptsUs = [0, framePts(1)];
    recordFrames(health, ptsUs);
    health.recordBackpressureSpan({ startedAtMs: 10, endedAtMs: 25, highWater: 2 });
    health.recordBackpressureSpan({ startedAtMs: 30, endedAtMs: 35, highWater: 5 });

    expect(sealPlayable(health, ptsUs)).toMatchObject({
      verdict: "pass",
      backpressure_events: 2,
      backpressure_total_ms: 20,
      backpressure_high_water: 5,
    });
  });

  it("rate-limits immutable snapshots to 1 Hz and always emits one final update", () => {
    let now = 0;
    const updates: unknown[] = [];
    const onUpdate = vi.fn((update: unknown) => updates.push(update));
    const health = accumulator({ now: () => now, onUpdate });
    const ptsUs = [0, framePts(1)];
    recordFrames(health, ptsUs);

    const first = health.snapshot();
    now = 999;
    expect(health.snapshot()).toBeNull();
    now = 1_000;
    const second = health.snapshot();
    const final = sealPlayable(health, ptsUs);

    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(first?.phase).toBe("snapshot");
    expect(second?.phase).toBe("snapshot");
    expect(health.latestUpdate()?.phase).toBe("final");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.health)).toBe(true);
    expect(Object.isFrozen(first?.health.reasons)).toBe(true);
    expect(Object.isFrozen(final)).toBe(true);
    expect(updates).toHaveLength(3);
  });

  it("seals deterministically and ignores late facts or duplicate finalization", () => {
    const onUpdate = vi.fn();
    const health = accumulator({ onUpdate });
    const ptsUs = [0, framePts(1)];
    recordFrames(health, ptsUs);
    const first = sealPlayable(health, ptsUs);

    health.recordBackpressureSpan({ startedAtMs: 0, endedAtMs: 99, highWater: 99 });
    const second = health.seal({ activeMediaMs: 999_999, encoderSucceeded: false });

    expect(second).toBe(first);
    expect(second.backpressure_events).toBe(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(health.snapshot()).toBeNull();
  });

  it("serializes only the bounded health contract and rejects content-like session IDs", () => {
    const health = accumulator({
      ...({ storySource: "secret story", url: "https://secret.invalid" } as object),
    });
    const ptsUs = [0, framePts(1)];
    recordFrames(health, ptsUs);
    health.recordOutputProbe({
      readable: true,
      videoFrameCount: 2,
      ...({ path: "/private/video.mp4", selector: "#password" } as object),
    });
    health.recordFirstFrameBarrier("committed");
    const finalPtsUs = ptsUs[1] ?? 0;
    const final = health.seal({
      activeMediaMs: finalPtsUs / 1_000,
      encoderSucceeded: true,
      ...({ pixels: "raw-bytes", typedText: "hunter2" } as object),
    });
    const serialized = JSON.stringify(final);

    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("raw-bytes");
    expect(serialized).not.toContain("hunter2");
    expect(() => accumulator({ sessionId: "https://secret.invalid" })).toThrow(
      "opaque, non-sensitive identifier",
    );
  });

  it("fails closed on invalid encoded PTS ordering with a stable reason", () => {
    const health = accumulator();
    health.recordScheduledSlot({ slot: 0, ptsUs: 0 });
    health.recordSubmission({ slot: 0, ptsUs: 0 });
    health.recordSinkAck({ frameIndex: 0, ptsUs: 100, committedAtMs: 1 });
    health.recordSinkAck({ frameIndex: 1, ptsUs: 99, committedAtMs: 2 });

    const final = sealPlayable(health, [100], { activeMediaMs: 0.1, outputFrames: 1 });

    expect(final).toMatchObject({
      verdict: "fail",
      reasons: expect.arrayContaining(["health_invariant_violation"]),
    });
  });
});

describe("recordingHealthMode", () => {
  it("accepts only explicit rollout values", () => {
    expect(recordingHealthMode("off")).toBe("off");
    expect(recordingHealthMode("observe")).toBe("observe");
    expect(recordingHealthMode("required")).toBe("required");
    expect(recordingHealthMode("unexpected")).toBe("off");
  });
});
