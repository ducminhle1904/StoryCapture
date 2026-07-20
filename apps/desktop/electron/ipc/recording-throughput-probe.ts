import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RecordingPreflightV2Request } from "@storycapture/shared-types/recording-v2";
import { RecordingMasterEncoder } from "./recording-master";

export interface RecordingThroughputProbeOptions {
  frameCount?: number;
  nowNanoseconds?: () => bigint;
}

function fillRepresentativeScreenFrame(frame: Uint8Array, frameIndex: number): void {
  let state = (0x9e3779b9 ^ frameIndex) >>> 0;
  for (let offset = 0; offset < frame.byteLength; offset += 4) {
    state = (Math.imul(state ^ (state >>> 15), 0x85ebca6b) + 0xc2b2ae35) >>> 0;
    const tile = ((offset >>> 9) + frameIndex * 7) & 0xff;
    frame[offset] = (state & 0x3f) + (tile & 0x80);
    frame[offset + 1] = ((state >>> 8) & 0x3f) + (tile & 0x40);
    frame[offset + 2] = ((state >>> 16) & 0x3f) + (tile & 0x20);
    frame[offset + 3] = 255;
  }
}

export async function measureRecordingMasterThroughput(
  exportsDir: string,
  request: RecordingPreflightV2Request,
  options: RecordingThroughputProbeOptions = {},
): Promise<number> {
  const frameCount = options.frameCount ?? 120;
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new Error("Recording throughput probe frame count must be a positive integer.");
  }
  const { physical_width: width, physical_height: height } = request.dimensions;
  await fs.mkdir(exportsDir, { recursive: true });
  const outputPath = path.join(exportsDir, `.recording-throughput-${randomUUID()}.mkv`);
  const now = options.nowNanoseconds ?? process.hrtime.bigint;
  const encoder = new RecordingMasterEncoder(width, height, outputPath);
  const frame = new Uint8Array(width * height * 4);
  const startedAt = now();
  try {
    encoder.start();
    for (let index = 0; index < frameCount; index += 1) {
      fillRepresentativeScreenFrame(frame, index);
      await encoder.writeFrame(frame);
    }
    await encoder.close();
    const elapsedSeconds = Number(now() - startedAt) / 1_000_000_000;
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
      throw new Error("Recording throughput probe clock did not advance.");
    }
    return frameCount / elapsedSeconds / 60;
  } catch (error) {
    encoder.abort();
    throw error;
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}
