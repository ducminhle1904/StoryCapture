import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordingPauseGate } from "./recording-pause-gate";

describe("recording pause gate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("blocks checkpoints until resume", async () => {
    const gate = new RecordingPauseGate();
    gate.pause();
    const checkpoint = gate.waitUntilRunning();

    let settled = false;
    void checkpoint.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resume();
    await expect(checkpoint).resolves.toBe(true);
  });

  it("does not consume delay while paused", async () => {
    const gate = new RecordingPauseGate();
    const delay = gate.waitForDelay(1_000);

    await vi.advanceTimersByTimeAsync(400);
    gate.pause();
    await vi.advanceTimersByTimeAsync(5_000);
    gate.resume();
    await vi.advanceTimersByTimeAsync(599);

    let settled = false;
    void delay.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(delay).resolves.toBe(true);
  });

  it("releases paused work when cancelled", async () => {
    const gate = new RecordingPauseGate();
    gate.pause();
    const checkpoint = gate.waitUntilRunning();
    const delay = gate.waitForDelay(100);

    gate.cancel();

    await expect(checkpoint).resolves.toBe(false);
    await expect(delay).resolves.toBe(false);
  });
});
