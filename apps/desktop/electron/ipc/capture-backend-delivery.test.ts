import { describe, expect, it, vi } from "vitest";
import {
  CaptureBackendContractError,
  CaptureBackendDeliveryGuard,
  type CaptureBackendSession,
} from "./capture-backend";

const session: CaptureBackendSession = {
  backend_id: "electron_external",
  session_id: "session-1",
  ownership_token: "owner-1",
};

describe("CaptureBackendDeliveryGuard", () => {
  it("requires explicit monotonic frame index and PTS", async () => {
    const deliver = vi.fn(async () => "accepted" as const);
    const guard = new CaptureBackendDeliveryGuard(session, { deliver });
    await expect(
      guard.deliver({
        type: "frame",
        backend_id: session.backend_id,
        session_id: session.session_id,
        sequence: 0,
        frame_index: 0,
        pts_us: 0,
        duration_us: 33_333,
        width: 1280,
        height: 720,
        pixel_format: "bgra",
        payload: new Uint8Array(4),
      }),
    ).resolves.toBe("accepted");
    await expect(
      guard.deliver({
        type: "frame",
        backend_id: session.backend_id,
        session_id: session.session_id,
        sequence: 1,
        frame_index: 1,
        pts_us: 0,
        duration_us: 33_333,
        width: 1280,
        height: 720,
        pixel_format: "bgra",
        payload: new Uint8Array(4),
      }),
    ).rejects.toMatchObject({ reason: "delivery_invalid" });
  });

  it("accepts one targetLost and rejects every later delivery", async () => {
    const guard = new CaptureBackendDeliveryGuard(session, {
      deliver: async () => "accepted",
    });
    await guard.deliver({
      type: "targetLost",
      backend_id: session.backend_id,
      session_id: session.session_id,
      sequence: 0,
      reason: "window_closed",
      observed_at_us: 1,
      last_pts_us: null,
    });
    try {
      await guard.deliver({
        type: "targetLost",
        backend_id: session.backend_id,
        session_id: session.session_id,
        sequence: 1,
        reason: "window_closed",
        observed_at_us: 2,
        last_pts_us: null,
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CaptureBackendContractError);
      expect((error as CaptureBackendContractError).reason).toBe("delivery_after_terminal");
    }
  });

  it("rejects stale backend/session ownership", async () => {
    const guard = new CaptureBackendDeliveryGuard(session, { deliver: async () => "accepted" });
    await expect(
      guard.deliver({
        type: "targetLost",
        backend_id: "other",
        session_id: session.session_id,
        sequence: 0,
        reason: "source_unresolvable",
        observed_at_us: 1,
        last_pts_us: null,
      }),
    ).rejects.toMatchObject({ reason: "session_mismatch" });
  });

  it("does not advance ordering state when the sink applies backpressure", async () => {
    const deliver = vi.fn(async (): Promise<"accepted" | "backpressured"> => "accepted");
    deliver.mockResolvedValueOnce("backpressured");
    const guard = new CaptureBackendDeliveryGuard(session, { deliver });
    const frame = {
      type: "frame" as const,
      backend_id: session.backend_id,
      session_id: session.session_id,
      sequence: 0,
      frame_index: 0,
      pts_us: 0,
      duration_us: 33_333,
      width: 1280,
      height: 720,
      pixel_format: "bgra" as const,
      payload: new Uint8Array(4),
    };

    await expect(guard.deliver(frame)).resolves.toBe("backpressured");
    await expect(guard.deliver(frame)).resolves.toBe("accepted");
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
