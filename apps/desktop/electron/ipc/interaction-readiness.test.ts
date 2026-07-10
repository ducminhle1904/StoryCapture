import { describe, expect, it, vi } from "vitest";

import {
  type InteractionObservation,
  type InteractionReadinessError,
  waitForInteractionReadiness,
} from "./interaction-readiness";

function ready(x: number, y: number): InteractionObservation {
  return {
    status: "ready",
    target: {
      kind: "element",
      label: "Target",
      center: { x, y },
      bounds: { x: x - 10, y: y - 10, w: 20, h: 20 },
    },
  };
}

describe("interaction readiness", () => {
  it("requires stable consecutive geometry observations", async () => {
    const observations = [ready(10, 10), ready(30, 30), ready(30.5, 30.5)];
    const result = await waitForInteractionReadiness({
      observe: vi.fn(async () => observations.shift() ?? ready(30.5, 30.5)),
      wait: async () => true,
      timeoutMs: 1_000,
      stabilityThresholdPx: 1,
    });

    expect(result.target.center).toEqual({ x: 30.5, y: 30.5 });
    expect(result.observations).toBe(3);
  });

  it("uses active wait time and ignores unrelated network activity", async () => {
    const observe = vi
      .fn<() => Promise<InteractionObservation>>()
      .mockResolvedValueOnce({ status: "not_ready", reason: "not_found" })
      .mockResolvedValueOnce({ status: "not_ready", reason: "covered" })
      .mockResolvedValue(ready(50, 50));
    const wait = vi.fn(async () => true);

    const result = await waitForInteractionReadiness({
      observe,
      wait,
      timeoutMs: 6_000,
      stableObservations: 1,
    });

    expect(result.elapsedActiveMs).toBe(200);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("returns a typed terminal reason without waiting forever", async () => {
    await expect(
      waitForInteractionReadiness({
        observe: async () => ({ status: "not_ready", reason: "disabled" }),
        wait: async () => true,
        timeoutMs: 250,
        pollIntervalMs: 100,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<InteractionReadinessError>>({ reason: "disabled" }),
    );
  });
});
