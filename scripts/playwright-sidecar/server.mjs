// StoryCapture Playwright sidecar — JSON-RPC 2.0 over stdin/stdout (D-15).
//
// Wraps `playwright-core`'s Chromium driver so the Rust
// `PlaywrightSidecarDriver` (in `crates/automation`) can dispatch verbs
// chromiumoxide handles weakly: file upload, wait-for-download, shadow-DOM
// piercing, OAuth popups (PITFALLS #3, AUTO-06).
//
// Wire format:
//
//   stdin  → newline-delimited JSON: {"jsonrpc":"2.0","id":N,"method":"...","params":{...}}
//   stdout → newline-delimited JSON: {"jsonrpc":"2.0","id":N,"result":...}
//                                or  {"jsonrpc":"2.0","id":N,"error":{"code":-1,"message":"..."}}
//
// First-run Chromium download (RESEARCH Q2): The Chromium browser binary is
// NOT bundled in the installer (preserves <50 MB DIST-04). On first launch
// the sidecar checks for the playwright-core managed Chromium under
// `process.env.PLAYWRIGHT_BROWSERS_PATH || ~/Library/Caches/ms-playwright`
// (or %LOCALAPPDATA%\ms-playwright on Windows). If absent, it spawns
// `npx playwright install chromium` synchronously and reports progress
// via a JSON-RPC `notification` message.

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Plan 07-03a: the picker overlay IIFE is built by build-sea.mjs (Step -1/5)
// into picker/overlay/overlay.iife.js. esbuild's `--loader:.iife.js=text`
// flag inlines the file contents as a string literal at SEA build time, so
// the sidecar does NOT read a sibling file at runtime (SEA has no FS access
// to bundle-relative paths). For dev (`node server.mjs` outside SEA) the
// catch-block falls back to a plain fs read.
let OVERLAY_IIFE;
try {
  // SEA / esbuild path: `text` loader rewrites this import into the inlined
  // string literal. Node's ESM loader does not understand this assertion,
  // so the dev path always lands in the catch.
  OVERLAY_IIFE = (
    await import('./picker/overlay/overlay.iife.js', { with: { type: 'text' } })
  ).default;
} catch {
  try {
    const overlayPath = fileURLToPath(
      new URL('./picker/overlay/overlay.iife.js', import.meta.url),
    );
    OVERLAY_IIFE = readFileSync(overlayPath, 'utf8');
  } catch {
    // Last resort: empty IIFE so the sidecar still boots when running tests
    // that don't need the picker (e.g. browserProcess unit suite). Picker
    // handlers will degrade — the build pipeline is the source of truth.
    OVERLAY_IIFE = '';
  }
}

let state = {
  browser: null,
  context: null,
  page: null,
  baseUrl: null,
  downloadDir: null,
  // Plan 05-02: when we launch Chromium via `chromium.launchServer()`
  // followed by `chromium.connect(wsEndpoint)`, the server exposes the
  // child process (pid + spawnfile) which `Browser` itself doesn't. We
  // keep the server handle here so `browserProcess` can report it.
  browserServer: null,
  // Test-only: force `browserProcess` to return the "remote-browser"
  // response shape even though we launched locally. Flipped by the
  // `__test_set_remote_browser` verb exercised from vitest.
  fakeRemoteBrowser: false,
};

