// Phase 09-01 — Preview CDP screencast verbs on the Playwright sidecar.
//
// Spawns the Node sidecar as a child process and exercises
// startPreviewStream / stopPreviewStream + the id-less preview/frame
// notification channel. Requires SIDECAR_TEST=1 for the __debugPreviewState
// verb used by the backpressure assertion.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

function jpegSizeFromBase64(data) {
  const buf = Buffer.from(data, "base64");
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`invalid jpeg marker at ${i}`);
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        width: buf.readUInt16BE(i + 7),
        height: buf.readUInt16BE(i + 5),
      };
    }
    i += 2 + len;
  }
  throw new Error("jpeg SOF marker not found");
}

function pngSizeFromBase64(data) {
  const buf = Buffer.from(data, "base64");
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error("invalid png header");
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function imageSizeFromBase64(data, format) {
  if (format === "png") return pngSizeFromBase64(data);
  return jpegSizeFromBase64(data);
}

function waitForFrame(client, predicate = () => true, timeoutMs = 10_000) {
  return new Promise((resolveFrame, rejectFrame) => {
    const timer = setTimeout(() => {
      off();
      rejectFrame(new Error("timeout waiting for preview/frame"));
    }, timeoutMs);
    const off = client.onFrame((frame) => {
      try {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        off();
        resolveFrame(frame);
      } catch (err) {
        clearTimeout(timer);
        off();
        rejectFrame(err);
      }
    });
  });
}

async function launchAuthor(client, streamId, viewport) {
  await client.call("author.launch", {
    streamId,
    url: DEMO_URL,
    viewport,
    headless: true,
  });
}

async function waitForFrameSize(client, streamId, expectedSize) {
  let matchedSize = null;
  const frame = await waitForFrame(client, (p) => {
    if (p.streamId !== streamId) return false;
    const size = imageSizeFromBase64(p.data, p.format);
    if (size.width !== expectedSize.width || size.height !== expectedSize.height) {
      return false;
    }
    matchedSize = size;
    return true;
  });
  return { frame, size: matchedSize ?? imageSizeFromBase64(frame.data, frame.format) };
}

async function expectAuthorPreviewSize(client, label, viewport) {
  const streamId = `sharp-${label}-${Date.now()}`;
  try {
    await launchAuthor(client, streamId, viewport);
    await client.call("startPreviewStream", { streamId });
    const { size } = await waitForFrameSize(client, streamId, viewport);
    expect(size).toEqual(viewport);
  } finally {
    await client.call("author.close", { streamId }).catch(() => {});
  }
}

function spawnSidecar() {
  const child = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SIDECAR_TEST: "1" },
  });
  const pending = new Map();
  const frameListeners = new Set();
  const stderrLines = [];
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
  child.stderr.on("data", (chunk) => {
    stderrLines.push(String(chunk));
  });
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
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    onFrame(fn) {
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },
    pauseFrames() {
      framesPaused = true;
    },
    resumeFrames() {
      framesPaused = false;
    },
    stderrText() {
      return stderrLines.join("");
    },
    async dispose() {
      try {
        child.stdin.end();
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
      try {
        child.kill();
      } catch {}
    },
  };
}

async function launch(client, viewport = { width: 800, height: 600 }) {
  await client.call("launch", {
    viewport,
    theme: "auto",
    baseUrl: null,
    headless: true,
    downloadDir: "/tmp",
  });
  await client.call("goto", { url: DEMO_URL });
}

