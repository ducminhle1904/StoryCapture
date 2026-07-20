#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const helperRoot = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== "darwin") {
  throw new Error("ScreenCaptureKit helper can only be built on macOS");
}

await execFileAsync(
  "/usr/bin/swift",
  ["build", "--package-path", helperRoot, "--configuration", "release"],
  {
    env: {
      ...process.env,
      SWIFT_MODULE_CACHE_PATH: path.join(helperRoot, ".build", "module-cache"),
    },
    maxBuffer: 10 * 1024 * 1024,
  },
);

const binary = path.join(helperRoot, ".build", "release", "storycapture-screen-capture-helper");
await fs.access(binary, fs.constants.X_OK);
process.stdout.write(`${binary}\n`);
