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

function request(command, requestID) {
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
    child.stdin.write(`${JSON.stringify({ version: 2, request_id: requestID, command })}\n`);
  });
}

const hello = await request("hello", "packaged-hello");
if (
  hello.data?.backend_id !== "screen-capture-kit" ||
  hello.data?.supports_native_timestamps !== true ||
  hello.data?.supports_physical_pixels !== true
) {
  throw new Error("packaged ScreenCaptureKit helper reported an invalid capability contract");
}
await request("shutdown", "packaged-shutdown");
process.stdout.write("packaged ScreenCaptureKit helper signature and V2 protocol passed\n");
