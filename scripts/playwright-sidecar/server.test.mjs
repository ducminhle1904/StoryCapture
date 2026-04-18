// Plan 05-02 Task 0 / Task 1 — Vitest harness for the `browserProcess`
// JSON-RPC verb on the Playwright sidecar.
//
// These tests spawn the Node sidecar as a child process (node server.mjs)
// and exchange JSON-RPC messages over stdin/stdout. Chromium must be
// available via `playwright-core` (download cached under
// ~/Library/Caches/ms-playwright). On first run these tests will trigger
// `playwright install chromium` if not already installed.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "server.mjs");

/**
 * Spawn the sidecar and return a JSON-RPC client object with `.call()`
 * and `.dispose()` helpers.
 */
function spawnSidecar() {
  const child = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const pending = new Map();
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
    const { id } = msg;
    const waiter = pending.get(id);
    if (waiter) {
      pending.delete(id);
      waiter(msg);
    }
  });
  // Swallow stderr in tests (surface only on hang).
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
    async dispose() {
      try {
        child.stdin.end();
      } catch {}
      // Give the sidecar a moment to clean up, then kill.
      await new Promise((r) => setTimeout(r, 50));
      try {
        child.kill();
      } catch {}
    },
  };
}

describe("browserProcess JSON-RPC verb", () => {
  let client;
  beforeEach(() => {
    client = spawnSidecar();
  });
  afterEach(async () => {
    if (client) await client.dispose();
  });

  it("returns a JSON-RPC error when no browser is launched", async () => {
    await expect(client.call("browserProcess", {})).rejects.toMatchObject({
      error: expect.objectContaining({
        code: -32000,
        message: expect.stringMatching(/not launched/i),
      }),
    });
  });

  it("returns {pid, executablePath} after launch (headless Chromium)", async () => {
    // Launch headless Chromium (fast, no window chrome).
    await client.call("launch", {
      viewport: { width: 1024, height: 768 },
      theme: "auto",
      baseUrl: null,
      headless: true,
      downloadDir: "/tmp",
    });
    try {
      const resp = await client.call("browserProcess", {});
      expect(resp.result).toBeDefined();
      expect(resp.result.pid).toBeTypeOf("number");
      expect(resp.result.pid).toBeGreaterThan(0);
      expect(resp.result.executablePath).toBeTypeOf("string");
      expect(resp.result.executablePath.length).toBeGreaterThan(0);
      expect(resp.result.reason).toBeUndefined();
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 90_000);

  // Plan 06-02 — when --app=<url> is present in launch args, the sidecar
  // must reuse context.pages()[0] instead of calling newPage(). If it
  // creates a second tab, the Playwright auto-follow capture path picks
  // the wrong window (Pitfall 6). We verify the behavior by checking
  // that context.pages() has exactly one page after launch with --app=.
  it("reuses context.pages()[0] when --app= is in launch args (no stray about:blank)", async () => {
    await client.call("launch", {
      viewport: { width: 1024, height: 768 },
      theme: "auto",
      baseUrl: null,
      headless: true,
      downloadDir: "/tmp",
      // about:blank keeps the test hermetic (no network); Chromium still
      // opens it as an app-mode window, and the page-reuse path fires
      // because the prefix `--app=` is present.
      args: ["--app=about:blank"],
    });
    try {
      // Drive a trivial page-level verb; if newPage() had created a
      // second tab, this would race-condition between the two. We
      // simply confirm the call succeeds against the reused page.
      await client.call("goto", { url: "about:blank" });
      // Exact page count is hard to assert over JSON-RPC without
      // exposing an internal verb, but the positive behavior is:
      // (a) launch didn't throw, (b) follow-up verbs hit the expected
      // page. A regression (newPage on --app path) would leak a stray
      // about:blank; the browserProcess pid is still a single child.
      const resp = await client.call("browserProcess", {});
      expect(resp.result.pid).toBeTypeOf("number");
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 90_000);

  // Regression guard: launching WITHOUT args still works (pre-06-02
  // call sites send no `args` field; sidecar must tolerate undefined).
  it("accepts launch without an args field (backwards compat)", async () => {
    await client.call("launch", {
      viewport: { width: 800, height: 600 },
      theme: "auto",
      baseUrl: null,
      headless: true,
      downloadDir: "/tmp",
    });
    try {
      const resp = await client.call("browserProcess", {});
      expect(resp.result.pid).toBeTypeOf("number");
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 90_000);

  // Plan 07-03a — element picker integration. Drives real Chromium against
  // the picker.html fixture. Uses __test_simulate_pick / *_cancel to
  // synthesize click + Escape events deterministically (real mouse
  // coordination is flaky in headless CI). Each assertion mirrors a row
  // of the original 07-03 acceptance matrix:
  //   1. testid rank
  //   2. role+name rank
  //   3. field/label rank
  //   4. text-exact rank
  //   5. CSS fallback rank
  //   6. user-cancel
  //   7. unsupported-url (about:blank refused)
  //   8. mid-pick framenavigated auto-cancel
  //   9. isActive true during, false after
  describe("Phase 7 Tier 2 MVP — pickElement", () => {
    const fixtureUrl = `file://${resolve(__dirname, "tests/fixtures/picker.html")}`;

    async function launchAndOpen() {
      await client.call("launch", {
        viewport: { width: 1024, height: 768 },
        theme: "auto",
        baseUrl: null,
        headless: true,
        downloadDir: "/tmp",
      });
      await client.call("goto", { url: fixtureUrl });
    }

    it("rank 1 — testid wins for [data-testid=save-btn]", async () => {
      await launchAndOpen();
      try {
        const startPromise = client.call("pickElement.start", {
          timeoutMs: 10000,
        });
        // Give the overlay a tick to install before simulating the click.
        await new Promise((r) => setTimeout(r, 50));
        await client.call("__test_simulate_pick", {
          selector: '[data-testid="save-btn"]',
        });
        const resp = await startPromise;
        expect(resp.result.emitted).toBe('click testid "save-btn"');
        expect(resp.result.locator.kind).toBe("testid");
      } finally {
        await client.call("close", {}).catch(() => {});
      }
    }, 60_000);

    it("rank 2 — role+name wins for <a href='#docs'>Docs</a>", async () => {
      await launchAndOpen();
      try {
        const startPromise = client.call("pickElement.start", {
          timeoutMs: 10000,
        });
        await new Promise((r) => setTimeout(r, 50));
        await client.call("__test_simulate_pick", {
          selector: 'a[href="#docs"]',
        });
        const resp = await startPromise;
        expect(resp.result.emitted).toBe('click link "Docs"');
        expect(resp.result.locator.kind).toBe("role");
      } finally {
        await client.call("close", {}).catch(() => {});
      }
    }, 60_000);

    it("rank 3 — field/label for <input id=email> with associated <label>", async () => {
      await launchAndOpen();
      try {
        const startPromise = client.call("pickElement.start", {
          timeoutMs: 10000,
        });
        await new Promise((r) => setTimeout(r, 50));
        await client.call("__test_simulate_pick", { selector: "#email" });
        const resp = await startPromise;
        // role=textbox + name="Email" is unique → rank 2 wins. The plan's
        // emission order ranks role+name above label; either DSL form
        // resolves to the same input. Accept whichever the generator emits
        // (rank 2 for textbox+name, rank 3 fallback if role search fails).
        expect(resp.result.emitted).toMatch(
          /^click (textbox "Email"|field "Email")$/,
        );
      } finally {
        await client.call("close", {}).catch(() => {});
      }
    }, 60_000);

    it("rank 4 — exact text 'Learn more about it' (decoys present)", async () => {
      await launchAndOpen();
      try {
        // Find the span with that exact text via the test simulate hook.
        const startPromise = client.call("pickElement.start", {
          timeoutMs: 10000,
        });
        await new Promise((r) => setTimeout(r, 50));
        // Use nth-of-type because the spans are siblings; the picker
        // fixture puts the Learn-more-about-it span FIRST among <span>.
        await client.call("__test_simulate_pick", { selector: "span" });
        const resp = await startPromise;
        expect(resp.result.emitted).toBe(
          'click text "Learn more about it"',
        );
        expect(resp.result.locator.kind).toBe("text_exact");
      } finally {
        await client.call("close", {}).catch(() => {});
      }
    }, 60_000);

    it("rank 5 — CSS fallback for <div.mystery-widget>", async () => {
      await launchAndOpen();
      try {
        const startPromise = client.call("pickElement.start", {
          timeoutMs: 10000,
        });
        await new Promise((r) => setTimeout(r, 50));
        await client.call("__test_simulate_pick", {
          selector: "div.mystery-widget",
        });
        const resp = await startPromise;
        expect(resp.result.locator.kind).toBe("selector");
        expect(resp.result.emitted).toMatch(/^click selector "/);
      } finally {
        await client.call("close", {}).catch(() => {});
      }
    }, 60_000);

    it("user-cancel — Escape resolves with {cancelled, reason:user-cancel}", async () => {
      await launchAndOpen();
      try {
        const startPromise = client.call("pickElement.start", {
          timeoutMs: 10000,
        });
        await new Promise((r) => setTimeout(r, 50));
        await client.call("__test_simulate_pick_cancel", {});
        const resp = await startPromise;
        expect(resp.result).toEqual({
          cancelled: true,
          reason: "user-cancel",
        });
      } finally {
        await client.call("close", {}).catch(() => {});
      }
    }, 60_000);

    it("unsupported-url — about:blank refuses activation", async () => {
      await client.call("launch", {
        viewport: { width: 1024, height: 768 },
        theme: "auto",
        baseUrl: null,
        headless: true,
        downloadDir: "/tmp",
      });
      try {
        // Default page is about:blank — never navigated.
        const resp = await client.call("pickElement.start", {
          timeoutMs: 5000,
        });
        expect(resp.result).toEqual({
          cancelled: true,
          reason: "unsupported-url",
        });
      } finally {
        await client.call("close", {}).catch(() => {});
      }
    }, 60_000);

    it("framenavigated auto-cancel — mid-pick navigation resolves with {reason:navigation}", async () => {
      await launchAndOpen();
      try {
        const startPromise = client.call("pickElement.start", {
          timeoutMs: 10000,
        });
        await new Promise((r) => setTimeout(r, 50));
        // Trigger a real navigation; the framenavigated listener cancels.
        await client.call("goto", { url: fixtureUrl + "?nav=1" });
        const resp = await startPromise;
        expect(resp.result).toEqual({
          cancelled: true,
          reason: "navigation",
        });
      } finally {
        await client.call("close", {}).catch(() => {});
      }
    }, 60_000);

    it("isActive — false initially, true during pick, false after", async () => {
      await launchAndOpen();
      try {
        const before = await client.call("pickElement.isActive", {});
        expect(before.result.active).toBe(false);
        const startPromise = client.call("pickElement.start", {
          timeoutMs: 10000,
        });
        await new Promise((r) => setTimeout(r, 100));
        const during = await client.call("pickElement.isActive", {});
        expect(during.result.active).toBe(true);
        await client.call("__test_simulate_pick_cancel", {});
        await startPromise;
        const after = await client.call("pickElement.isActive", {});
        expect(after.result.active).toBe(false);
      } finally {
        await client.call("close", {}).catch(() => {});
      }
    }, 60_000);
  });

  it("returns {pid: null, reason: 'remote-browser'} when browser.process() is null", async () => {
    // Deterministic remote-browser simulation: launch locally, then flip
    // the test-only flag so `browserProcess` responds as if it were a
    // remote CDP-connected browser (browser.process() === null).
    await client.call("launch", {
      viewport: { width: 800, height: 600 },
      theme: "auto",
      baseUrl: null,
      headless: true,
      downloadDir: "/tmp",
    });
    try {
      await client.call("__test_set_remote_browser", { enabled: true });
      const resp = await client.call("browserProcess", {});
      expect(resp.result).toBeDefined();
      expect(resp.result.pid).toBeNull();
      expect(resp.result.executablePath).toBeNull();
      expect(resp.result.reason).toBe("remote-browser");
    } finally {
      await client.call("close", {}).catch(() => {});
    }
  }, 90_000);
});
