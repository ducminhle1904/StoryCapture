import { describe, expect, it } from "vitest";
import { sampleVirtualCursor } from "../virtual-cursor-path";
import { ACTIONS } from "./fixtures";

describe("sampleVirtualCursor", () => {
  it("starts at the center before the first action begins", () => {
    expect(sampleVirtualCursor(ACTIONS, 500)).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it("lands on the target at action time", () => {
    expect(sampleVirtualCursor(ACTIONS, 2000)).toMatchObject({ x: 0.8, y: 0.6 });
  });

  it("holds the final target after the action ends", () => {
    expect(sampleVirtualCursor(ACTIONS, 8000)).toMatchObject({ x: 0.8, y: 0.6 });
  });

  it("returns click ripple state during the click feedback window", () => {
    const sample = sampleVirtualCursor(ACTIONS, 2100);

    expect(sample?.ripple).toMatchObject({ x: 0.8, y: 0.6 });
    expect(sample?.ripple?.progress).toBeGreaterThan(0);
    expect(sample?.ripple?.opacity).toBeGreaterThan(0);
  });

  it("returns null when actions are unavailable", () => {
    expect(sampleVirtualCursor(null, 1000)).toBeNull();
  });
});
