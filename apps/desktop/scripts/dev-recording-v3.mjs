#!/usr/bin/env node
import { spawn } from "node:child_process";

const enableEnvironment = "STORYCAPTURE_ENABLE_UNCERTIFIED_RECORDING_V3";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("Recording V3 development requires macOS on Apple silicon.");
  process.exit(1);
}

function run(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmCommand, args, { stdio: "inherit", env });
    const forward = (signal) => child.kill(signal);
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve({ code: code ?? (signal ? 1 : 0), signal });
    });
  });
}

console.warn("\n*** Uncertified Development — not a Strict-certified recording ***\n");

const nativeBuild = await run(["native:build:recording-v3"]);
if (nativeBuild.code !== 0) process.exit(nativeBuild.code);

const development = await run(["electron:dev"], {
  ...process.env,
  [enableEnvironment]: "1",
});
process.exit(development.code);
