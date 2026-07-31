import { describe, expect, it } from "vitest";

import { runtimeEdgeSpreadIncrease, stableColorChannelDelta } from "./recording-v4-runtime-quality";

function frame(width: number, height: number, color = 255): Buffer {
  const value = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < value.length; offset += 4) {
    value[offset] = color;
    value[offset + 1] = color;
    value[offset + 2] = color;
    value[offset + 3] = 255;
  }
  return value;
}

describe("Recording V4 runtime quality metrics", () => {
  it("scores identical marker-free content without requiring a certification marker", () => {
    const reference = frame(256, 256);
    expect(runtimeEdgeSpreadIncrease(reference, Buffer.from(reference), 256, 256)).toBe(0);
    expect(stableColorChannelDelta(reference, Buffer.from(reference), 256, 256)).toBe(0);
  });

  it("detects a widened high-contrast edge", () => {
    const reference = frame(256, 256, 0);
    const actual = frame(256, 256, 0);
    for (let y = 0; y < 256; y += 1) {
      for (let x = 128; x < 256; x += 1) {
        const offset = (y * 256 + x) * 4;
        reference.fill(255, offset, offset + 3);
        const softened = x === 128 ? 85 : x === 129 ? 170 : 255;
        actual.fill(softened, offset, offset + 3);
      }
    }
    expect(runtimeEdgeSpreadIncrease(reference, actual, 256, 256)).toBeGreaterThan(1);
  });

  it("ignores native rounded-window corners and measures stable interior color", () => {
    const reference = frame(256, 256);
    const actual = frame(256, 256, 252);
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        actual.fill(0, (y * 256 + x) * 4, (y * 256 + x) * 4 + 3);
      }
    }
    expect(stableColorChannelDelta(reference, actual, 256, 256)).toBe(3);
  });
});
