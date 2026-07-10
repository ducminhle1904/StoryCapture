#!/usr/bin/env node
import { spawn } from "node:child_process";

const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const args = Object.fromEntries(
  process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);
const video = args.video;
const roi = args.roi;
const expectedFrame = Number(args["expected-frame"]);
const tolerance = Number(args.tolerance ?? 1);
const threshold = Number(args.threshold ?? 8);
if (!video || !/^\d+:\d+:\d+:\d+$/.test(roi ?? "") || !Number.isInteger(expectedFrame)) {
  throw new Error(
    "usage: analyze-cursor-sync-roi.mjs --video=... --roi=x:y:w:h --expected-frame=N [--tolerance=1]",
  );
}
const [x, y, width, height] = roi.split(":").map(Number);
if (
  x < 0 ||
  y < 0 ||
  width <= 0 ||
  height <= 0 ||
  expectedFrame < 0 ||
  !Number.isInteger(tolerance) ||
  tolerance < 0 ||
  !Number.isFinite(threshold) ||
  threshold < 0
) {
  throw new Error(
    "ROI and numeric options must be finite and non-negative; width/height must be positive",
  );
}
const frameBytes = width * height;
const child = spawn(
  ffmpegPath,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    video,
    "-vf",
    `crop=${width}:${height}:${x}:${y},format=gray`,
    "-f",
    "rawvideo",
    "pipe:1",
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
let pending = Buffer.alloc(0);
let baseline = null;
let frameIndex = 0;
let firstChangedFrame = null;
child.stdout.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= frameBytes) {
    const frame = pending.subarray(0, frameBytes);
    pending = pending.subarray(frameBytes);
    if (!baseline) baseline = Buffer.from(frame);
    else if (firstChangedFrame == null) {
      let difference = 0;
      for (let index = 0; index < frame.length; index += 1) {
        difference += Math.abs(frame[index] - baseline[index]);
      }
      if (difference / frame.length >= threshold) firstChangedFrame = frameIndex;
    }
    frameIndex += 1;
  }
});
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
if (exitCode !== 0) throw new Error(`ffmpeg exited with ${exitCode}`);
const deltaFrames = firstChangedFrame == null ? null : firstChangedFrame - expectedFrame;
console.log(
  JSON.stringify({
    first_changed_frame: firstChangedFrame,
    expected_frame: expectedFrame,
    delta_frames: deltaFrames,
    decoded_frames: frameIndex,
  }),
);
if (deltaFrames == null || Math.abs(deltaFrames) > tolerance) process.exitCode = 1;
