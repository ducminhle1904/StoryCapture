#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appPath = process.argv[2];

if (process.platform !== "darwin") {
  throw new Error("packaged ScreenCaptureKit smoke requires macOS");
}
if (!appPath?.endsWith(".app")) {
  throw new Error("usage: verify-packaged-helper.mjs /path/to/StoryCapture.app");
}

const helper = path.join(
  appPath,
  "Contents",
  "Resources",
  "native",
  "macos",
  "storycapture-screen-capture-helper",
);
await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", helper]);

const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });

function request(command, requestID, version) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${command} timed out`)), 5_000);
    const onLine = (line) => {
      const response = JSON.parse(line);
      if (response.request_id !== requestID) return;
      clearTimeout(timeout);
      lines.off("line", onLine);
      if (response.ok) resolve(response);
      else reject(new Error(`${response.code}: ${response.message}`));
    };
    lines.on("line", onLine);
    child.stdin.write(`${JSON.stringify({ version, request_id: requestID, command })}\n`);
  });
}

const hello = await request("hello", "packaged-v2-hello", 2);
if (
  hello.data?.backend_id !== "screen-capture-kit" ||
  hello.data?.supports_native_timestamps !== true ||
  hello.data?.supports_physical_pixels !== true
) {
  throw new Error("packaged ScreenCaptureKit helper reported an invalid capability contract");
}
const nativeMaster = await request("hello", "packaged-v3-hello", 3);
if (
  nativeMaster.version !== 3 ||
  nativeMaster.data?.backend_id !== "screen-capture-kit" ||
  nativeMaster.data?.backend_version !== "3.0.0" ||
  nativeMaster.data?.supports_native_master !== true ||
  nativeMaster.data?.supports_hardware_h264 !== true ||
  nativeMaster.data?.supports_cfr_held_frames !== true ||
  nativeMaster.data?.supports_atomic_finalization !== true ||
  nativeMaster.data?.encoder?.id !== "videotoolbox-h264" ||
  nativeMaster.data?.encoder?.hardware_accelerated !== true
) {
  throw new Error("packaged ScreenCaptureKit helper reported an invalid V3 native-master contract");
}
await request("shutdown", "packaged-v3-shutdown", 3);
process.stdout.write("packaged ScreenCaptureKit helper signature and V2/V3 protocols passed\n");
