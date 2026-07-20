import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ffmpegExecutablePath } from "./export-binaries";
import {
  decodeAudioFileToPcm,
  ffv1MasterArgs,
  parseRecordingMasterCapabilities,
  probeRecordingMasterCapabilities,
  RecordingMasterEncoder,
  transcodeAudioFileToPcmWav,
  verifyDecodedFrameHashes,
  verifyMasterAndCreateProxy,
  writePcmWav,
} from "./recording-master";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("recording master", () => {
  it("requires exact 60/1 and builds FFV1 level 3 BGRA arguments", () => {
    expect(ffv1MasterArgs({ width: 2, height: 2, outputPath: "/master.mkv" })).toEqual(
      expect.arrayContaining(["ffv1", "3", "16", "bgra", "60/1"]),
    );
    expect(() =>
      ffv1MasterArgs({
        width: 2,
        height: 2,
        fpsNumerator: 60_000,
        fpsDenominator: 1_001,
        outputPath: "/master.mkv",
      }),
    ).toThrow(/60\/1/);
  });

  it("parses the required packaged capability surface", () => {
    expect(
      parseRecordingMasterCapabilities("ffv1 bgra matroska pcm_s16le libx264 scale ssim"),
    ).toMatchObject({ complete: true });
  });

  it("probes the bundled FFmpeg capability surface on the active target", async () => {
    await expect(probeRecordingMasterCapabilities()).resolves.toMatchObject({ complete: true });
  });

  it("rejects decoded frame hash or count changes", () => {
    const frame = new Uint8Array(16).fill(1);
    const ledger = [
      {
        frame_index: 0,
        source_sequence: 1,
        native_pts_us: 0,
        sha256: createHash("sha256").update(frame).digest("hex"),
      },
    ];
    expect(() => verifyDecodedFrameHashes([frame], ledger)).not.toThrow();
    expect(() => verifyDecodedFrameHashes([new Uint8Array(16)], ledger)).toThrow(/hash mismatch/);
    expect(() => verifyDecodedFrameHashes([], ledger)).toThrow(/frame count/);
  });

  it("writes a valid PCM WAV header", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-wav-test-"));
    roots.push(root);
    const file = path.join(root, "audio.wav");
    await writePcmWav(file, { sampleRate: 48_000, channels: 1, samples: new Int16Array([1, -1]) });
    const bytes = await fs.readFile(file);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
    expect(bytes.readUInt32LE(24)).toBe(48_000);
    const decoded = await decodeAudioFileToPcm(file, { sampleRate: 48_000, channels: 1 });
    expect(Array.from(decoded.samples)).toEqual([1, -1]);
  });

  it("streams an input audio file into a PCM WAV sidecar", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-wav-stream-test-"));
    roots.push(root);
    const input = path.join(root, "input.wav");
    const output = path.join(root, "output.wav");
    await writePcmWav(input, {
      sampleRate: 48_000,
      channels: 1,
      samples: new Int16Array([1, -1, 2, -2]),
    });
    await transcodeAudioFileToPcmWav(input, output, { channels: 1 });
    const bytes = await fs.readFile(output);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  });

  it("round-trips deterministic BGRA frames through FFV1 and makes a proxy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-ffv1-test-"));
    roots.push(root);
    const masterPath = path.join(root, "master.mkv");
    const proxyPath = path.join(root, "proxy.mp4");
    const encoder = new RecordingMasterEncoder(16, 16, masterPath, ffmpegExecutablePath());
    const frames = Array.from({ length: 6 }, (_, index) =>
      new Uint8Array(16 * 16 * 4).fill(index * 20),
    );
    const ledger = frames.map((frame, index) => ({
      frame_index: index,
      source_sequence: index + 1,
      native_pts_us: Math.round((index * 1_000_000) / 60),
      sha256: createHash("sha256").update(frame).digest("hex"),
    }));
    encoder.start();
    for (const frame of frames) await encoder.writeFrame(frame);
    await encoder.close();
    await verifyMasterAndCreateProxy({ masterPath, proxyPath, width: 16, height: 16, ledger });
    await expect(fs.stat(masterPath)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(fs.stat(proxyPath)).resolves.toMatchObject({ size: expect.any(Number) });
  }, 30_000);
});
