import { describe, expect, it } from "vitest";

import {
  findPixelBounds,
  frameSsim,
  maximumBoundsDelta,
  maximumColorDelta,
  sampleBgra,
} from "./export-quality-gate";

function frame(width: number, height: number, paint?: (buffer: Buffer) => void): Buffer {
  const buffer = Buffer.alloc(width * height * 4, 255);
  paint?.(buffer);
  return buffer;
}

describe("export quality gate metrics", () => {
  it("scores identical frames at one and rejects malformed frame sizes", () => {
    const reference = frame(9, 9);
    expect(frameSsim(reference, Buffer.from(reference), 9, 9)).toBeCloseTo(1, 10);
    expect(() => frameSsim(reference, Buffer.alloc(8), 9, 9)).toThrow(/expected 324/i);
  });

  it("finds thresholded overlay bounds and reports the largest geometry delta", () => {
    const reference = frame(4, 4, (buffer) => {
      for (const [x, y] of [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
      ]) {
        const offset = (y * 4 + x) * 4;
        buffer[offset] = 20;
        buffer[offset + 1] = 30;
        buffer[offset + 2] = 240;
      }
    });
    const bounds = findPixelBounds(
      reference,
      4,
      4,
      ({ red, green, blue }) => red > 200 && green < 80 && blue < 80,
    );
    expect(bounds).toEqual({ left: 1, top: 1, right: 2, bottom: 2 });
    if (!bounds) throw new Error("expected marker bounds");
    expect(maximumBoundsDelta(bounds, { left: 0, top: 1, right: 2, bottom: 3 })).toBe(1);
  });

  it("samples BGRA pixels and reports the largest channel delta", () => {
    const source = frame(2, 2, (buffer) => {
      buffer.set([10, 20, 30, 255], 4);
    });
    const sample = sampleBgra(source, 2, 2, 1, 0);
    expect(sample).toEqual({ blue: 10, green: 20, red: 30 });
    expect(maximumColorDelta(sample, { blue: 12, green: 17, red: 31 })).toBe(3);
  });
});