const handlers = {
  capabilities: async () => ({
    file_upload: true,
    wait_for_download: true,
    shadow_dom_click: true,
    oauth_popup: true,
    network_idle: true,
    iframes: true,
  }),

  launch: async (params) => {
    const {
      viewport,
      theme,
      baseUrl,
      headless,
      downloadDir,
      executable,
      channel,
      args,
    } = params || {};
    state.baseUrl = baseUrl || null;
    state.downloadDir = downloadDir || null;
    // Plan 06-02: args is an optional array of Chromium CLI flags (e.g.
    // ["--app=https://demo.com"] for chrome-hiding per D-09/D-10). Defaults
    // to [] so pre-06-02 call sites (Plan 05-02 tests) keep working.
    const extraArgs = Array.isArray(args) ? [...args] : [];
    const launchOpts = {
      headless: headless !== false,
      args: extraArgs,
    };
    if (executable) launchOpts.executablePath = executable;
    else if (channel) launchOpts.channel = channel; // 'chrome' | 'msedge' | 'chrome-beta' | ...
    // Plan 05-02: launch via `launchServer` + `connect` so we retain the
    // child-process handle (pid + spawnfile) for the Playwright auto-follow
    // capture path. Functionally equivalent to `chromium.launch()` for all
    // the verbs we dispatch — all interaction flows through the connected
    // Browser instance.
    state.browserServer = await chromium.launchServer(launchOpts);
    state.browser = await chromium.connect({
      wsEndpoint: state.browserServer.wsEndpoint(),
    });
    state.context = await state.browser.newContext({
      viewport: viewport ? { width: viewport.width, height: viewport.height } : undefined,
      colorScheme:
        theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'no-preference',
      acceptDownloads: true,
    });
    // Plan 06-02 (RESEARCH Pitfall 6): when `--app=<url>` is in the launch
    // args, Chromium creates an initial app-mode page/window with that URL
    // already loaded. Calling `context.newPage()` here would spawn a
    // second `about:blank` tab alongside the app window — the auto-follow
    // capture path then picks the wrong one. Reuse the existing first
    // page when one exists (the typical --app= path) and only create a
    // fresh page defensively when the context reports none.
    const hasApp = extraArgs.some(
      (a) => typeof a === 'string' && a.startsWith('--app='),
    );
    const existingPages = state.context.pages();
    if (hasApp && existingPages.length > 0) {
      state.page = existingPages[0];
    } else if (existingPages.length > 0) {
      state.page = existingPages[0];
    } else {
      state.page = await state.context.newPage();
    }
    return { ok: true };
  },

  close: async () => {
    if (state.browser) {
      try { await state.browser.close(); } catch {}
    }
    if (state.browserServer) {
      try { await state.browserServer.close(); } catch {}
    }
    state = {
      browser: null,
      context: null,
      page: null,
      baseUrl: null,
      downloadDir: null,
      browserServer: null,
      fakeRemoteBrowser: false,
    };
    return { ok: true };
  },

  goto: async ({ url }) => {
    const target = absolute(url);
    await state.page.goto(target, { waitUntil: 'load' });
    return { ok: true };
  },

  click: async ({ selector, strategy }) => {
    const locator = await locate(selector, strategy);
    await locator.click();
    return { ok: true };
  },

  type: async ({ selector, strategy, text }) => {
    const locator = await locate(selector, strategy);
    await locator.fill(text);
    return { ok: true };
  },

  scroll: async ({ direction, amount }) => {
    const px = amount || 400;
    const [x, y] =
      direction === 'down'
        ? [0, px]
        : direction === 'up'
        ? [0, -px]
        : direction === 'right'
        ? [px, 0]
        : [-px, 0];
    await state.page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y]);
    return { ok: true };
  },

  hover: async ({ selector, strategy }) => {
    const locator = await locate(selector, strategy);
    await locator.hover();
    return { ok: true };
  },

  drag: async ({ from, to }) => {
    await state.page.dragAndDrop(from, to);
    return { ok: true };
  },

  select: async ({ selector, value }) => {
    await state.page.selectOption(selector, value);
    return { ok: true };
  },

  upload: async ({ selector, path }) => {
    await state.page.setInputFiles(selector, path);
    return { ok: true };
  },

  waitMs: async ({ ms }) => {
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true };
  },

  waitFor: async ({ target, timeoutMs }) => {
    if (target.kind === 'text' && target.value && target.value.startsWith('download:')) {
      const download = await state.page.waitForEvent('download', { timeout: timeoutMs });
      const dest =
        state.downloadDir != null
          ? `${state.downloadDir}/${download.suggestedFilename()}`
          : await download.path();
      if (state.downloadDir) await download.saveAs(dest);
      return { ok: true, downloaded: dest };
    }
    const sel = targetToLocator(target);
    await state.page.waitForSelector(sel, { timeout: timeoutMs });
    return { ok: true };
  },

  assert: async ({ target }) => {
    const sel = targetToLocator(target);
    const count = await state.page.locator(sel).count();
    if (count === 0) throw new Error(`assert failed: no elements match ${sel}`);
    return { ok: true };
  },

  screenshot: async ({ name, outDir }) => {
    const path = `${outDir}/${name}.png`;
    await state.page.screenshot({ path });
    return { ok: true, path };
  },

  elementState: async ({ selector, strategy }) => {
    // Route through the same `locate()` helper as click/type so that
    // prefixed values (aria-name=, text=, label=, text~=) are resolved
    // via Playwright's locator engine instead of raw CSS querySelector.
    const locator = await locate(selector, strategy);
    const handle = await locator.first().elementHandle().catch(() => null);
    if (!handle) {
      return { visible: false, inViewport: false, animating: false };
    }
    const result = await handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const visible =
        s.visibility !== 'hidden' &&
        s.display !== 'none' &&
        parseFloat(s.opacity || '1') > 0;
      const inViewport =
        r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
      const animating = el.getAnimations
        ? el.getAnimations().some((a) => a.playState === 'running')
        : false;
      return {
        visible,
        inViewport,
        animating,
        bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
      };
    });
    await handle.dispose().catch(() => {});
    return result || { visible: false, inViewport: false, animating: false };
  },

  cursorPosition: async () => {
    return { x: 0, y: 0 };
  },

  // Plan 05-02 — return {pid, executablePath} of the launched browser so
  // the macOS host can resolve pid→SCWindow for Playwright auto-follow.
  //
  // Responses:
  //   - launched, local:  { pid: <int>, executablePath: <string> }
  //   - launched, remote: { pid: null, executablePath: null, reason: "remote-browser" }
  //                       (a future chromium.connect() path; no error)
  //   - not launched:     JSON-RPC error -32000 "browser not launched"
  //
  // T-05-02-03: executablePath may include a user-home path; log at DEBUG
  // only (the sidecar's stdout is the JSON-RPC channel; we only emit
  // structured tracing on stderr when DEBUG=storycapture-sidecar is set).
  browserProcess: async () => {
    if (!state.browser) {
      const err = new Error("browser not launched");
      err.code = -32000;
      throw err;
    }
    if (state.fakeRemoteBrowser) {
      return { pid: null, executablePath: null, reason: "remote-browser" };
    }
    // Local launch path — we always retain a BrowserServer handle in
    // `state.browserServer`. If it's absent, the browser came from a
    // future `connect()`-only path (remote CDP) and has no local pid.
    const proc = state.browserServer ? state.browserServer.process() : null;
    if (!proc) {
      return { pid: null, executablePath: null, reason: "remote-browser" };
    }
    const pid = typeof proc.pid === "number" ? proc.pid : Number(proc.pid);
    const executablePath =
      typeof proc.spawnfile === "string"
        ? proc.spawnfile
        : proc.spawnfile
        ? String(proc.spawnfile)
        : null;
    if (process.env.DEBUG && /storycapture-sidecar/.test(process.env.DEBUG)) {
      // Debug-only: never emit at INFO/stdout levels.
      process.stderr.write(
        `[debug] browserProcess pid=${pid} exec=${executablePath}\n`,
      );
    }
    return { pid, executablePath };
  },

  // Quick 260418-fpr — block until the launched page has painted its
  // first non-blank URL. Called by the host pid-probe task AFTER pid
  // resolves so that `start_recording` can gate SCK attach on a real
  // "Chrome has content to capture" signal rather than on pid alone.
  //
  // Contract:
  //   - If `state.page` is already on a non-blank URL, wait for `load`.
  //   - Otherwise wait for a navigation away from `about:blank`, then `load`.
  //   - Resolve with `{ ok: true, url }` on success.
  //   - JSON-RPC -32000 on timeout OR if no browser/page is attached.
  //
  // Budget comes from the caller; the default keeps parity with the
  // host's 10 s pid-probe budget.
  waitForFirstPaint: async ({ timeoutMs } = {}) => {
    const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
    if (!state.page) {
      const err = new Error("page not attached");
      err.code = -32000;
      throw err;
    }
    // Gate ONLY on URL change (framenavigated for the main frame
    // transitioning away from about:blank). `waitForLoadState` — even
    // for `domcontentloaded` — is serialized behind Playwright's
    // internal navigation lock held by an in-flight `page.goto`, so
    // the helper didn't resolve until `load` fired (3+ s),
    // swallowing the first second of the story. Event-based
    // URL-change detection fires the moment Chromium commits the
    // navigation (~100-200 ms after goto starts) which is:
    //   - early enough to capture the tail of the page-load animation
    //   - late enough to guarantee Chromium has moved off the blank
    //     about:blank surface (no leading black frames in video).
    if (state.page.url() !== 'about:blank') {
      return { ok: true, url: state.page.url() };
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.page.off('framenavigated', onNav);
        reject(new Error(`waitForFirstPaint timeout after ${t}ms`));
      }, t);
      const onNav = (frame) => {
        if (frame !== state.page.mainFrame()) return;
        const url = frame.url();
        if (!url || url === 'about:blank') return;
        clearTimeout(timer);
        state.page.off('framenavigated', onNav);
        resolve();
      };
      state.page.on('framenavigated', onNav);
    });
    return { ok: true, url: state.page.url() };
  },

  // Test-only shim (Plan 05-02 Task 0): let vitest exercise the
  // remote-browser response shape without a real remote CDP endpoint.
  // Safe to ship because it only mutates a non-observable flag — all
  // real capture paths ignore it unless a browser is actually attached.
  __test_set_remote_browser: async ({ enabled }) => {
    state.fakeRemoteBrowser = Boolean(enabled);
    return { ok: true };
  },
};

