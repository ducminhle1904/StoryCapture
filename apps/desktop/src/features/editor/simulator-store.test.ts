import { describe, it, expect, beforeEach } from "vitest";

import { useSimulatorStore } from "@/state/simulator-store";
import type { SimulatorEvent, SimulatorStepFrame } from "@/ipc/simulator";

function mkFrame(
  ordinal: number,
  match_kind: SimulatorStepFrame["match_kind"] = "primary",
): SimulatorStepFrame {
  return {
    ordinal,
    screenshot_path: `/tmp/frame-${ordinal}.png`,
    cursor_xy: [10, 20],
    matched_selector: match_kind === "none" ? null : `button#step-${ordinal}`,
    matched_bbox: match_kind === "none" ? null : { x: 0, y: 0, w: 10, h: 10 },
    match_kind,
    duration_ms: 42,
  };
}

describe("simulatorStore", () => {
  beforeEach(() => {
    useSimulatorStore.getState().resetToIdle();
    localStorage.removeItem("simulator:hintDismissed");
  });

  it("started event resets frames and enters running", () => {
    const ev: SimulatorEvent = {
      type: "started",
      session_id: "s1",
      run_id: "r1",
      total_steps: 5,
    };
    useSimulatorStore.getState().handleEvent(ev);
    const s = useSimulatorStore.getState();
    expect(s.runState).toBe("running");
    expect(s.sessionId).toBe("s1");
    expect(s.runId).toBe("r1");
    expect(s.totalSteps).toBe(5);
    expect(s.frames).toEqual([]);
    expect(s.currentFrameOrdinal).toBeNull();
    expect(s.error).toBeNull();
  });

  it("frame_captured appends frame and auto-follows ordinal", () => {
    useSimulatorStore.getState().handleEvent({
      type: "started",
      session_id: "s",
      run_id: "r",
      total_steps: 3,
    });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 1, frame: mkFrame(1) });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 2, frame: mkFrame(2, "fuzzy") });
    const s = useSimulatorStore.getState();
    expect(s.frames).toHaveLength(2);
    expect(s.currentFrameOrdinal).toBe(2);
    expect(s.frames[1].match_kind).toBe("fuzzy");
  });

  it("paused event transitions to paused and sets ordinal", () => {
    useSimulatorStore
      .getState()
      .handleEvent({ type: "started", session_id: "s", run_id: "r", total_steps: 4 });
    useSimulatorStore.getState().handleEvent({ type: "paused", ordinal: 2 });
    const s = useSimulatorStore.getState();
    expect(s.runState).toBe("paused");
    expect(s.currentFrameOrdinal).toBe(2);
  });

  it("completed and cancelled events transition run state", () => {
    useSimulatorStore
      .getState()
      .handleEvent({ type: "started", session_id: "s", run_id: "r", total_steps: 2 });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "completed", succeeded: 2, failed: 0 });
    expect(useSimulatorStore.getState().runState).toBe("complete");

    useSimulatorStore
      .getState()
      .handleEvent({ type: "started", session_id: "s2", run_id: "r2", total_steps: 2 });
    useSimulatorStore.getState().handleEvent({ type: "cancelled" });
    const s = useSimulatorStore.getState();
    expect(s.runState).toBe("cancelled");
    expect(s.sessionId).toBeNull();
  });

  it("failed event stores error and freezes ordinal", () => {
    useSimulatorStore
      .getState()
      .handleEvent({ type: "started", session_id: "s", run_id: "r", total_steps: 4 });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "failed", ordinal: 3, error_message: "selector not found" });
    const s = useSimulatorStore.getState();
    expect(s.runState).toBe("failed");
    expect(s.error).toBe("selector not found");
    expect(s.currentFrameOrdinal).toBe(3);
  });

  it("setCurrentFrameOrdinal clamps to captured frames", () => {
    useSimulatorStore
      .getState()
      .handleEvent({ type: "started", session_id: "s", run_id: "r", total_steps: 10 });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 1, frame: mkFrame(1) });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 2, frame: mkFrame(2) });

    useSimulatorStore.getState().setCurrentFrameOrdinal(99);
    expect(useSimulatorStore.getState().currentFrameOrdinal).toBe(2);

    useSimulatorStore.getState().setCurrentFrameOrdinal(0);
    expect(useSimulatorStore.getState().currentFrameOrdinal).toBe(1);

    useSimulatorStore.getState().setCurrentFrameOrdinal(null);
    expect(useSimulatorStore.getState().currentFrameOrdinal).toBeNull();
  });

  it("dismissCoexistenceHint persists to localStorage", () => {
    useSimulatorStore.getState().dismissCoexistenceHint();
    expect(useSimulatorStore.getState().dismissedCoexistenceHint).toBe(true);
    expect(localStorage.getItem("simulator:hintDismissed")).toBe("1");
  });
});
