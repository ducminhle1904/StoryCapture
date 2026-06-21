#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let currentChild = null;
const devChildren = new Set();
let stoppingSignal = null;

function prefixStream(stream, label, output) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      output.write(`[${label}] ${buffer.slice(0, newlineIndex + 1)}`);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      output.write(`[${label}] ${buffer}\n`);
    }
  });
}

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: desktopRoot,
    stdio: options.prefix ? ["inherit", "pipe", "pipe"] : "inherit",
  });

  if (options.prefix) {
    prefixStream(child.stdout, options.prefix, process.stdout);
    prefixStream(child.stderr, options.prefix, process.stderr);
  }

  return child;
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawnChild(command, args);
    currentChild = child;

    child.on("exit", (code, signal) => {
      if (currentChild === child) {
        currentChild = null;
      }
      resolve({ code, signal });
    });
  });
}

function exitCodeFor(result) {
  if (stoppingSignal || result.signal === "SIGINT" || result.signal === "SIGTERM") {
    return 0;
  }
  return result.code ?? 1;
}

function waitForServer(url, timeoutMs = 60_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (stoppingSignal) {
        resolve(false);
        return;
      }
      const request = http.get(url, (response) => {
        response.resume();
        resolve(true);
      });
      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(check, 250);
      });
      request.setTimeout(1000, () => {
        request.destroy();
      });
    }
    check();
  });
}

function stopDevChildren(signal = stoppingSignal ?? "SIGTERM") {
  for (const child of devChildren) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stoppingSignal = signal;
    currentChild?.kill(signal);
    stopDevChildren(signal);
  });
}

const buildResult = await run(pnpmCommand, ["electron:build-main"]);
if (exitCodeFor(buildResult) !== 0) {
  process.exit(exitCodeFor(buildResult));
}

const vite = spawnChild(pnpmCommand, ["exec", "vite", "--host", "127.0.0.1", "--strictPort"], {
  prefix: "vite",
});
devChildren.add(vite);

let electron = null;
let settled = false;

function settle(code) {
  if (settled) {
    return;
  }
  settled = true;
  stopDevChildren();
  process.exit(stoppingSignal ? 0 : code);
}

vite.on("exit", (code, signal) => {
  devChildren.delete(vite);
  if (!settled && !stoppingSignal) {
    settle(signal === "SIGINT" || signal === "SIGTERM" ? 0 : (code ?? 1));
  }
});

try {
  const ready = await waitForServer("http://127.0.0.1:1420");
  if (!ready) {
    settle(0);
  }
} catch (error) {
  console.error(error.message);
  settle(1);
}

electron = spawnChild(pnpmCommand, ["electron:start"], {
  prefix: "electron",
});
devChildren.add(electron);

electron.on("exit", (code, signal) => {
  devChildren.delete(electron);
  if (!settled) {
    settle(signal === "SIGINT" || signal === "SIGTERM" ? 0 : (code ?? 0));
  }
});
