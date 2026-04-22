// D-15 — heartbeat watchdog behavioral test.
//
// Mirrors the dispatch + interval logic in `recording-view.tsx`:
//   - A "heartbeat" RecordingEvent resets `lastHeartbeat` and clears desync.
//   - While status === "recording", a 1s interval flips `desynced` true
//     when Date.now() - lastHeartbeat > 5000.
//   - A subsequent heartbeat clears desync.
//   - "Force stop" handler calls stopRecording, tolerates NotFound, and
//     always flips status to "idle".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface State {
  status: "recording" | "idle";
  lastHeartbeat: number | null;
  desynced: boolean;
}

function makeWatchdog(state: State) {
  return setInterval(() => {
    if (state.status !== "recording") return;
    const last = state.lastHeartbeat;
    if (last == null) return;
    if (Date.now() - last > 5000) {
      state.desynced = true;
    }
  }, 1000);
}

describe("D-15 heartbeat watchdog", () => {
  it("stays calm while heartbeats arrive within 5s", () => {
    const state: State = { status: "recording", lastHeartbeat: Date.now(), desynced: false };
    const h = makeWatchdog(state);

    vi.advanceTimersByTime(3500);
    // Another heartbeat before the 5s budget elapses.
    state.lastHeartbeat = Date.now();
    vi.advanceTimersByTime(3500);

    expect(state.desynced).toBe(false);
    clearInterval(h);
  });

  it("flips desynced=true when >5s since last heartbeat", () => {
    const state: State = { status: "recording", lastHeartbeat: Date.now(), desynced: false };
    const h = makeWatchdog(state);

    vi.advanceTimersByTime(6100);

    expect(state.desynced).toBe(true);
    clearInterval(h);
  });

  it("clears desynced when a fresh heartbeat dispatches", () => {
    const state: State = { status: "recording", lastHeartbeat: Date.now(), desynced: false };
    const h = makeWatchdog(state);

    vi.advanceTimersByTime(6100);
    expect(state.desynced).toBe(true);

    // Simulate dispatch("heartbeat"): reset ref + clear flag.
    state.lastHeartbeat = Date.now();
    state.desynced = false;

    vi.advanceTimersByTime(2000);
    expect(state.desynced).toBe(false);
    clearInterval(h);
  });

  it("forceStop calls stopRecording and resets to idle even on NotFound", async () => {
    const stopRecording = vi.fn<(id: string) => Promise<void>>(async () => {
      throw Object.assign(new Error("NotFound: session xyz"), { kind: "NotFound" });
    });

    const state: {
      status: string;
      session: string | null;
      desynced: boolean;
    } = { status: "recording", session: "sid-1", desynced: true };

    const forceStop = async () => {
      const sid = state.session;
      state.session = null;
      state.desynced = false;
      try {
        if (sid) await stopRecording(sid);
      } catch {
        /* NotFound treated as success */
      }
      state.status = "idle";
    };

    vi.useRealTimers();
    await forceStop();

    expect(stopRecording).toHaveBeenCalledWith("sid-1");
    expect(state.status).toBe("idle");
    expect(state.session).toBeNull();
  });
});
