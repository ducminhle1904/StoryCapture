import { describe, expect, it } from "vitest";

import { RecordingV3TransitionQueue } from "./recording-v3-transition-queue";

describe("RecordingV3TransitionQueue", () => {
  it("serializes overlapping lifecycle transitions", async () => {
    const queue = new RecordingV3TransitionQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = queue.run(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after a failed transition", async () => {
    const queue = new RecordingV3TransitionQueue();
    await expect(
      queue.run(async () => {
        throw new Error("failed transition");
      }),
    ).rejects.toThrow("failed transition");
    await expect(queue.run(async () => "recovered")).resolves.toBe("recovered");
  });
});
