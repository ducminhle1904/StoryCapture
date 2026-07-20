import { describe, expect, it } from "vitest";
import { BoundedNativeFrameRing, type RecordingFrameRingError } from "./recording-frame-ring";

function frame(value: number): Uint8Array {
  return new Uint8Array(2 * 2 * 4).fill(value);
}

describe("BoundedNativeFrameRing", () => {
  it("preserves exact frame bytes, sequence, PTS, and hash order", () => {
    const ring = new BoundedNativeFrameRing(2, 2, 2);
    const first = ring.push({ sourceSequence: 1, nativePtsUs: 0, pixels: frame(1) });
    ring.push({ sourceSequence: 2, nativePtsUs: 16_667, pixels: frame(2) });

    const lease = ring.take();
    expect(lease).toMatchObject(first);
    expect(Array.from(lease?.pixels ?? [])).toEqual(Array.from(frame(1)));
    lease?.release();
    expect(ring.take()).toMatchObject({
      frame_index: 1,
      source_sequence: 2,
      native_pts_us: 16_667,
    });
  });

  it("fails closed on overflow, sequence gaps, duplicate PTS, and malformed bytes", () => {
    const ring = new BoundedNativeFrameRing(2, 2, 2);
    ring.push({ sourceSequence: 1, nativePtsUs: 0, pixels: frame(1) });
    expect(() => ring.push({ sourceSequence: 3, nativePtsUs: 16_667, pixels: frame(2) })).toThrow(
      expect.objectContaining<Partial<RecordingFrameRingError>>({ code: "source_sequence_gap" }),
    );
    expect(() => ring.push({ sourceSequence: 2, nativePtsUs: 0, pixels: frame(2) })).toThrow(
      expect.objectContaining<Partial<RecordingFrameRingError>>({ code: "artifact_pts_duplicate" }),
    );
    expect(() =>
      ring.push({ sourceSequence: 2, nativePtsUs: 16_667, pixels: new Uint8Array(3) }),
    ).toThrow(
      expect.objectContaining<Partial<RecordingFrameRingError>>({ code: "contract_mismatch" }),
    );
    ring.push({ sourceSequence: 2, nativePtsUs: 16_667, pixels: frame(2) });
    expect(() => ring.push({ sourceSequence: 3, nativePtsUs: 33_333, pixels: frame(3) })).toThrow(
      expect.objectContaining<Partial<RecordingFrameRingError>>({ code: "frame_ring_overflow" }),
    );
  });
});
