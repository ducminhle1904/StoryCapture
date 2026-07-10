import { describe, expect, it } from "vitest";
import shortGapV1 from "@/ipc/__fixtures__/action-sidecars/v1-short-gap.actions.json";
import explicitV2 from "@/ipc/__fixtures__/action-sidecars/v2-explicit-timing.actions.json";
import { parseActionSidecar } from "@/ipc/action-sidecar";

import { buildVirtualCursorSchedule } from "../state/virtual-cursor-scheduler";

describe("virtual cursor scheduler invariants", () => {
  it("compresses or snaps legacy motion at the browser input boundary", () => {
    const actions = parseActionSidecar(shortGapV1);
    const schedule = buildVirtualCursorSchedule(actions, "natural");
    const submit = schedule?.segments.find((segment) => segment.event.step_id === "submit");

    expect(submit).toBeDefined();
    expect(submit).toMatchObject({
      startMs: 1108,
      arrivalMs: 1108,
      travelMs: 0,
      compressed: true,
      snapped: true,
      effectMs: 1108,
    });
    expect(
      schedule?.segments.every(
        (segment) =>
          segment.arrivalMs <= (segment.event.input_timing?.action_ms ?? segment.event.t_action_ms),
      ),
    ).toBe(true);
  });

  it("keeps valid v2 timing and falls back only for the invalid event", () => {
    const actions = parseActionSidecar(explicitV2);
    const schedule = buildVirtualCursorSchedule(actions, "natural");

    expect(schedule?.segments[0]).toMatchObject({
      startMs: 1000,
      arrivalMs: 1320,
      travelMs: 320,
      requestedTravelMs: 320,
      compressed: false,
      effectMs: 1500,
    });
    expect(schedule?.segments[1]).toMatchObject({
      startMs: 1700,
      arrivalMs: 1800,
      travelMs: 100,
      compressed: true,
      effectMs: 1800,
    });
  });

  it("preserves full requested motion only when explicitly enabled and reports exact holds", () => {
    const actions = parseActionSidecar(shortGapV1);
    const defaultSchedule = buildVirtualCursorSchedule(actions, "cinematic");
    const preserved = buildVirtualCursorSchedule(actions, "cinematic", {
      preserveFullMotion: true,
    });
    const defaultSubmit = defaultSchedule?.segments.find(
      (segment) => segment.event.step_id === "submit",
    );
    const preservedSubmit = preserved?.segments.find(
      (segment) => segment.event.step_id === "submit",
    );
    expect(defaultSubmit?.compressed).toBe(true);
    expect(defaultSchedule?.holds).toEqual([]);
    expect(preservedSubmit?.travelMs).toBe(preservedSubmit?.requestedTravelMs);
    expect(preservedSubmit?.compressed).toBe(false);
    expect(preserved?.holds.every((hold) => Number.isInteger(hold.durationUs))).toBe(true);
    expect(preserved?.totalInsertedHoldMs).toBeGreaterThan(0);
    expect(preservedSubmit?.arrivalMs).toBeLessThanOrEqual(preservedSubmit?.effectMs ?? -1);
  });
});