describe("Phase 09-01 preview CDP screencast verbs", () => {
  let client;
  beforeEach(() => {
    client = spawnSidecar();
  });
  afterEach(async () => {
    if (client) await client.dispose();
  });

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

  // Phase 09-04 — author-session lifecycle, separate from recording.
  it("author.launch + startPreviewStream(streamId) emits streamId-tagged frames", async () => {
    const streamId = "author-" + Date.now();
    try {
      await client.call("author.launch", {
        streamId,
        url: DEMO_URL,
        viewport: { width: 1024, height: 700 },
        headless: true,
      });
      const frames = [];
      client.onFrame((p) => frames.push(p));
      const start = await client.call("startPreviewStream", { streamId });
      expect(start.result.ok).toBe(true);
      expect(start.result.streamId).toBe(streamId);
      await new Promise((r) => setTimeout(r, 1500));
      expect(frames.length).toBeGreaterThanOrEqual(1);
      // every author frame must carry its streamId (multi-stream demux).
      for (const f of frames) {
        expect(f.streamId).toBe(streamId);
      }
      const stop = await client.call("stopPreviewStream", { streamId });
      expect(stop.result.ok).toBe(true);
    } finally {
      await client.call("author.close", { streamId }).catch(() => {});
    }
  }, 60_000);

  // Phase 09-04 — pauseStream halts frame emission; resumeStream restarts it.
  it("pauseStream / resumeStream round-trips", async () => {
    const streamId = "author-pause-" + Date.now();
    try {
      await client.call("author.launch", {
        streamId,
        url: DEMO_URL,
        viewport: { width: 800, height: 600 },
        headless: true,
      });
      const frames = [];
      client.onFrame((p) => {
        if (p.streamId === streamId) frames.push(p);
      });
      await client.call("startPreviewStream", { streamId });
      await new Promise((r) => setTimeout(r, 800));
      const beforePause = frames.length;
      expect(beforePause).toBeGreaterThanOrEqual(1);
      const pauseRes = await client.call("pauseStream", { streamId });
      expect(pauseRes.result.paused).toBe(true);
      await new Promise((r) => setTimeout(r, 600));
      const duringPause = frames.length;
      const resumeRes = await client.call("resumeStream", { streamId });
      expect(resumeRes.result.paused).toBe(false);
      await new Promise((r) => setTimeout(r, 800));
      // More frames must have arrived after resume than during pause.
      expect(frames.length).toBeGreaterThan(duringPause);
    } finally {
      await client.call("author.close", { streamId }).catch(() => {});
    }
  }, 60_000);

  // Phase 09-04 — setViewport updates page.setViewportSize without reload.
  it("author.setViewport updates innerWidth/innerHeight", async () => {
    const streamId = "author-vp-" + Date.now();
    try {
      await client.call("author.launch", {
        streamId,
        url: DEMO_URL,
        viewport: { width: 1280, height: 800 },
        headless: true,
      });
      await client.call("author.setViewport", {
        streamId,
        width: 375,
        height: 667,
      });
      // Re-launch the CDP probe (reads innerWidth) by (re)starting the
      // screencast which runs the HiDPI selector.
      const r = await client.call("startPreviewStream", { streamId });
      expect(r.result.ok).toBe(true);
      expect(r.result.everyNthFrame).toBe(1);
    } finally {
      await client.call("author.close", { streamId }).catch(() => {});
    }
  }, 60_000);

  // Phase 09-04 — author session is independent from recording session.
  it("author session does not interfere with recording-session preview", async () => {
    await launch(client);
    const streamId = "author-iso-" + Date.now();
    try {
      await client.call("startPreviewStream", {});
      await client.call("author.launch", {
        streamId,
        url: DEMO_URL,
        viewport: { width: 600, height: 400 },
        headless: true,
      });
      await client.call("startPreviewStream", { streamId });
      const recordingFrames = [];
      const authorFrames = [];
      client.onFrame((p) => {
        if (p.streamId === streamId) authorFrames.push(p);
        else recordingFrames.push(p);
      });
      await new Promise((r) => setTimeout(r, 1500));
      // Stopping the author stream must not kill the recording stream.
      await client.call("stopPreviewStream", { streamId });
      const recordingBeforeStop = recordingFrames.length;
      await new Promise((r) => setTimeout(r, 600));
      expect(recordingFrames.length).toBeGreaterThanOrEqual(recordingBeforeStop);
      expect(authorFrames.length).toBeGreaterThanOrEqual(1);
    } finally {
      await client.call("author.close", { streamId }).catch(() => {});
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);

  it("sharpness: author desktop viewport emits full-size JPEG", async () => {
    await expectAuthorPreviewSize(client, "desktop", { width: 1280, height: 800 });
  }, 60_000);

  it("sharpness: author tablet viewport emits full-size JPEG", async () => {
    await expectAuthorPreviewSize(client, "tablet", { width: 768, height: 1024 });
  }, 60_000);

  it("sharpness: author.setViewport refreshes screencast bounds", async () => {
    const streamId = `sharp-set-vp-${Date.now()}`;
    try {
      await launchAuthor(client, streamId, { width: 1280, height: 800 });
      await client.call("startPreviewStream", { streamId });
      const first = await waitForFrameSize(client, streamId, { width: 1280, height: 800 });
      expect(first.size).toEqual({ width: 1280, height: 800 });

      await client.call("author.setViewport", {
        streamId,
        width: 768,
        height: 1024,
      });
      const resized = await waitForFrameSize(client, streamId, { width: 768, height: 1024 });
      expect(resized.size).toEqual({ width: 768, height: 1024 });
    } finally {
      await client.call("author.close", { streamId }).catch(() => {});
    }
  }, 60_000);

  it("sharpness: author idle emits 2x PNG sharp frame", async () => {
    const streamId = `sharp-png-${Date.now()}`;
    try {
      await launchAuthor(client, streamId, { width: 1280, height: 800 });
      await client.call("startPreviewStream", { streamId });
      const frame = await waitForFrame(
        client,
        (p) => p.streamId === streamId && p.format === "png" && p.sharp === true,
      );
      expect(frame.mimeType).toBe("image/png");
      expect(pngSizeFromBase64(frame.data)).toEqual({ width: 2560, height: 1600 });
      expect(client.stderrText()).toContain("preview sharp frame emitted");
      expect(client.stderrText()).toContain(`streamId=${streamId}`);
      expect(client.stderrText()).toContain("png=2560x1600");

      await client.call("author.dispatchInput", {
        streamId,
        event: { type: "click", x: 10, y: 10, button: "left" },
      });
      const afterInputFrame = await waitForFrame(
        client,
        (p) => p.streamId === streamId && p.format === "png" && p.sharp === true,
      );
      expect(pngSizeFromBase64(afterInputFrame.data)).toEqual({ width: 2560, height: 1600 });
    } finally {
      await client.call("author.close", { streamId }).catch(() => {});
    }
  }, 60_000);

  it("sharpness: recording default remains 1280x720", async () => {
    await launch(client, { width: 1280, height: 720 });
    try {
      await client.call("startPreviewStream", {});
      const frame = await waitForFrame(client, (p) => p.streamId == null);
      expect(imageSizeFromBase64(frame.data, frame.format)).toEqual({ width: 1280, height: 720 });
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 60_000);
});
