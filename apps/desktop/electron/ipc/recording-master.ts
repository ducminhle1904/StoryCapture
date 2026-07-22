import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { ffmpegExecutablePath } from "./export-binaries";
import { probeRecordingDimensions } from "./media-probe";
import type { RecordingFrameLedgerEntry } from "./recording-frame-ring";

export interface RecordingMasterCapabilities {
  ffv1: boolean;
  bgra: boolean;
  matroska: boolean;
  pcmS16le: boolean;
  h264: boolean;
  scale: boolean;
  ssim: boolean;
  complete: boolean;
}

export function parseRecordingMasterCapabilities(output: string): RecordingMasterCapabilities {
  const lower = output.toLowerCase();
  const capabilities = {
    ffv1: /\bffv1\b/.test(lower),
    bgra: /\bbgra\b/.test(lower),
    matroska: /\bmatroska\b/.test(lower),
    pcmS16le: /\bpcm_s16le\b/.test(lower),
    h264: /\b(?:libx264|h264)\b/.test(lower),
    scale: /\bscale\b/.test(lower),
    ssim: /\bssim\b/.test(lower),
  };
  return { ...capabilities, complete: Object.values(capabilities).every(Boolean) };
}

async function commandOutput(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`FFmpeg capability probe exited ${code}`)),
    );
  });
}

export async function probeRecordingMasterCapabilities(
  binary = ffmpegExecutablePath(),
): Promise<RecordingMasterCapabilities> {
  const outputs = await Promise.all([
    commandOutput(binary, ["-hide_banner", "-encoders"]),
    commandOutput(binary, ["-hide_banner", "-pix_fmts"]),
    commandOutput(binary, ["-hide_banner", "-muxers"]),
    commandOutput(binary, ["-hide_banner", "-filters"]),
  ]);
  return parseRecordingMasterCapabilities(outputs.join("\n"));
}

export function ffv1MasterArgs(input: {
  width: number;
  height: number;
  fpsNumerator?: number;
  fpsDenominator?: number;
  outputPath: string;
}): string[] {
  const numerator = input.fpsNumerator ?? 60;
  const denominator = input.fpsDenominator ?? 1;
  if (numerator !== 60 || denominator !== 1) throw new Error("Strict master requires exact 60/1");
  return [
    "-y",
    "-f",
    "rawvideo",
    "-pixel_format",
    "bgra",
    "-video_size",
    `${input.width}x${input.height}`,
    "-framerate",
    "60/1",
    "-i",
    "pipe:0",
    "-an",
    "-c:v",
    "ffv1",
    "-level",
    "3",
    "-g",
    "1",
    "-slices",
    "16",
    "-slicecrc",
    "1",
    "-pix_fmt",
    "bgra",
    "-r",
    "60/1",
    input.outputPath,
  ];
}

async function writeWithBackpressure(stream: Writable, bytes: Uint8Array): Promise<void> {
  if (stream.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

export class RecordingMasterEncoder {
  private child: ReturnType<typeof spawn> | null = null;
  private done: Promise<void> | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly outputPath: string,
    private readonly binary = ffmpegExecutablePath(),
  ) {}

  start(): void {
    if (this.child) throw new Error("recording master encoder already started");
    const child = spawn(
      this.binary,
      ffv1MasterArgs({ width: this.width, height: this.height, outputPath: this.outputPath }),
      {
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    this.done = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`FFV1 encoder exited ${code}: ${stderr}`)),
      );
    });
    this.child = child;
  }

  async writeFrame(pixels: Uint8Array): Promise<void> {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed)
      throw new Error("recording master encoder is not writable");
    if (pixels.byteLength !== this.width * this.height * 4) {
      throw new Error(`master frame byte length ${pixels.byteLength} is invalid`);
    }
    await writeWithBackpressure(child.stdin, pixels);
  }

  async close(): Promise<void> {
    const child = this.child;
    const done = this.done;
    if (!child || !done) throw new Error("recording master encoder was not started");
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    await done;
    this.child = null;
    this.done = null;
  }

  abort(): void {
    this.child?.kill("SIGKILL");
    this.child = null;
    this.done = null;
  }
}

export interface PcmWavInput {
  sampleRate: 48_000;
  channels: 1 | 2;
  samples: Int16Array;
}

