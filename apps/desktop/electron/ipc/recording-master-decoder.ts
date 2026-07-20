import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { ffmpegExecutablePath } from "./export-binaries";
import type { InvokeHandlers } from "./types";

interface DecoderOpenArgs {
  path: string;
  width: number;
  height: number;
}

interface FramePort {
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void;
}

class SequentialByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending = Buffer.alloc(0);
  private ended = false;

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async readExact(bytes: number): Promise<Buffer | null> {
    while (this.pending.byteLength < bytes && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      this.pending = Buffer.concat([this.pending, Buffer.from(next.value)]);
    }
    if (this.pending.byteLength === 0 && this.ended) return null;
    if (this.pending.byteLength < bytes)
      throw new Error("master decoder ended with a partial frame");
    const frame = Buffer.from(this.pending.subarray(0, bytes));
    this.pending = this.pending.subarray(bytes);
    return frame;
  }
}

export class SequentialMasterDecoder {
  private readonly child: ReturnType<typeof spawn>;
  private readonly reader: SequentialByteReader;
  private nextFrameIndex = 0;
  private queue = Promise.resolve();

  constructor(
    readonly path: string,
    readonly width: number,
    readonly height: number,
    binary = ffmpegExecutablePath(),
  ) {
    if (
      !path ||
      !Number.isInteger(width) ||
      width <= 0 ||
      !Number.isInteger(height) ||
      height <= 0
    ) {
      throw new Error("master decoder requires a path and positive dimensions");
    }
    this.child = spawn(
      binary,
      ["-v", "error", "-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "bgra", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!this.child.stdout) throw new Error("master decoder stdout is unavailable");
    this.reader = new SequentialByteReader(this.child.stdout);
  }

  readFrame(frameIndex: number): Promise<Uint8Array> {
    if (!Number.isInteger(frameIndex) || frameIndex < this.nextFrameIndex) {
      return Promise.reject(
        new Error(`master decoder requires sequential frame indices >= ${this.nextFrameIndex}`),
      );
    }
    const operation = this.queue.then(async () => {
      let decoded: Buffer | null = null;
      while (this.nextFrameIndex <= frameIndex) {
        const frame = await this.reader.readExact(this.width * this.height * 4);
        if (!frame) throw new Error(`master decoder reached EOF before frame ${frameIndex}`);
        decoded = frame;
        this.nextFrameIndex += 1;
      }
      if (!decoded) throw new Error(`master decoder did not produce frame ${frameIndex}`);
      return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength).slice();
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async deliverFrame(frameIndex: number, port: FramePort): Promise<void> {
    const bytes = await this.readFrame(frameIndex);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    port.postMessage(
      { frame_index: frameIndex, width: this.width, height: this.height, bytes: buffer },
      [buffer],
    );
  }

  close(): void {
    this.child.kill("SIGKILL");
  }
}

const decoders = new Map<string, SequentialMasterDecoder>();

function payload(args: unknown): Record<string, unknown> {
  const outer = (args ?? {}) as Record<string, unknown>;
  return (outer.args as Record<string, unknown> | undefined) ?? outer;
}

export const recordingMasterDecoderHandlers = {
  open_recording_master_decoder: (args) => {
    const value = payload(args) as unknown as DecoderOpenArgs;
    const id = randomUUID();
    decoders.set(id, new SequentialMasterDecoder(value.path, value.width, value.height));
    return { id };
  },
  decode_recording_master_frame: async (args) => {
    const value = payload(args);
    const id = String(value.id ?? "");
    const decoder = decoders.get(id);
    if (!decoder) throw new Error(`recording master decoder ${id} not found`);
    return decoder.readFrame(Number(value.frame_index));
  },
  close_recording_master_decoder: (args) => {
    const value = payload(args);
    const id = String(value.id ?? "");
    decoders.get(id)?.close();
    decoders.delete(id);
    return null;
  },
} satisfies InvokeHandlers;
