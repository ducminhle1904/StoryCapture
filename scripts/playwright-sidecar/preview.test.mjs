// Phase 09-01 — Preview CDP screencast verbs on the Playwright sidecar.
//
// Spawns the Node sidecar as a child process and exercises
// startPreviewStream / stopPreviewStream + the id-less preview/frame
// notification channel. Requires SIDECAR_TEST=1 for the __debugPreviewState
// verb used by the backpressure assertion.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "server.mjs");

// Animated data URL — a CSS-keyframes pulsing box guarantees continuous
// repaints so Chromium keeps emitting screencast frames across the whole
// test window (static pages only emit one frame and then go idle).
const DEMO_URL =
  "data:text/html," +
  encodeURIComponent(
    `<!doctype html><html><body style="margin:0">
    <style>
      @keyframes p { 0% { background:#f00 } 50% { background:#0f0 } 100% { background:#00f } }
      .b { width:300px; height:300px; animation: p 0.3s infinite }
    </style>
    <div class="b"></div></body></html>`,
  );

function spawnSidecar() {
  const child = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SIDECAR_TEST: "1" },
  });
  const pending = new Map();
  const frameListeners = new Set();
  let framesPaused = false;
  let nextId = 1;
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method } = msg;
    if (id === undefined || id === null) {
      // notification — frame delivery subject to pause. RPC responses
      // NEVER pause so __debugPreviewState resolves mid-test.
      if (framesPaused) return;
      if (method === "preview/frame") {
        for (const fn of frameListeners) fn(msg.params);
      }
      return;
    }
    const waiter = pending.get(id);
    if (waiter) {
      pending.delete(id);
      waiter(msg);
    }
  });
  child.stderr.on("data", () => {});
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveReq, rejectReq) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectReq(new Error(`timeout waiting for ${method}`));
        }, 60_000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) rejectReq(msg);
          else resolveReq(msg);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    },
    onFrame(fn) {
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },
    pauseFrames() { framesPaused = true; },
    resumeFrames() { framesPaused = false; },
    async dispose() {
      try { child.stdin.end(); } catch {}
      await new Promise((r) => setTimeout(r, 50));
      try { child.kill(); } catch {}
    },
  };
}

async function launch(client) {
  await client.call("launch", {
    viewport: { width: 800, height: 600 },
    theme: "auto",
    baseUrl: null,
    headless: true,
    downloadDir: "/tmp",
  });
  await client.call("goto", { url: DEMO_URL });
}

describe("Phase 09-01 preview CDP screencast verbs", () => {
  let client;
  beforeEach(() => { client = spawnSidecar(); });
  afterEach(async () => { if (client) await client.dispose(); });

  // lifecycle
  it("lifecycle: startPreviewStream emits preview/frame notifications; stopPreviewStream drains", async () => {
    await launch(client);
    try {
      const frames = [];
      const off = client.onFrame((p) => frames.push(p));
      const start = await client.call("startPreviewStream", {});
      expect(start.result.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 2000));
      expect(frames.length).toBeGreaterThanOrEqual(1);
      for (const f of frames) {
        expect(typeof f.data).toBe("string");
        expect(f.data.length).toBeGreaterThan(0);
        expect(typeof f.width).toBe("number");
        expect(typeof f.height).toBe("number");
        expect(typeof f.timestamp).toBe("number");
      }
      await client.call("stopPreviewStream", {});
      const countAtStop = frames.length;
      await new Promise((r) => setTimeout(r, 500));
      expect(frames.length - countAtStop).toBeLessThanOrEqual(1);
      off();
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);

  // ack behavior (implicit): frames continue arriving over time, which
  // only happens if Page.screencastFrameAck is being sent (Chromium halts
  // after ~1 unacked frame).
  it("ack: frames keep flowing beyond the first tick (implicit ack discipline)", async () => {
    await launch(client);
    try {
      const frames = [];
      client.onFrame((p) => frames.push(p));
      await client.call("startPreviewStream", {});
      await new Promise((r) => setTimeout(r, 1500));
      const first = frames.length;
      await new Promise((r) => setTimeout(r, 1500));
      const second = frames.length;
      expect(second).toBeGreaterThan(first);
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);

  // backpressure
  it("backpressure: latest-wins single-slot; debug state never shows queue > 1", async () => {
    await launch(client);
    try {
      await client.call("startPreviewStream", {});
      client.pauseFrames();
      await new Promise((r) => setTimeout(r, 250));
      const dbg = await client.call("__debugPreviewState", {});
      expect(dbg.result.cdpAttached).toBe(true);
      // flushScheduled bool + at most one pending frame — single slot invariant.
      expect(typeof dbg.result.hasLatest).toBe("boolean");
      expect(typeof dbg.result.flushScheduled).toBe("boolean");
      client.resumeFrames();
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);

  // pre-launch guard
  it("pre-launch guard: startPreviewStream before launch returns -32000", async () => {
    await expect(client.call("startPreviewStream", {})).rejects.toMatchObject({
      error: expect.objectContaining({
        code: -32000,
        message: expect.stringMatching(/page not launched/i),
      }),
    });
  });

  // idempotent start
  it("idempotent start: second startPreviewStream returns alreadyRunning=true", async () => {
    await launch(client);
    try {
      const a = await client.call("startPreviewStream", {});
      expect(a.result.alreadyRunning).toBeFalsy();
      const b = await client.call("startPreviewStream", {});
      expect(b.result.ok).toBe(true);
      expect(b.result.alreadyRunning).toBe(true);
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);

  // stop when idle
  it("stop when idle: stopPreviewStream with no session returns ok", async () => {
    await launch(client);
    try {
      const r = await client.call("stopPreviewStream", {});
      expect(r.result.ok).toBe(true);
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);

  // Phase 09-03 — drop counter increments when flusher is paused and
  // frames accumulate via the synthetic test hook. First overwrite counts
  // as the first drop (single-slot invariant).
  it("drop counter: 10 synthetic frames while flush paused → dropCount ≥ 9", async () => {
    await launch(client);
    try {
      await client.call("startPreviewStream", {});
      await client.call("__debugPausePreviewFlush", { paused: true });
      for (let i = 0; i < 10; i++) {
        await client.call("__debugInjectFrame", {});
      }
      const dbg = await client.call("__debugPreviewState", {});
      expect(dbg.result.previewDropCount).toBeGreaterThanOrEqual(9);
      await client.call("__debugPausePreviewFlush", { paused: false });
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);

  // Phase 09-03 — HiDPI / wide-viewport launches select everyNthFrame=2.
  it("HiDPI selection: wide viewport → everyNthFrame=2", async () => {
    await client.call("launch", {
      viewport: { width: 1800, height: 900 },
      theme: "auto",
      baseUrl: null,
      headless: true,
      downloadDir: "/tmp",
    });
    await client.call("goto", { url: DEMO_URL });
    try {
      const r = await client.call("startPreviewStream", {});
      expect(r.result.everyNthFrame).toBe(2);
      const dbg = await client.call("__debugPreviewState", {});
      expect(dbg.result.previewEveryNth).toBe(2);
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);

  it("HiDPI selection: small viewport → everyNthFrame=1", async () => {
    await client.call("launch", {
      viewport: { width: 1024, height: 700 },
      theme: "auto",
      baseUrl: null,
      headless: true,
      downloadDir: "/tmp",
    });
    await client.call("goto", { url: DEMO_URL });
    try {
      const r = await client.call("startPreviewStream", {});
      expect(r.result.everyNthFrame).toBe(1);
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);
});
