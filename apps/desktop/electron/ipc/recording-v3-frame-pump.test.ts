import { describe, expect, it, vi } from "vitest";

import { RecordingV3FramePump } from "./recording-v3-frame-pump";

function setup() {
  const deferred: Array<() => void> = [];
  let destroyed = false;
  const target = {
    isDestroyed: vi.fn(() => destroyed),
    startPainting: vi.fn(),
    stopPainting: vi.fn(),
    invalidate: vi.fn(),
  };
  const pump = new RecordingV3FramePump(target, (callback) => deferred.push(callback));
  return {
    deferred,
    pump,
    setDestroyed(value: boolean) {
      destroyed = value;
    },
    target,
  };
}

describe("RecordingV3FramePump", () => {
  it("starts painting and defers the initial invalidation", () => {
    const { deferred, pump, target } = setup();

    pump.start();

    expect(target.startPainting).toHaveBeenCalledOnce();
    expect(target.invalidate).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    deferred.shift()?.();
    expect(target.invalidate).toHaveBeenCalledOnce();
  });

  it("coalesces requests and keeps start idempotent while running", () => {
    const { deferred, pump, target } = setup();

    pump.start();
    pump.start();
    pump.requestNext();
    pump.requestNext();

    expect(target.startPainting).toHaveBeenCalledOnce();
    expect(deferred).toHaveLength(1);
    deferred.shift()?.();
    pump.requestNext();
    expect(deferred).toHaveLength(1);
    deferred.shift()?.();
    expect(target.invalidate).toHaveBeenCalledTimes(2);
    expect(deferred).toHaveLength(0);
  });

  it("cancels stale callbacks across an idempotent stop and restart", () => {
    const { deferred, pump, target } = setup();

    pump.start();
    const stale = deferred.shift();
    pump.stop();
    pump.stop();
    pump.start();
    const current = deferred.shift();

    stale?.();
    expect(target.invalidate).not.toHaveBeenCalled();
    current?.();
    expect(target.invalidate).toHaveBeenCalledOnce();
    expect(target.startPainting).toHaveBeenCalledTimes(2);
    expect(target.stopPainting).toHaveBeenCalledOnce();
  });

  it("does not touch a destroyed target", () => {
    const { deferred, pump, setDestroyed, target } = setup();

    pump.start();
    setDestroyed(true);
    deferred.shift()?.();
    pump.stop();
    pump.start();

    expect(target.invalidate).not.toHaveBeenCalled();
    expect(target.stopPainting).not.toHaveBeenCalled();
    expect(target.startPainting).toHaveBeenCalledOnce();
  });
});
