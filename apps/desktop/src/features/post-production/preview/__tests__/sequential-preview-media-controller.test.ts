import { describe, expect, it, vi } from "vitest";

import { canonicalGraph, canonicalSource } from "../../export-compositor/canonical-test-fixture";
import { evaluateScene } from "../../export-compositor/scene-evaluator";
import { SequentialPreviewMediaController } from "../sequential-preview-media-controller";

function playableVideo(options: { currentTime?: number; paused?: boolean } = {}) {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      value: options.currentTime ?? 0,
      writable: true,
    },
    duration: { configurable: true, value: 10 },
    paused: { configurable: true, value: options.paused ?? false },
    readyState: { configurable: true, value: 2 },
    seeking: { configurable: true, value: false },
  });
  vi.spyOn(video, "pause").mockImplementation(() => undefined);
  return video;
}

describe("sequential preview media controller", () => {
  it("shares the clock video with canonical drawing without creating another decoder", async () => {
    const video = playableVideo();
    const createElement = vi.spyOn(document, "createElement");
    const graph = canonicalGraph([canonicalSource("source-a", 0, 1_000)]);
    const controller = new SequentialPreviewMediaController(() => video);

    await controller.configure(graph);

    expect(controller.source("source-a")).toBe(video);
    expect(createElement).not.toHaveBeenCalledWith("video");
    controller.dispose();
  });

  it("uses bounded playback-rate correction for small drift", async () => {
    const video = playableVideo({ currentTime: 0.05 });
    const graph = canonicalGraph([canonicalSource("source-a", 0, 1_000)]);
    const controller = new SequentialPreviewMediaController(() => video);
    await controller.configure(graph);

    await controller.prepare(evaluateScene(graph, 100));

    expect(video.currentTime).toBe(0.05);
    expect(video.playbackRate).toBeGreaterThan(1);
    expect(video.playbackRate).toBeLessThanOrEqual(1.03);
    expect(controller.diagnosticsSnapshot().drift_corrections).toBe(1);
    controller.dispose();
  });

  it("hard-seeks large drift and paused discontinuities", async () => {
    const video = playableVideo({ currentTime: 0.8 });
    const graph = canonicalGraph([canonicalSource("source-a", 0, 1_000)]);
    const controller = new SequentialPreviewMediaController(() => video);
    await controller.configure(graph);

    await controller.prepare(evaluateScene(graph, 100));
    expect(video.currentTime).toBeCloseTo(0.1);

    Object.defineProperty(video, "paused", { configurable: true, value: true });
    controller.hardSeek(400_000, "scrub");
    expect(video.currentTime).toBeCloseTo(0.4);
    expect(controller.diagnosticsSnapshot().hard_seeks).toBe(2);
    controller.dispose();
  });

  it("tracks presented, late, dropped, and coalesced preview work", () => {
    const video = playableVideo();
    const controller = new SequentialPreviewMediaController(() => video);

    controller.recordPresentedFrame(100, 16, 1);
    controller.recordPresentedFrame(140, 16, 3);
    controller.recordCoalescedRequest();

    expect(controller.diagnosticsSnapshot()).toEqual({
      presented_frames: 2,
      hard_seeks: 0,
      drift_corrections: 0,
      coalesced_requests: 1,
      dropped_or_late_frames: 2,
    });
    controller.dispose();
  });
});
