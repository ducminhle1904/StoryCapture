import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  compositedFrameTimeMs,
  runCompositedExportForRenderSession,
  writeFrameWithBackpressure,
} from "./export-compositor";
import type { CompositedExportPlan } from "./export-planning";
import type { RenderSession } from "./shared";

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

  it("threads resampling quality and cleans up after a frame failure", async () => {
    const dispose = vi.fn(async () => undefined);
    const host = {
      start: vi.fn(async () => undefined),
      renderFrame: vi.fn(async () => {
        throw new Error("frame-dimension-mismatch");
      }),
      dispose,
      isDestroyed: vi.fn(() => false),
      window: { destroy: vi.fn() },
    };
    const createHost = vi.fn(() => host);
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 1));
      return true;
    });
    const spawnProcess = vi.fn(() => child);
    const session = {
      frame: 0,
      cancelRequested: false,
      cancelCompositedExport: null,
      ffmpegProcess: null,
      job: { progress_pct: 0, phase_progress_pct: 0 },
    } as unknown as RenderSession;
    const plan = {
      outputWidth: 2,
      outputHeight: 2,
      fps: 30,
      durationMs: 100,
      frameCount: 1,
      encoderOptions: { resamplingQuality: "fast" },
    } as unknown as CompositedExportPlan;

    await expect(
      runCompositedExportForRenderSession(session, plan, vi.fn(), ["-f", "rawvideo"], undefined, {
        createHost: createHost as never,
        ffmpegPath: () => "/mock/ffmpeg",
        spawnProcess: spawnProcess as never,
      }),
    ).rejects.toThrow("frame-dimension-mismatch");

    expect(createHost).toHaveBeenCalledWith(expect.objectContaining({ resamplingQuality: "fast" }));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(dispose).toHaveBeenCalledOnce();
    expect(session.ffmpegProcess).toBeNull();
    expect(session.cancelCompositedExport).toBeNull();
  });
});
