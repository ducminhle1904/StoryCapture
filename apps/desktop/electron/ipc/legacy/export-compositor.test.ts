import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { compositedFrameTimeMs, writeFrameWithBackpressure } from "./export-compositor";

describe("post-production export compositor helpers", () => {
  it("calculates deterministic frame timestamps from fps", () => {
    expect(compositedFrameTimeMs(0, 60)).toBe(0);
    expect(compositedFrameTimeMs(30, 60)).toBe(500);
    expect(compositedFrameTimeMs(60, 60)).toBe(1000);
  });

  it("waits for stdin drain when ffmpeg applies backpressure", async () => {
    let bytes = 0;
    const sink = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        bytes += chunk.byteLength;
        setTimeout(callback, 5);
      },
    });

    await writeFrameWithBackpressure(sink, Buffer.alloc(16));

    expect(bytes).toBe(16);
    sink.destroy();
  });

  it("cleans up backpressure listeners after drain", async () => {
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setTimeout(callback, 1);
      },
    });

    for (let index = 0; index < 12; index += 1) {
      await writeFrameWithBackpressure(sink, Buffer.alloc(16));
    }

    expect(sink.listenerCount("drain")).toBe(0);
    expect(sink.listenerCount("error")).toBe(0);
    expect(sink.listenerCount("close")).toBe(0);
    expect(sink.listenerCount("finish")).toBe(0);
    sink.destroy();
  });

  it("rejects when stdin closes before backpressure drains", async () => {
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        // Intentionally wait forever; the close event must unblock the writer.
      },
    });

    const write = writeFrameWithBackpressure(sink, Buffer.alloc(16));
    setImmediate(() => sink.destroy());

    await expect(write).rejects.toThrow(/closed before drain/);
  });

  it("rejects writes after stdin has closed", async () => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    sink.end();

    await expect(writeFrameWithBackpressure(sink, Buffer.alloc(4))).rejects.toThrow(/closed/);
  });
});
