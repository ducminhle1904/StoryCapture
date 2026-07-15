import { describe, expect, it, vi } from "vitest";
import { createCaptureBackendRequest } from "./capture-backend";
import { ElectronCaptureBackend } from "./electron-capture-backends";

describe("ElectronCaptureBackend", () => {
  it("owns sessions and makes stop/abort idempotent", async () => {
    const stop = vi.fn(async () => ({
      terminal_status: "stopped" as const,
      target_loss_reason: null,
      last_pts_us: 0,
    }));
    const abort = vi.fn(async () => undefined);
    const backend = new ElectronCaptureBackend("electron_external", {
      start: async () => "delegate-1",
      pause: async () => undefined,
      resume: async () => undefined,
      stop,
      abort,
    });
    const session = await backend.start(
      createCaptureBackendRequest({
        target: { kind: "display", display_id: 1 },
        width: 1280,
        height: 720,
        fps: 30,
        includeCursor: false,
      }),
      { deliver: async () => "accepted" },
    );
    const first = backend.stop(session);
    const second = backend.stop(session);
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({
      backend_id: "electron_external",
      session_id: session.session_id,
      terminal_status: "stopped",
    });
    expect(stop).toHaveBeenCalledTimes(1);
    await backend.abort(session, "late abort");
    expect(abort).not.toHaveBeenCalled();
  });

  it("rejects stale ownership tokens", async () => {
    const backend = new ElectronCaptureBackend("electron_external", {
      start: async () => "delegate-1",
      pause: async () => undefined,
      resume: async () => undefined,
      stop: async () => ({
        terminal_status: "stopped",
        target_loss_reason: null,
        last_pts_us: null,
      }),
      abort: async () => undefined,
    });
    const session = await backend.start(
      createCaptureBackendRequest({
        target: { kind: "display", display_id: 1 },
        width: 1280,
        height: 720,
        fps: 30,
        includeCursor: false,
      }),
      { deliver: async () => "accepted" },
    );
    expect(() => backend.pause({ ...session, ownership_token: "stale" })).toThrow(
      "ownership mismatch",
    );
  });
});
