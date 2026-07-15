import { describe, expect, it, vi } from "vitest";
import { RecordingActionLandmarkRecorder } from "./action-landmarks";

describe("RecordingActionLandmarkRecorder", () => {
  it("samples movement only on committed frames and barriers input behind arrival", async () => {
    const recorder = new RecordingActionLandmarkRecorder();
    recorder.begin("click", {
      delivery: "browser_injected",
      point: { x: 10, y: 20 },
      expectsPresentation: true,
    });
    recorder.commitFrame({ frameIndex: 0, ptsUs: 0 });
    recorder.updateCursor("click", { x: 40, y: 50 });
    const arrival = recorder.waitForArrival("click", 100);
    recorder.commitFrame({ frameIndex: 1, ptsUs: 16_667 });
    await expect(arrival).resolves.toEqual({ frameIndex: 1, ptsUs: 16_667 });

    recorder.armPresentation("click");
    recorder.markInput("click", "down");
    recorder.markInput("click", "up");
    recorder.markInput("click", "action");
    recorder.updateCursor("click", { x: 99, y: 99 });
    recorder.notePaint();
    const presentation = recorder.waitForPresentation("click", 100);
    recorder.commitFrame({ frameIndex: 2, ptsUs: 33_333 });
    await expect(presentation).resolves.toMatchObject({ status: "presented" });

    const result = recorder.finish("click");
    expect(result.cursorPath.samples).toEqual([
      { frameIndex: 0, ptsUs: 0, x: 10, y: 20 },
      { frameIndex: 1, ptsUs: 16_667, x: 40, y: 50 },
    ]);
    expect(result.cursorPath.arrival.frameIndex).toBeLessThanOrEqual(
      result.input.action?.frameIndex ?? -1,
    );
    expect(result.input.down?.frameIndex).toBeLessThanOrEqual(result.input.up?.frameIndex ?? -1);
    expect(result.presentation).toEqual({
      status: "presented",
      firstPostInputFrame: { frameIndex: 2, ptsUs: 33_333 },
      firstPostInputPaint: { frameIndex: 2, ptsUs: 33_333 },
    });
  });

  it("classifies virtual-only input and marks hover presentation not applicable", async () => {
    const recorder = new RecordingActionLandmarkRecorder();
    recorder.begin("hover", {
      delivery: "virtual_only",
      point: { x: 1, y: 2 },
      expectsPresentation: false,
    });
    const arrival = recorder.waitForArrival("hover", 100);
    recorder.commitFrame({ frameIndex: 0, ptsUs: 0 });
    await arrival;
    expect(recorder.finish("hover")).toMatchObject({
      delivery: "virtual_only",
      presentation: { status: "not_applicable" },
    });
  });

  it("records a safe timeout instead of inventing a post-input frame", async () => {
    vi.useFakeTimers();
    try {
      const recorder = new RecordingActionLandmarkRecorder();
      recorder.begin("type", {
        delivery: "virtual_only",
        point: { x: 3, y: 4 },
        expectsPresentation: true,
      });
      const arrival = recorder.waitForArrival("type", 100);
      recorder.commitFrame({ frameIndex: 0, ptsUs: 0 });
      await arrival;
      recorder.armPresentation("type");
      for (const kind of ["down", "up", "text_start", "text_end", "action"] as const) {
        recorder.markInput("type", kind);
      }
      const presentation = recorder.waitForPresentation("type", 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(presentation).resolves.toEqual({
        status: "timeout",
        diagnosticReason: "post_input_frame_timeout",
      });
      recorder.armPresentation("type");
      const retriedPresentation = recorder.waitForPresentation("type", 50);
      recorder.notePaint();
      recorder.commitFrame({ frameIndex: 1, ptsUs: 33_333 });
      await expect(retriedPresentation).resolves.toEqual({
        status: "presented",
        firstPostInputFrame: { frameIndex: 1, ptsUs: 33_333 },
        firstPostInputPaint: { frameIndex: 1, ptsUs: 33_333 },
      });
      const finished = recorder.finish("type");
      expect(finished.input).toEqual({
        down: { frameIndex: 0, ptsUs: 0 },
        up: { frameIndex: 0, ptsUs: 0 },
        text_start: { frameIndex: 0, ptsUs: 0 },
        text_end: { frameIndex: 0, ptsUs: 0 },
        action: { frameIndex: 0, ptsUs: 0 },
      });
      expect(finished.presentation).toEqual({
        status: "presented",
        firstPostInputFrame: { frameIndex: 1, ptsUs: 33_333 },
        firstPostInputPaint: { frameIndex: 1, ptsUs: 33_333 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles degraded and cancelled arrival waiters without inventing landmarks", async () => {
    const recorder = new RecordingActionLandmarkRecorder();
    recorder.begin("degraded", {
      delivery: "virtual_only",
      point: { x: 3, y: 4 },
      expectsPresentation: true,
    });
    const degraded = recorder.waitForArrivalOutcome("degraded", 10_000);
    recorder.degradeArrival("degraded", "encoder_error");
    await expect(degraded).resolves.toEqual({ status: "degraded", reason: "encoder_error" });
    recorder.discard("degraded");

    recorder.begin("cancelled", {
      delivery: "virtual_only",
      point: { x: 5, y: 6 },
      expectsPresentation: true,
    });
    const cancelled = recorder.waitForArrivalOutcome("cancelled", 10_000);
    recorder.cancelAll();
    await expect(cancelled).resolves.toEqual({ status: "cancelled" });
  });

  it("settles every arrival waiter with the first terminal outcome", async () => {
    vi.useFakeTimers();
    try {
      const recorder = new RecordingActionLandmarkRecorder();
      recorder.begin("shared-timeout", {
        delivery: "virtual_only",
        point: { x: 1, y: 2 },
        expectsPresentation: true,
      });
      const fast = recorder.waitForArrivalOutcome("shared-timeout", 10);
      const slow = recorder.waitForArrivalOutcome("shared-timeout", 10_000);

      await vi.advanceTimersByTimeAsync(10);
      const degraded = { status: "degraded", reason: "frame_commit_timeout" } as const;
      await expect(fast).resolves.toEqual(degraded);
      await expect(slow).resolves.toEqual(degraded);

      recorder.commitFrame({ frameIndex: 0, ptsUs: 0 });
      await expect(recorder.waitForArrivalOutcome("shared-timeout", 1)).resolves.toEqual(degraded);
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors input to the barrier landmark and reports first presentation once", () => {
    const recorder = new RecordingActionLandmarkRecorder();
    const observations: unknown[] = [];
    const unsubscribe = recorder.onPresentation((observation) => observations.push(observation));
    recorder.begin("anchored", {
      delivery: "browser_injected",
      point: { x: 20, y: 30 },
      expectsPresentation: true,
    });
    recorder.commitFrame({ frameIndex: 0, ptsUs: 0 });
    recorder.anchorArrival("anchored", { frameIndex: 0, ptsUs: 0 });
    recorder.commitFrame({ frameIndex: 1, ptsUs: 16_667 });
    recorder.armPresentation("anchored");
    expect(recorder.markInput("anchored", "action")).toEqual({ frameIndex: 0, ptsUs: 0 });
    recorder.commitFrame({ frameIndex: 2, ptsUs: 33_333 });
    recorder.commitFrame({ frameIndex: 3, ptsUs: 50_000 });
    unsubscribe();

    expect(observations).toEqual([
      {
        eventId: "anchored",
        input: { frameIndex: 0, ptsUs: 0 },
        presentation: {
          status: "presented",
          firstPostInputFrame: { frameIndex: 2, ptsUs: 33_333 },
        },
      },
    ]);
  });
});
