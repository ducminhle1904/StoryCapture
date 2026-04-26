// Double-start guard behavioral test.
//
// Verifies the pattern used inside `recording-view.tsx::handleRecord`:
//   1. read current `status` synchronously from the Zustand store
//   2. bail if it's anything other than "idle"
//   3. flip the store to "starting" BEFORE awaiting the IPC call
//
// With that ordering, two synchronous invocations of the handler inside a
// single JS tick can result in at most one IPC call.

import { useRecorderStore } from "@/state/recorder";
import { afterEach, describe, expect, it, vi } from "vitest";

function resetStore() {
  useRecorderStore.getState().reset();
}

afterEach(() => resetStore());

describe("D-04 double-start guard", () => {
  it("only fires the IPC call once when the handler is invoked twice synchronously", async () => {
    const invoke = vi.fn(async () => {
      // Simulate a slow start_recording that hasn't resolved yet.
      await new Promise((r) => setTimeout(r, 20));
      return "session-1";
    });

    const startHandler = async () => {
      const { status, setStatus } = useRecorderStore.getState();
      if (status !== "idle") return;
      setStatus("starting");
      try {
        await invoke();
        useRecorderStore.getState().setStatus("recording");
      } catch {
        useRecorderStore.getState().setStatus("idle");
      }
    };

    // Two clicks within the same microtask window.
    const first = startHandler();
    const second = startHandler();
    await Promise.all([first, second]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useRecorderStore.getState().status).toBe("recording");
  });

  it("resets to idle on error so the next click can succeed", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("boom"));

    const startHandler = async () => {
      const { status, setStatus } = useRecorderStore.getState();
      if (status !== "idle") return;
      setStatus("starting");
      try {
        await invoke();
        useRecorderStore.getState().setStatus("recording");
      } catch {
        useRecorderStore.getState().setStatus("idle");
      }
    };

    await startHandler();
    expect(useRecorderStore.getState().status).toBe("idle");

    // Second click now succeeds because status is back to idle.
    invoke.mockResolvedValueOnce("session-2");
    await startHandler();
    expect(useRecorderStore.getState().status).toBe("recording");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("accepts the new 'starting' status value in the union", () => {
    useRecorderStore.getState().setStatus("starting");
    expect(useRecorderStore.getState().status).toBe("starting");
  });
});
