import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { afterEach, describe, expect, it } from "vitest";

import { parseFfmpegProbeOutput, probeRecording } from "./media-probe";
import { discoverProjectRecordings } from "./recording-discovery";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

async function makeFixture(name: string, args: string[]): Promise<string> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary is unavailable");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-probe-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await execFileAsync(ffmpegPath, ["-y", ...args, file]);
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("recording media probe", () => {
  it("extracts duration, codec, dimensions and container from ffmpeg output", () => {
    expect(
      parseFfmpegProbeOutput(
        "Input #0, mov,mp4,m4a, from 'demo.mp4':\n  Duration: 00:00:02.50\n  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080",
      ),
    ).toEqual({ duration_ms: 2500, codec: "h264", width: 1920, height: 1080, container: "mov" });
  });

  it("rejects an empty recording before spawning ffmpeg", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-probe-"));
    tempDirs.push(dir);
    const file = path.join(dir, "empty.mp4");
    await fs.writeFile(file, "");
    await expect(probeRecording(file)).resolves.toEqual({ status: "invalid", reason: "empty" });
  });

  it("validates a real MP4 and reports useful metadata within the probe timeout", async () => {
    const file = await makeFixture("valid.mp4", [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=12",
      "-t",
      "0.5",
      "-c:v",
      "libaom-av1",
      "-cpu-used",
      "8",
      "-crf",
      "45",
      "-pix_fmt",
      "yuv420p",
    ]);
    const startedAt = performance.now();
    const result = await probeRecording(file);
    const latencyMs = performance.now() - startedAt;

    expect(result).toMatchObject({ status: "valid", width: 160, height: 90, codec: "av1" });
    expect(latencyMs).toBeLessThan(5_000);
  });

  it("rejects truncated and audio-only MP4 fixtures", async () => {
    const valid = await makeFixture("source.mp4", [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=1",
      "-t",
      "1",
      "-c:v",
      "libaom-av1",
      "-cpu-used",
      "8",
      "-crf",
      "50",
    ]);
    const truncated = path.join(path.dirname(valid), "truncated.mp4");
    await fs.writeFile(truncated, (await fs.readFile(valid)).subarray(0, 32));
    const audioOnly = await makeFixture("audio-only.mp4", [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.25",
      "-c:a",
      "aac",
    ]);

    await expect(probeRecording(truncated)).resolves.toEqual({
      status: "invalid",
      reason: "unsupported_or_corrupt",
    });
    await expect(probeRecording(audioOnly)).resolves.toEqual({
      status: "invalid",
      reason: "unsupported_or_corrupt",
    });
  });

  it("classifies a recording that disappears between discovery and probe", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-"));
    tempDirs.push(dir);
    const file = path.join(dir, "latest.mp4");
    await fs.writeFile(file, "pending");

    const recordings = await discoverProjectRecordings(dir, async (candidate) => {
      await fs.rm(candidate);
      return probeRecording(candidate);
    });

    expect(recordings[0]?.validation).toEqual({ status: "invalid", reason: "missing" });
  });

  it("keeps an invalid latest recording first instead of silently falling back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-discovery-"));
    tempDirs.push(dir);
    const older = path.join(dir, "older.mp4");
    const latest = path.join(dir, "latest.mp4");
    await fs.writeFile(older, "older");
    await fs.writeFile(latest, "latest");
    await fs.utimes(older, 1, 1);
    await fs.utimes(latest, 2, 2);

    const recordings = await discoverProjectRecordings(dir, async (file) =>
      file === latest
        ? { status: "invalid", reason: "unsupported_or_corrupt" }
        : { status: "valid", duration_ms: 1, width: 1, height: 1, codec: "h264", container: "mov" },
    );
    expect(recordings.map((recording) => path.basename(recording.path))).toEqual([
      "latest.mp4",
      "older.mp4",
    ]);
    expect(recordings[0]?.validation).toEqual({
      status: "invalid",
      reason: "unsupported_or_corrupt",
    });
    expect(recordings[1]?.validation).toEqual({ status: "unvalidated" });
  });
});
