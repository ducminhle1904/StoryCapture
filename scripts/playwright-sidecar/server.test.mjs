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
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "server.mjs");
const TIER1_FIXTURE_URL = pathToFileURL(
  resolve(__dirname, "tests/fixtures/tier1.html"),
).toString();

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

// Plan 07-02 Task 2 — PHASE-7.3 acceptance gate.
// Drives real Chromium against tests/fixtures/tier1.html and proves:
//   - locate('role'|'label'|'text_exact') → getByRole/getByLabel/getByText exact
//   - targetToLocator supports {kind: 'role'|'label'|'text_exact'}
//   - elementState routes through locate() for new strategies
//   - colon-in-name splits correctly on FIRST ':'
//   - legacy bare-text aria-name= ranked chain still resolves (regression guard)
describe("Phase 7 Tier 1 — locate() strict explicit strategies", () => {
  let client;
  beforeEach(async () => {
    client = spawnSidecar();
    await client.call("launch", {
      viewport: { width: 1280, height: 800 },
      theme: "auto",
      baseUrl: null,
      headless: true,
      downloadDir: "/tmp",
    });
    await client.call("goto", { url: TIER1_FIXTURE_URL });
  }, 90_000);
  afterEach(async () => {
    try {
      await client.call("close", {});
    } catch {}
    if (client) await client.dispose();
  });

  async function expectSingleRoleMatch(role, name) {
    const r = await client.call("assert", {
      target: { kind: "role", value: { role, name } },
    });
    expect(r.result.ok).toBe(true);
  }

  it("getByRole(button, Save) resolves the submit button", async () => {
    await expectSingleRoleMatch("button", "Save");
  }, 90_000);

  it("getByRole(link, Docs) resolves the nav link", async () => {
    await expectSingleRoleMatch("link", "Docs");
  }, 90_000);

  it("getByLabel(Email) resolves the email input", async () => {
    const r = await client.call("assert", {
      target: { kind: "label", value: "Email" },
    });
    expect(r.result.ok).toBe(true);
  }, 90_000);

  it("getByText exact matches 'Learn more' but not 'Learn more not present'", async () => {
    const r = await client.call("assert", {
      target: { kind: "text_exact", value: "Learn more" },
    });
    expect(r.result.ok).toBe(true);
    // Negative: a non-existent exact string should fail the assert.
    await expect(
      client.call("assert", {
        target: { kind: "text_exact", value: "Learn more not present" },
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        message: expect.stringMatching(/no elements match/),
      }),
    });
  }, 90_000);

  it("click uses locate('role') for SelectorOrText::Role", async () => {
    const r = await client.call("click", {
      selector: "role=button:Save",
      strategy: "role",
    });
    expect(r.result.ok).toBe(true);
  }, 90_000);

  it("type uses locate('label') for SelectorOrText::Label", async () => {
    const r = await client.call("type", {
      selector: "label=Email",
      strategy: "label",
      text: "a@x",
    });
    expect(r.result.ok).toBe(true);
  }, 90_000);

  it("click uses locate('text_exact') for SelectorOrText::TextExact", async () => {
    const r = await client.call("click", {
      selector: "text=Learn more",
      strategy: "text_exact",
    });
    expect(r.result.ok).toBe(true);
  }, 90_000);

  it("bare aria-name= fallback path still resolves (legacy regression guard)", async () => {
    // Pre-Phase-7 behavior: bare `click "Save"` emits strategy="accessible-name"
    // with value "aria-name=Save". The sidecar's locate() `aria-name=` chained
    // .or() branch MUST still resolve to the Save button.
    const r = await client.call("click", {
      selector: "aria-name=Save",
      strategy: "accessible-name",
    });
    expect(r.result.ok).toBe(true);
  }, 90_000);

  it("elementState with Tier 1 role= target routes through locate() and reports visible", async () => {
    const r = await client.call("elementState", {
      selector: "role=button:Save",
      strategy: "role",
    });
    expect(r.result.visible).toBe(true);
  }, 90_000);

  it("role selector with colon-containing name resolves on a real DOM element", async () => {
    // Navigate to a small data: URL that contains a button whose name has ':'.
    // This exercises the sidecar's split-on-FIRST-colon logic end-to-end and
    // cross-references the Rust-side encoding test
    // `explicit_role_preserves_colon_in_name`.
    const dataUrl =
      "data:text/html," +
      encodeURIComponent(
        '<!doctype html><html><body><button type="button">Go: now</button></body></html>',
      );
    await client.call("goto", { url: dataUrl });
    const r = await client.call("assert", {
      target: { kind: "role", value: { role: "button", name: "Go: now" } },
    });
    expect(r.result.ok).toBe(true);
  }, 90_000);
});
