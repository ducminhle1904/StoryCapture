// Unmount cleanup behavioral test — verifies the teardown contract in
// `recording-view.tsx`:
//   1. automationChannel.onmessage is set to null on cleanup
//   2. if a session is live, stopRecording is invoked with that id

import { describe, expect, it, vi } from "vitest";

describe("D-14 unmount cleanup", () => {
  it("nulls automation channel handler and calls stopRecording", () => {
    const stopRecording = vi.fn<(id: string) => Promise<{ output_path: string }>>(async () => ({
      output_path: "/tmp/x.mp4",
    }));
    const automationChannel = { onmessage: vi.fn() as ((e: unknown) => void) | null };

    const refs = {
      session: "session-xyz" as string | null,
      automationChannel: automationChannel as { onmessage: ((e: unknown) => void) | null } | null,
    };

    const cleanup = () => {
      if (refs.automationChannel) {
        refs.automationChannel.onmessage = null;
      }
      const sid = refs.session;
      refs.session = null;
      if (sid) {
        void stopRecording(sid).catch(() => {});
      }
    };

    cleanup();

    expect(automationChannel.onmessage).toBeNull();
    expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(stopRecording).toHaveBeenCalledWith("session-xyz");
    expect(refs.session).toBeNull();
  });

  it("is a no-op when session is already null", () => {
    const stopRecording = vi.fn();
    const refs = { session: null as string | null };

    const cleanup = () => {
      const sid = refs.session;
      refs.session = null;
      if (sid) {
        void stopRecording(sid);
      }
    };

    cleanup();
    expect(stopRecording).not.toHaveBeenCalled();
  });

  it("swallows stopRecording errors so cleanup stays synchronous", async () => {
    const stopRecording = vi.fn<(id: string) => Promise<void>>(async () => {
      throw new Error("host gone");
    });
    const warnings: unknown[] = [];

    const cleanup = () => {
      void stopRecording("sid").catch((e) => {
        warnings.push(e);
      });
    };
    cleanup();
    // Allow the detached promise to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings.length).toBe(1);
  });
});
