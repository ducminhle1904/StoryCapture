import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RecordingReadinessCoordinator,
  RecordingReadinessError,
  recordingReadinessMode,
} from "./recording-readiness";

afterEach(() => {
  vi.useRealTimers();
});

describe("recording readiness", () => {
  it("normalizes rollout modes without enabling enforcement by default", () => {
    expect(recordingReadinessMode(undefined)).toBe("off");
    expect(recordingReadinessMode("shadow")).toBe("observe");
    expect(recordingReadinessMode(" observe ")).toBe("observe");
    expect(recordingReadinessMode("enforce")).toBe("enforce");
    expect(recordingReadinessMode("unexpected")).toBe("off");
  });

  it("returns not_applicable without touching capture when the gate is off", async () => {
    const queueFrame = vi.fn();
    const coordinator = new RecordingReadinessCoordinator({ sessionId: "off", mode: "off" });

    await expect(
      coordinator.request({
        barrier: "pre_input_frame_committed",
        budgetMs: 100,
        queueFrame,
      }),
    ).resolves.toMatchObject({ status: "not_applicable", attempts: 0 });
    expect(queueFrame).not.toHaveBeenCalled();
  });

  it("accepts only current-session, submitted, monotonic encoded acknowledgements", async () => {
    const coordinator = new RecordingReadinessCoordinator({
      sessionId: "current",
      mode: "enforce",
      sinkAcknowledgements: true,
    });
    coordinator.markSourceReady();
    const queueFrame = vi.fn(async () => {
      coordinator.markFrameSubmitted();
      expect(
        coordinator.acknowledgeEncodedFrame({
          sessionId: "stale",
          encodedFrameCount: 1,
          landmark: { frameIndex: 0, ptsUs: 0 },
        }),
      ).toBe(false);
      expect(
        coordinator.acknowledgeEncodedFrame({
          sessionId: "current",
          encodedFrameCount: 2,
          landmark: { frameIndex: 1, ptsUs: 33_333 },
        }),
      ).toBe(false);
      expect(
        coordinator.acknowledgeEncodedFrame({
          sessionId: "current",
          encodedFrameCount: 1,
          landmark: { frameIndex: 0, ptsUs: 0 },
        }),
      ).toBe(true);
    });

    await expect(
      coordinator.require({
        barrier: "first_frame_committed",
        budgetMs: 100,
        queueFrame,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      attempts: 1,
      committed_landmark: { frameIndex: 0, ptsUs: 0 },
      submitted_frames: 1,
      encoded_frames: 1,
    });
  });

  it("does not let an earlier scene frame satisfy a later media request", async () => {
    const coordinator = new RecordingReadinessCoordinator({
      sessionId: "scene-boundary",
      mode: "enforce",
      sinkAcknowledgements: true,
    });
    coordinator.markSourceReady();
    coordinator.markFrameSubmitted();
    coordinator.markFrameSubmitted();
    const result = coordinator.require({
      barrier: "pre_input_frame_committed",
      budgetMs: 1_000,
      requestedMediaUs: 33_333,
      queueFrame: async () => {},
    });

    expect(
      coordinator.acknowledgeEncodedFrame({
        sessionId: "scene-boundary",
        encodedFrameCount: 1,
        landmark: { frameIndex: 0, ptsUs: 0 },
      }),
    ).toBe(true);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(
      coordinator.acknowledgeEncodedFrame({
        sessionId: "scene-boundary",
        encodedFrameCount: 2,
        landmark: { frameIndex: 1, ptsUs: 33_333 },
      }),
    ).toBe(true);
    await expect(result).resolves.toMatchObject({
      status: "committed",
      committed_landmark: { frameIndex: 1, ptsUs: 33_333 },
    });
  });

  it("uses exactly three attempts without extending the absolute deadline", async () => {
    vi.useFakeTimers();
    const coordinator = new RecordingReadinessCoordinator({
      sessionId: "retry",
      mode: "enforce",
      sinkAcknowledgements: true,
      now: Date.now,
    });
    coordinator.markSourceReady();
    const queueFrame = vi.fn(async () => {
      coordinator.markFrameSubmitted();
    });

    const result = coordinator.request({
      barrier: "pre_input_frame_committed",
      budgetMs: 300,
      queueFrame,
    });
    await vi.advanceTimersByTimeAsync(300);

    await expect(result).resolves.toMatchObject({
      status: "failed",
      reason: "frame_commit_timeout",
      attempts: 3,
      active_wait_ms: 300,
    });
    expect(queueFrame).toHaveBeenCalledTimes(3);
  });

  it("excludes paused wall time from a barrier deadline", async () => {
    vi.useFakeTimers();
    const coordinator = new RecordingReadinessCoordinator({
      sessionId: "paused",
      mode: "enforce",
      sinkAcknowledgements: true,
      now: Date.now,
    });
    coordinator.markSourceReady();
    const result = coordinator.request({
      barrier: "tail_frame_committed",
      budgetMs: 90,
      queueFrame: async () => {
        coordinator.markFrameSubmitted();
      },
    });
    let settled = false;
    void result.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(30);
    coordinator.pause();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    coordinator.resume();
    await vi.advanceTimersByTimeAsync(60);

    await expect(result).resolves.toMatchObject({
      status: "failed",
      active_wait_ms: 90,
    });
  });

  it("cancels every outstanding waiter and never reports success", async () => {
    vi.useFakeTimers();
    const coordinator = new RecordingReadinessCoordinator({
      sessionId: "cancelled",
      mode: "enforce",
      sinkAcknowledgements: true,
      now: Date.now,
    });
    coordinator.markSourceReady();
    const result = coordinator.request({
      barrier: "pre_input_frame_committed",
      budgetMs: 5_000,
      queueFrame: async () => {
        coordinator.markFrameSubmitted();
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    coordinator.cancel();

    await expect(result).resolves.toMatchObject({
      status: "cancelled",
      reason: "recording_cancelled",
    });
  });

  it("keeps observe mode nonblocking while reporting the measured result", async () => {
    vi.useFakeTimers();
    const observations: unknown[] = [];
    const coordinator = new RecordingReadinessCoordinator({
      sessionId: "observe",
      mode: "observe",
      sinkAcknowledgements: true,
      now: Date.now,
      onObservation: (result) => observations.push(result),
    });
    coordinator.markSourceReady();

    await expect(
      coordinator.request({
        barrier: "pre_input_frame_committed",
        budgetMs: 30,
        queueFrame: async () => {
          coordinator.markFrameSubmitted();
        },
      }),
    ).resolves.toMatchObject({ status: "observed_only", attempts: 0 });
    await vi.advanceTimersByTimeAsync(30);
    expect(observations).toEqual([
      expect.objectContaining({
        status: "degraded",
        reason: "frame_commit_timeout",
        attempts: 3,
      }),
    ]);
  });

  it("throws a typed failure from require when an enforced sink is unavailable", async () => {
    const coordinator = new RecordingReadinessCoordinator({
      sessionId: "no-sink",
      mode: "enforce",
    });
    coordinator.markSourceReady();

    await expect(
      coordinator.require({ barrier: "first_frame_committed", budgetMs: 100 }),
    ).rejects.toBeInstanceOf(RecordingReadinessError);
  });
});
