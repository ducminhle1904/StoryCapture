import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingMasterEncoder } from "./recording-master";
import { SequentialMasterDecoder } from "./recording-master-decoder";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("SequentialMasterDecoder", () => {
  it("delivers exact BGRA frames by monotonically increasing frame index", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-decoder-test-"));
    roots.push(root);
    const masterPath = path.join(root, "master.mkv");
    const encoder = new RecordingMasterEncoder(16, 16, masterPath);
    const frames = [1, 2, 3].map((value) => new Uint8Array(16 * 16 * 4).fill(value));
    encoder.start();
    for (const frame of frames) await encoder.writeFrame(frame);
    await encoder.close();

    const decoder = new SequentialMasterDecoder(masterPath, 16, 16);
    expect(await decoder.readFrame(0)).toEqual(frames[0]);
    expect(await decoder.readFrame(2)).toEqual(frames[2]);
    await expect(decoder.readFrame(1)).rejects.toThrow(/sequential/);
    decoder.close();
  }, 30_000);
});
