import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionTarget } from "./action-timeline";
import { dragDurationMsForDistance, executeDragPlan, planDragExecution } from "./drag-execution";
import { buildRuntimeTargetCandidates } from "./runtime-target-candidates";
import type { ParsedCommand } from "./story-parser";

function target(label: string, x: number, y: number): ActionTarget {
  return {
    kind: "element",
    label,
    center: { x, y },
    bounds: { x: x - 10, y: y - 10, w: 20, h: 20 },
  };
}

function plan() {
  return planDragExecution({
    source: target("Source", 100, 120),
    destination: target("Destination", 420, 260),
    fps: 30,
    motionPreset: "natural",
    eventKey: "drag-step",
  });
}

describe("drag execution", () => {
  beforeEach(() => {
    vi.stubEnv("STORYCAPTURE_DRAG_EXECUTION_MODE", "on");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("plans a deterministic cadence-bounded path ending at the destination", () => {
    const first = plan();
    const second = plan();
    expect(second).toEqual(first);
    expect(first.durationMs).toBe(dragDurationMsForDistance(Math.hypot(320, 140), "natural"));
    expect(first.samples.at(-1)).toMatchObject({ x: 420, y: 260, elapsedMs: first.durationMs });
    expect(first.samples.length).toBeLessThanOrEqual(Math.ceil(first.durationMs / (1_000 / 30)));
  });

  it("emits exactly one down and one up around the sampled pressed path", async () => {
    const events: Array<Record<string, unknown>> = [];
    const landmarks: string[] = [];
    const result = await executeDragPlan({
      plan: plan(),
      sendInputEvent: (event) => events.push(event),
      wait: async () => true,
      onInputSideEffect: (kind) => landmarks.push(kind),
    });

    expect(events.filter((event) => event.type === "mouseDown")).toHaveLength(1);
    expect(events.filter((event) => event.type === "mouseUp")).toHaveLength(1);
    expect(events.filter((event) => event.type === "mouseMove")).toHaveLength(
      plan().samples.length,
    );
    expect(landmarks).toEqual(["down", "up", "action"]);
    expect(result).toMatchObject({
      cursor: { x: 420, y: 260 },
      pointer: { button: "left", effect: "drag" },
    });
  });

  it("does not send input when cancelled before mouse-down", async () => {
    const events: Array<Record<string, unknown>> = [];
    await expect(
      executeDragPlan({
        plan: plan(),
        sendInputEvent: (event) => events.push(event),
        wait: async () => true,
        shouldCancel: () => true,
      }),
    ).rejects.toMatchObject({
      reason: "cancelled_before_input",
      inputStarted: false,
    });
    expect(events).toEqual([]);
  });

  it("releases once when cancellation or destination loss happens after mouse-down", async () => {
    for (const failure of ["cancel", "target"] as const) {
      const events: Array<Record<string, unknown>> = [];
      let cancelChecks = 0;
      await expect(
        executeDragPlan({
          plan: plan(),
          sendInputEvent: (event) => events.push(event),
          wait: async () => true,
          shouldCancel:
            failure === "cancel"
              ? () => {
                  cancelChecks += 1;
                  return cancelChecks > 1;
                }
              : undefined,
          beforePressedPath: failure === "target" ? async () => false : undefined,
        }),
      ).rejects.toMatchObject({
        inputStarted: true,
        reason: failure === "cancel" ? "cancelled_after_input" : "target_lost_after_input",
      });
      expect(events.filter((event) => event.type === "mouseDown")).toHaveLength(1);
      expect(events.filter((event) => event.type === "mouseUp")).toHaveLength(1);
    }
  });

  it("freezes pressed movement while the pause-aware wait is pending", async () => {
    const events: Array<Record<string, unknown>> = [];
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let waits = 0;
    const running = executeDragPlan({
      plan: plan(),
      sendInputEvent: (event) => events.push(event),
      wait: async () => {
        waits += 1;
        if (waits === 1) await blocked;
        return true;
      },
    });

    await vi.waitFor(() => expect(waits).toBe(1));
    expect(events.map((event) => event.type)).toEqual(["mouseDown"]);
    resume();
    await running;
    expect(events.at(-1)?.type).toBe("mouseUp");
  });

  it("attempts release cleanup when pointer delivery throws", async () => {
    const events: string[] = [];
    await expect(
      executeDragPlan({
        plan: plan(),
        sendInputEvent: (event) => {
          events.push(String(event.type));
          if (event.type === "mouseMove") throw new Error("delivery failed");
        },
        wait: async () => true,
      }),
    ).rejects.toMatchObject({ reason: "delivery_failed", inputStarted: true });
    expect(events).toContain("mouseUp");
  });

  it("stays explicitly disabled unless the internal rollout flag is enabled", async () => {
    vi.stubEnv("STORYCAPTURE_DRAG_EXECUTION_MODE", "off");
    await expect(
      executeDragPlan({ plan: plan(), sendInputEvent: () => {}, wait: async () => true }),
    ).rejects.toMatchObject({ reason: "disabled", inputStarted: false });
  });

  it("orders source and destination sidecar candidates independently", () => {
    const command = {
      verb: "drag",
      step_id: "drag-step",
      from: { kind: "label", value: "Story source" },
      to: { kind: "label", value: "Story destination" },
    } as ParsedCommand;
    const sidecar = {
      version: 1,
      steps: {
        "drag-step": {
          from: {
            primary: { kind: "label", value: "Promoted source" },
            fallbacks: [{ kind: "label", value: "Fallback source" }],
          },
          to: {
            primary: { kind: "label", value: "Promoted destination" },
            fallbacks: [{ kind: "label", value: "Fallback destination" }],
          },
        },
      },
    };

    expect(
      buildRuntimeTargetCandidates({ command, sidecar, endpointKey: "from" }).candidates.map(
        (candidate) => candidate.source,
      ),
    ).toEqual(["sidecar_primary", "story_target", "sidecar_fallback"]);
    expect(
      buildRuntimeTargetCandidates({ command, sidecar, endpointKey: "to" }).candidates.map(
        (candidate) => candidate.source,
      ),
    ).toEqual(["sidecar_primary", "story_target", "sidecar_fallback"]);
  });
});
