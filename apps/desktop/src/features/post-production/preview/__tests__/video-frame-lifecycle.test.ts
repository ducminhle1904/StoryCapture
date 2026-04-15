import { describe, expect, it, vi } from "vitest";
import { withVideoFrame } from "../video-frame-lifecycle";

function makeFrame() {
  const close = vi.fn();
  return { close } as unknown as VideoFrame & { close: ReturnType<typeof vi.fn> };
}

describe("withVideoFrame", () => {
  it("withVideoFrame_closes_on_success: close() called exactly once", async () => {
    const frame = makeFrame();
    const result = await withVideoFrame(
      async () => frame,
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it("withVideoFrame_closes_on_error: close() called exactly once and error propagates", async () => {
    const frame = makeFrame();
    const boom = new Error("boom");
    await expect(
      withVideoFrame(
        async () => frame,
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it("withVideoFrame_not_double_closes: helper never calls close twice", async () => {
    const frame = makeFrame();
    await withVideoFrame(
      async () => frame,
      async () => 42,
    );
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it("withVideoFrame_swallows_close_error: already-closed frame does not throw", async () => {
    const frame = {
      close: vi.fn(() => {
        throw new Error("already closed");
      }),
    } as unknown as VideoFrame;
    // Should resolve normally even though close() throws.
    await expect(
      withVideoFrame(
        async () => frame,
        async () => "ok",
      ),
    ).resolves.toBe("ok");
  });

  it("withVideoFrame_propagates_acquire_error: if acquire rejects, use is not called, no close", async () => {
    const use = vi.fn();
    const boom = new Error("acquire-fail");
    await expect(
      withVideoFrame(async () => {
        throw boom;
      }, use),
    ).rejects.toBe(boom);
    expect(use).not.toHaveBeenCalled();
  });
});
