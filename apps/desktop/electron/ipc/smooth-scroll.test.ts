import { describe, expect, it, vi } from "vitest";

import type { InteractionObservation } from "./interaction-readiness";
import {
  easeInOutCubic,
  ensureTargetVisible,
  executeControlledScroll,
  smoothScrollDurationMs,
  TargetVisibilityPhaseError,
} from "./smooth-scroll";

function ready(x = 100, y = 100): InteractionObservation {
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

function mockedContents(planCount = 1) {
  return {
    isDestroyed: () => false,
    executeJavaScript: vi.fn(async (script: string) => {
      if (script.includes("viewportDiagonal")) {
        return { distance: 1_000, viewportDiagonal: 1_000, planCount };
      }
      return true;
    }),
  };
}

describe("smooth scroll helpers", () => {
  it("clamps duration and easing endpoints", () => {
    expect(smoothScrollDurationMs(0, 1_000)).toBe(300);
    expect(smoothScrollDurationMs(1_000, 1_000)).toBe(600);
    expect(smoothScrollDurationMs(10_000, 1_000)).toBe(900);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it("animates before returning a stable final target", async () => {
    const contents = mockedContents();
    const observations: InteractionObservation[] = [
      { status: "not_ready", reason: "outside_viewport" },
      ready(200, 300),
      ready(200, 300),
      ready(200, 300),
    ];
    const result = await ensureTargetVisible({
      contents: contents as never,
      target: { kind: "test_id", value: "target" },
      observe: async () => observations.shift() ?? ready(200, 300),
      wait: async () => true,
      now: (() => {
        let time = 1_000;
        return () => (time += 600);
      })(),
    });

    expect(result.target.center).toEqual({ x: 200, y: 300 });
    expect(result.scrollTiming).toMatchObject({ durationMs: 600 });
    expect(contents.executeJavaScript).toHaveBeenCalled();
  });

  it("re-resolves a detached target before preparing a scroll plan", async () => {
    const contents = mockedContents();
    const observations: InteractionObservation[] = [
      { status: "not_ready", reason: "detached" },
      ready(240, 320),
      ready(240, 320),
    ];

    const result = await ensureTargetVisible({
      contents: contents as never,
      target: { kind: "role", value: { role: "textbox", name: "Search Wikipedia" } },
      observe: async () => observations.shift() ?? ready(240, 320),
      wait: async () => true,
    });

    expect(result.target.center).toEqual({ x: 240, y: 320 });
    expect(
      contents.executeJavaScript.mock.calls.some(([script]) =>
        String(script).includes("viewportDiagonal"),
      ),
    ).toBe(false);
  });

  it("executes explicit targeted vh scroll with clamped applied distance", async () => {
    const contents = {
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes("requestedAmount")) {
          return {
            distance: 400,
            viewportDiagonal: 1_000,
            planCount: 1,
            requestedAmount: 500,
            appliedAmount: 400,
          };
        }
        return true;
      }),
    };
    const result = await executeControlledScroll({
      contents: contents as never,
      target: { kind: "test_id", value: "results" },
      targetNth: 2,
      direction: "down",
      amount: 50,
      unit: "vh",
      wait: async () => true,
      now: (() => {
        let time = 0;
        return () => (time += 420);
      })(),
    });
    expect(result).toMatchObject({ requestedAmountPx: 500, appliedAmountPx: 400 });
    expect(result.scrollTiming?.durationMs).toBe(420);
    expect(contents.executeJavaScript.mock.calls[0]?.[0]).toContain("results");
  });

  it("uses bounded overlay reposition attempts", async () => {
    const contents = mockedContents(0);
    await expect(
      ensureTargetVisible({
        contents: contents as never,
        target: { kind: "test_id", value: "target" },
        observe: async () => ({ status: "not_ready", reason: "covered" }),
        wait: async () => true,
      }),
    ).rejects.toMatchObject({
      name: "TargetVisibilityPhaseError",
      phase: "overlay",
      reason: "covered",
    });
    const prepareCalls = contents.executeJavaScript.mock.calls.filter(([script]) =>
      String(script).includes("viewportDiagonal"),
    );
    expect(prepareCalls).toHaveLength(4);
    const cleanupCalls = contents.executeJavaScript.mock.calls.filter(([script]) =>
      String(script).includes("delete registry"),
    );
    expect(cleanupCalls).toHaveLength(4);
  });

  it("aborts promptly when cancellation is requested", async () => {
    const contents = mockedContents();
    await expect(
      ensureTargetVisible({
        contents: contents as never,
        target: { kind: "test_id", value: "target" },
        observe: async () => ({ status: "not_ready", reason: "outside_viewport" }),
        wait: async () => true,
        shouldCancel: () => true,
      }),
    ).rejects.toBeInstanceOf(TargetVisibilityPhaseError);
  });
});