function absolute(url) {
  if (/^(https?:|about:)/.test(url)) return url;
  if (state.baseUrl) {
    try {
      return new URL(url, state.baseUrl).toString();
    } catch {
      return url;
    }
  }
  return url;
}

async function locate(selector, strategy) {
  // The Rust SmartSelector emits strategy-prefixed values; map them to
  // playwright-locator literals. Anything else is treated as raw CSS.
  if (strategy === 'css' || strategy === 'testid' || strategy === 'aria') {
    return state.page.locator(selector);
  }
  if (selector.startsWith('aria-name=')) {
    // accessible-name covers form labels AND interactive text (links,
    // buttons, headings, etc.). getByLabel only handles form labels, so
    // chain it with role-by-name and visible-text for the common cases.
    const name = selector.slice('aria-name='.length);
    return state.page
      .getByRole('link', { name, exact: true })
      .or(state.page.getByRole('button', { name, exact: true }))
      .or(state.page.getByLabel(name))
      .or(state.page.getByText(name, { exact: true }));
  }
  if (selector.startsWith('text=')) {
    return state.page.getByText(selector.slice('text='.length), { exact: true });
  }
  if (selector.startsWith('label=')) {
    return state.page.getByLabel(selector.slice('label='.length));
  }
  if (selector.startsWith('text~=')) {
    return state.page.getByText(selector.slice('text~='.length));
  }
  return state.page.locator(selector);
}

function targetToLocator(target) {
  if (!target) return '*';
  if (target.kind === 'selector') return target.value;
  if (target.kind === 'testid') return `[data-testid="${target.value}"]`;
  if (target.kind === 'aria') return `[aria-label="${target.value}"]`;
  return `text=${target.value}`;
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const { id, method, params } = req;
  const handler = handlers[method];
  if (!handler) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    return;
  }
  try {
    const result = await handler(params || {});
    write({ jsonrpc: '2.0', id, result });
  } catch (e) {
    write({ jsonrpc: '2.0', id, error: { code: -32000, message: String((e && e.message) || e) } });
  }
});

rl.on('close', async () => {
  if (state.browser) {
    try {
      await state.browser.close();
    } catch {}
  }
  if (state.browserServer) {
    try {
      await state.browserServer.close();
    } catch {}
  }
  process.exit(0);
});

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
