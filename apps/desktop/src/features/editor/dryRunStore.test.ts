/**
 * dryRunStore + useDryRun tests.
 *
 * 5 behaviors:
 * 1. Queued event sets statusByStep[step_id] = "queued"
 * 2. Pass event updates status + timing + fallbackChain
 * 3. Fail event sets status + persists fallback chain
 * 4. Summary event populates summary
 * 5. cancel() calls dryrun_cancel(taskId)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDryRunStore, type DryRunEvent } from "./dryRunStore";
import { useDryRun } from "./useDryRun";

// Mock Tauri invoke + Channel
const { mockInvoke, MockChannel } = vi.hoisted(() => {
  const mockInvoke = vi.fn().mockResolvedValue("dry-run-task-1");
  class MockChannel {
    onmessage: ((ev: unknown) => void) | null = null;
    id = 1;
    __TAURI_CHANNEL_MARKER__ = true;
    toJSON() {
      return `__CHANNEL__:${this.id}`;
    }
  }
  return { mockInvoke, MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  Channel: MockChannel,
}));

describe("dryRunStore", () => {
  beforeEach(() => {
    useDryRunStore.getState().reset();
  });

  it("Queued event sets statusByStep[step_id] = 'queued'", () => {
    const event: DryRunEvent = { kind: "Queued", step_id: "step-1" };
    act(() => {
      useDryRunStore.getState().handleEvent(event);
    });
    expect(useDryRunStore.getState().statusByStep["step-1"]).toBe("queued");
  });

  it("Pass event updates status + timing + fallbackChain", () => {
    const chain = [
      { strategy: "css", selector: "#btn", succeeded: true, durationMs: 50 },
    ];
    const event: DryRunEvent = {
      kind: "Pass",
      step_id: "step-2",
      duration_ms: 120,
      fallback_chain: chain,
    };
    act(() => {
      useDryRunStore.getState().handleEvent(event);
    });
    const state = useDryRunStore.getState();
    expect(state.statusByStep["step-2"]).toBe("pass");
    expect(state.timingByStep["step-2"]).toBe(120);
    expect(state.fallbackChainByStep["step-2"]).toEqual(chain);
  });

  it("Fail event sets status + persists fallback chain", () => {
    const chain = [
      { strategy: "css", selector: "#missing", succeeded: false, durationMs: 200 },
      { strategy: "xpath", selector: "//button", succeeded: false, durationMs: 300 },
    ];
    const event: DryRunEvent = {
      kind: "Fail",
      step_id: "step-3",
      duration_ms: 500,
      fallback_chain: chain,
    };
    act(() => {
      useDryRunStore.getState().handleEvent(event);
    });
    const state = useDryRunStore.getState();
    expect(state.statusByStep["step-3"]).toBe("fail");
    expect(state.fallbackChainByStep["step-3"]).toEqual(chain);
    expect(state.timingByStep["step-3"]).toBe(500);
  });

  it("Summary event populates summary", () => {
    const event: DryRunEvent = {
      kind: "Summary",
      summary: { total: 5, passed: 3, failed: 2, totalMs: 1200 },
    };
    act(() => {
      useDryRunStore.getState().handleEvent(event);
    });
    const state = useDryRunStore.getState();
    expect(state.summary).toEqual({
      total: 5,
      passed: 3,
      failed: 2,
      totalMs: 1200,
    });
    expect(state.panelOpen).toBe(true);
  });
});

describe("useDryRun", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue("dry-run-task-1");
    useDryRunStore.getState().reset();
  });

  it("cancel() calls dryrun_cancel with taskId", async () => {
    // Set a taskId in the store
    act(() => {
      useDryRunStore.getState().setTaskId("dry-run-task-1");
    });

    const { result } = renderHook(() => useDryRun("proj-1"));

    act(() => {
      result.current.cancel();
    });

    expect(mockInvoke).toHaveBeenCalledWith("dryrun_cancel", {
      taskId: "dry-run-task-1",
    });
  });
});