export async function writePcmWav(filePath: string, input: PcmWavInput): Promise<void> {
  const dataBytes = input.samples.byteLength;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(input.channels, 22);
  header.writeUInt32LE(input.sampleRate, 24);
  header.writeUInt32LE(input.sampleRate * input.channels * 2, 28);
  header.writeUInt16LE(input.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  const sampleBytes = Buffer.from(
    input.samples.buffer,
    input.samples.byteOffset,
    input.samples.byteLength,
  );
  await fs.writeFile(filePath, Buffer.concat([header, sampleBytes]));
}

export async function transcodeAudioFileToPcmWav(
  inputPath: string,
  outputPath: string,
  options: { sampleRate?: 48_000; channels?: 1 | 2; binary?: string } = {},
): Promise<void> {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 2;
  const binary = options.binary ?? ffmpegExecutablePath();
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.tmp-${randomUUID()}`,
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        binary,
        [
          "-y",
          "-v",
          "error",
          "-i",
          inputPath,
          "-vn",
          "-c:a",
          "pcm_s16le",
          "-ar",
          String(sampleRate),
          "-ac",
          String(channels),
          "-f",
          "wav",
          temporaryPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${String(chunk)}`.slice(-4_000);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code) =>
        finish(
          code === 0
            ? undefined
            : new Error(`audio PCM transcode exited ${String(code)}: ${stderr}`),
        ),
      );
    });
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function decodeAudioFileToPcm(
  inputPath: string,
  options: { sampleRate?: 48_000; channels?: 1 | 2; binary?: string } = {},
): Promise<PcmWavInput> {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 2;
  const binary = options.binary ?? ffmpegExecutablePath();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "-v",
        "error",
        "-i",
        inputPath,
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        String(channels),
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`audio PCM decode exited ${String(code)}: ${stderr}`));
    });
  });
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new Error("audio PCM decode produced an empty or partial sample");
  }
  const aligned = Uint8Array.from(bytes);
  return {
    sampleRate,
    channels,
    samples: new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2),
  };
}

export function verifyDecodedFrameHashes(
  decodedFrames: readonly Uint8Array[],
  ledger: readonly RecordingFrameLedgerEntry[],
): void {
  if (decodedFrames.length !== ledger.length) {
    throw new Error(
      `decoded frame count ${decodedFrames.length} does not match ledger ${ledger.length}`,
    );
  }
  decodedFrames.forEach((frame, index) => {
    const hash = createHash("sha256").update(frame).digest("hex");
    if (hash !== ledger[index]?.sha256) {
      throw new Error(`decoded frame ${index} hash mismatch`);
    }
  });
}

export async function verifyMasterAndCreateProxy(input: {
  masterPath: string;
  proxyPath: string;
  width: number;
  height: number;
  ledger: readonly RecordingFrameLedgerEntry[];
  binary?: string;
}): Promise<void> {
  const frameBytes = input.width * input.height * 4;
  const binary = input.binary ?? ffmpegExecutablePath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "-y",
        "-i",
        input.masterPath,
        "-map",
        "0:v:0",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "pipe:1",
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        "-preset",
        "medium",
        "-r",
        "60/1",
        "-movflags",
        "+faststart",
        input.proxyPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const frameBuffer = Buffer.allocUnsafe(frameBytes);
    let frameOffset = 0;
    let frameIndex = 0;
    let stderr = "";
    let verificationError: Error | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (verificationError) return;
      let chunkOffset = 0;
      while (chunkOffset < chunk.byteLength) {
        const copyBytes = Math.min(frameBytes - frameOffset, chunk.byteLength - chunkOffset);
        chunk.copy(frameBuffer, frameOffset, chunkOffset, chunkOffset + copyBytes);
        frameOffset += copyBytes;
        chunkOffset += copyBytes;
        if (frameOffset !== frameBytes) continue;
        const expected = input.ledger[frameIndex];
        const hash = createHash("sha256").update(frameBuffer).digest("hex");
        if (!expected || hash !== expected.sha256) {
          verificationError = new Error(`decoded master frame ${frameIndex} hash mismatch`);
          child.kill("SIGKILL");
          return;
        }
        frameIndex += 1;
        frameOffset = 0;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (verificationError) return reject(verificationError);
      if (code !== 0)
        return reject(new Error(`master verification/proxy exited ${code}: ${stderr}`));
      if (frameOffset !== 0) return reject(new Error("decoded master ended with a partial frame"));
      if (frameIndex !== input.ledger.length) {
        return reject(
          new Error(`decoded ${frameIndex} master frames; expected ${input.ledger.length}`),
        );
      }
      resolve();
    });
  });
  const probe = await probeRecordingDimensions(input.masterPath);
  if (probe.status !== "valid") {
    throw new Error(`decoded master probe was ${probe.reason}`);
  }
  if (probe.width !== input.width || probe.height !== input.height) {
    throw new Error(
      `decoded master dimensions ${probe.width}x${probe.height} do not match requested ${input.width}x${input.height}`,
    );
  }
}
