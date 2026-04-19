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
import { createHash } from 'node:crypto';
import { dirname as pathDirname, resolve as pathResolve } from 'node:path';
import { chromium } from 'playwright-core';
import { emitDsl } from './picker/generator.mjs';
import {
  VIEWPORT_FIT_MAX_ATTEMPTS,
  VIEWPORT_FIT_SETTLE_MS,
  nextWindowBoundsForViewport,
} from './viewport-fit.mjs';

// the picker overlay IIFE is built by build-sea.mjs (Step -1/5) into
// picker/overlay/overlay.iife.js. We MUST use a synchronous loader because
// esbuild bundles this file as CJS for the SEA binary, where top-level
// `await` is rejected. Two paths:
//   * dev (`node server.mjs`): file lives at import.meta.url-relative path.
//   * SEA: build-sea.mjs copies the IIFE alongside the binary as
//     <exeDir>/playwright-sidecar-modules/overlay.iife.js (next to
//     playwright-core). At runtime we resolve via process.execPath.
function loadOverlayIife() {
  const candidates = [];
  try {
    candidates.push(
      fileURLToPath(new URL('./picker/overlay/overlay.iife.js', import.meta.url)),
    );
  } catch {
    /* import.meta.url unavailable in some embed contexts */
  }
  try {
    const exeDir = pathDirname(process.execPath);
    candidates.push(pathResolve(exeDir, 'playwright-sidecar-modules', 'overlay.iife.js'));
    candidates.push(
      pathResolve(exeDir, '..', 'Resources', 'playwright-sidecar-modules', 'overlay.iife.js'),
    );
  } catch {
    /* defensive — process.execPath should always exist */
  }
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  // Last resort: empty IIFE so the sidecar still boots when running tests
  // that don't need the picker. Picker handlers will degrade — the build
  // pipeline is the source of truth.
  return '';
}
const OVERLAY_IIFE = loadOverlayIife();

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
  // in-flight pickElement.start. Holds { resolve, cleanup }
  // so pickElement.cancel + framenavigated can short-circuit the wait.
  pickerPending: null,
  // page-level binding (`__sc_picker_emit`) is exposed once
  // per page. We track which pages have it so a second pickElement.start
  // on the same page doesn't re-expose (Playwright throws on duplicate
  // exposeBinding for the same name).
  pickerBoundPages: new WeakSet(),
  // separate per-page set for the `__sc_picker_hover` binding
  // (the live-hover preview channel). Split from pickerBoundPages because
  // the overlay can install each binding independently and Playwright
  // throws on duplicate exposeBinding calls with the same name.
  pickerHoverBoundPages: new WeakSet(),
  // dedicated author-time browser for DOM snapshots, SEPARATE
  // from any recording session. Launched lazily on first captureSnapshot
  // call; kept headless, no args, no init scripts. Never shares state
  // with `state.browser` / `state.context` / `state.page`.
  authorBrowser: null,
  authorContext: null,
  // Idle-close timer for the author browser. Closed after this many ms
  // of no captureSnapshot activity so a long editor session doesn't pin
  // ~80 MB of headless Chromium indefinitely. Re-launches on the next
  // captureSnapshot call at ~500 ms cold-start cost.
  authorIdleHandle: null,
};

const AUTHOR_IDLE_MS = 5 * 60 * 1000;

async function closeAuthorBrowser() {
  const b = state.authorBrowser;
  state.authorBrowser = null;
  state.authorContext = null;
  if (state.authorIdleHandle) {
    clearTimeout(state.authorIdleHandle);
    state.authorIdleHandle = null;
  }
  if (b) {
    try { await b.close(); } catch {}
  }
}

async function fitViewportToContent(page, context, viewport) {
  if (!viewport || !viewport.width || !viewport.height) {
    return null;
  }

  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');

    for (let attempt = 1; attempt <= VIEWPORT_FIT_MAX_ATTEMPTS; attempt += 1) {
      const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
      const inner = await page.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
      }));
      const fit = nextWindowBoundsForViewport(bounds, inner, viewport);

      if (fit.done) {
        return { ok: true, attempts: attempt, bounds, inner, fit };
      }

      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          width: fit.nextBounds.width,
          height: fit.nextBounds.height,
          windowState: 'normal',
        },
      });
      await page.waitForTimeout(VIEWPORT_FIT_SETTLE_MS);
    }

    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    const inner = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    const fit = nextWindowBoundsForViewport(bounds, inner, viewport);
    return {
      ok: fit.done,
      attempts: VIEWPORT_FIT_MAX_ATTEMPTS,
      bounds,
      inner,
      fit,
    };
  } finally {
    try {
      await cdp.detach();
    } catch {
      /* detach is best-effort */
    }
  }
}

function armAuthorIdleClose() {
  if (state.authorIdleHandle) clearTimeout(state.authorIdleHandle);
  state.authorIdleHandle = setTimeout(() => {
    state.authorIdleHandle = null;
    closeAuthorBrowser().catch(() => {});
  }, AUTHOR_IDLE_MS);
  if (typeof state.authorIdleHandle.unref === 'function') {
    state.authorIdleHandle.unref();
  }
}

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
    // `viewport: null` disables Playwright's auto-resize
    // (crPage.js::_updateViewport → Browser.setWindowBounds with
    // hardcoded macOS insets {2,80}). Without this, Playwright
    // overrides --window-size right after launch so SCK captures a
    // window sized to viewport + {2,80} points, not whatever we asked
    // for. We resize explicitly below via a measured CDP call so the
    // content area matches the story viewport in real pixels.
    state.context = await state.browser.newContext({
      viewport: null,
      colorScheme:
        theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'no-preference',
      acceptDownloads: true,
    });
    // inject the picker overlay IIFE into every frame of every
    // page in this context. addInitScript fires before page scripts so
    // window.__sc_picker is available the moment the user clicks Pick.
    if (OVERLAY_IIFE && OVERLAY_IIFE.length > 0) {
      try {
        await state.context.addInitScript({ content: OVERLAY_IIFE });
      } catch (e) {
        // Don't kill launch if overlay injection fails — picker handlers
        // will surface the error when invoked. Other verbs keep working.
        process.stderr.write(
          `[playwright-sidecar] warn: addInitScript(overlay) failed: ${e.message}\n`,
        );
      }
    }
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
    // Authoritative resize via CDP so the native window CONTENT
    // matches `viewport` exactly. Playwright's own viewport math uses
    // hardcoded insets that are not stable across Chromium/macOS builds.
    // Measure the current content box, adjust the outer bounds by the
    // residual delta, and re-verify after each resize until the page
    // reports the requested `window.innerWidth/innerHeight`.
    if (viewport && viewport.width && viewport.height) {
      try {
        const result = await fitViewportToContent(state.page, state.context, viewport);
        if (!result?.ok) {
          process.stderr.write(
            `[playwright-sidecar] warn: viewport fit incomplete after ${result?.attempts ?? 0} attempts; ` +
              `wanted=${viewport.width}x${viewport.height} got=${result?.inner?.w ?? 0}x${result?.inner?.h ?? 0} ` +
              `bounds=${result?.bounds?.width ?? 0}x${result?.bounds?.height ?? 0}\n`,
          );
        }
      } catch (e) {
        process.stderr.write(
          `[playwright-sidecar] warn: CDP content-size fit failed: ${e.message}\n`,
        );
      }
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
    // also tear down the author-time snapshot browser.
    await closeAuthorBrowser();
    state = {
      browser: null,
      context: null,
      page: null,
      baseUrl: null,
      downloadDir: null,
      browserServer: null,
      fakeRemoteBrowser: false,
      pickerPending: null,
      pickerBoundPages: new WeakSet(),
      pickerHoverBoundPages: new WeakSet(),
      authorBrowser: null,
      authorContext: null,
      authorIdleHandle: null,
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
    const loc = targetToLocator(target);
    if (typeof loc === 'string') {
      await state.page.waitForSelector(loc, { timeout: timeoutMs });
    } else {
      // Locator — wait for it to attach.
      await loc.waitFor({ state: 'attached', timeout: timeoutMs });
    }
    return { ok: true };
  },

  assert: async ({ target }) => {
    const loc = targetToLocator(target);
    const count =
      typeof loc === 'string' ? await state.page.locator(loc).count() : await loc.count();
    if (count === 0) throw new Error(`assert failed: no elements match ${JSON.stringify(target)}`);
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

  // author-time DOM snapshot for the selector validator.
  //
  // Loads `url` in a DEDICATED headless browser (never the recording
  // session's `state.browser`), waits for `load`, captures the serialized
  // DOM (`documentElement.outerHTML`) + a PNG screenshot + bounding box
  // metadata for every element (step 4 of the plan surfaces this to the
  // UI via the cached snapshot + bbox overlay).
  //
  // Contract:
  //   params  : { url: string, viewport?: { width, height }, timeoutMs?: number }
  //   result  : {
  //     url: string,            // resolved (base-url-aware)
  //     domHash: string,        // SHA-256 of innerHTML (hex)
  //     innerHTML: string,      // full <html> outer HTML
  //     screenshotBase64: string, // PNG bytes base64-encoded
  //     capturedAt: string      // ISO timestamp
  //   }
  //
  // Errors:
  //   -32000 on navigation failure, timeout, or unsupported URL scheme.
  //
  // Never mutates `state.page` / `state.context` — the author-time flow
  // must not disturb an in-flight recording session.
  captureSnapshot: async ({ url, viewport, timeoutMs } = {}) => {
    if (typeof url !== 'string' || url.length === 0) {
      const err = new Error('captureSnapshot: url must be a non-empty string');
      err.code = -32602;
      throw err;
    }
    if (/^(chrome|about|view-source):/i.test(url)) {
      const err = new Error(`captureSnapshot: unsupported URL scheme for ${url}`);
      err.code = -32000;
      throw err;
    }
    const resolved = absolute(url);
    const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;

    // Lazy-launch the author-time browser. Kept alive across snapshot calls
    // so repeated `captureSnapshot` from the editor doesn't pay cold-start
    // Chromium spawn cost every time.
    if (!state.authorBrowser) {
      state.authorBrowser = await chromium.launch({ headless: true });
    }
    if (!state.authorContext) {
      state.authorContext = await state.authorBrowser.newContext({
        viewport:
          viewport && typeof viewport.width === 'number'
            ? { width: viewport.width, height: viewport.height }
            : { width: 1280, height: 800 },
      });
    }

    const page = await state.authorContext.newPage();
    try {
      await page.goto(resolved, { waitUntil: 'load', timeout: t });
      const innerHTML = await page.evaluate(
        () => document.documentElement.outerHTML,
      );
      const buf = await page.screenshot({ type: 'png', fullPage: false });
      const screenshotBase64 = buf.toString('base64');
      const domHash = createHash('sha256').update(innerHTML).digest('hex');
      return {
        url: resolved,
        domHash,
        innerHTML,
        screenshotBase64,
        capturedAt: new Date().toISOString(),
      };
    } finally {
      // Close the page (not the browser/context) so we release memory
      // between snapshots. The context is reused for efficiency; it gets
      // torn down alongside the author browser in `close`. Idle-close
      // timer re-armed on every call so a ~80 MB Chromium isn't pinned
      // after the editor goes idle.
      try {
        await page.close();
      } catch {}
      armAuthorIdleClose();
    }
  },

  // Test-only shim (Plan 05-02 Task 0): let vitest exercise the
  // remote-browser response shape without a real remote CDP endpoint.
  // Safe to ship because it only mutates a non-observable flag — all
  // real capture paths ignore it unless a browser is actually attached.
  __test_set_remote_browser: async ({ enabled }) => {
    state.fakeRemoteBrowser = Boolean(enabled);
    return { ok: true };
  },

  // element picker.
  //
  // CONTRACT: pickElement.start response.emitted is the DSL line to insert at cursor. Drift breaks 07-03b UI flow.
  //
  // Activates the in-page overlay (window.__sc_picker.start), waits for ONE
  // click (or Esc/cancel/navigation/timeout), runs the ranked DSL generator
  // against the resulting candidate payload, and returns the verified DSL
  // line as `result.emitted`. Per-frame overlay injection happens at
  // launch via context.addInitScript(OVERLAY_IIFE).
  //
  // Response shapes:
  //   success:      { emitted, locator: {kind, value}, candidates: [...] }
  //   user-cancel:  { cancelled: true, reason: "user-cancel" }
  //   navigation:   { cancelled: true, reason: "navigation" }
  //   timeout:      { cancelled: true, reason: "timeout" }
  //   bad URL:      { cancelled: true, reason: "unsupported-url" }
  'pickElement.start': async ({ timeoutMs = 60000 } = {}) => {
    if (!state.page) {
      const err = new Error('browser not launched');
      err.code = -32000;
      throw err;
    }
    const url = state.page.url() || '';
    if (/^(chrome|about|view-source):/i.test(url)) {
      return { cancelled: true, reason: 'unsupported-url' };
    }
    if (state.pickerPending) {
      const err = new Error('picker already active');
      err.code = -32000;
      throw err;
    }

    const page = state.page;
    return await new Promise((resolveOuter, rejectOuter) => {
      let timer = null;
      let framenavListener = null;
      let settled = false;

      const cleanup = async () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (framenavListener) {
          try { page.off('framenavigated', framenavListener); } catch {}
          framenavListener = null;
        }
        try { await page.evaluate(() => window.__sc_picker?.stop()); } catch {}
        state.pickerPending = null;
      };

      const settle = async (value) => {
        if (settled) return;
        settled = true;
        await cleanup();
        resolveOuter(value);
      };

      framenavListener = (frame) => {
        // Only the main-frame navigation cancels the pick.
        if (frame !== page.mainFrame()) return;
        settle({ cancelled: true, reason: 'navigation' });
      };
      timer = setTimeout(
        () => settle({ cancelled: true, reason: 'timeout' }),
        Math.max(1, Number(timeoutMs) || 60000),
      );

      state.pickerPending = { settle, cleanup };
      page.on('framenavigated', framenavListener);

      const exposePromise = state.pickerBoundPages.has(page)
        ? Promise.resolve()
        : page
            .exposeBinding('__sc_picker_emit', async ({ page: _p }, payload) => {
              if (settled) return;
              if (payload && payload.__cancel) {
                await settle({ cancelled: true, reason: 'user-cancel' });
                return;
              }
              try {
                const result = await emitDsl(page, payload);
                await settle(result);
              } catch (e) {
                await settle({
                  cancelled: true,
                  reason: `generator-error: ${e.message || e}`,
                });
              }
            })
            .then(() => {
              state.pickerBoundPages.add(page);
            })
            .catch(() => {
              // Already exposed — safe to ignore (e.g. previous start
              // bound it; the binding is per-page-lifetime).
              state.pickerBoundPages.add(page);
            });

      // expose the hover channel alongside the emit channel.
      // rAF-throttled mouseover in the overlay calls window.__sc_picker_hover
      // with a lightweight payload; the binding forwards it as an id-absent
      // JSON-RPC notification (`pickElement.hoverPreview`) to stdout. The
      // Rust reader loop fan-outs via the notifications broadcast channel.
      const hoverExposePromise = state.pickerHoverBoundPages.has(page)
        ? Promise.resolve()
        : page
            .exposeBinding('__sc_picker_hover', async ({ page: _p }, payload) => {
              // Do not spam after settle — the overlay itself stops
              // listening, but a race between stop() and a last in-flight
              // rAF callback is possible.
              if (settled) return;
              writeNotification('pickElement.hoverPreview', payload || {});
            })
            .then(() => {
              state.pickerHoverBoundPages.add(page);
            })
            .catch(() => {
              state.pickerHoverBoundPages.add(page);
            });

      Promise.all([exposePromise, hoverExposePromise])
        .then(() => page.evaluate(() => window.__sc_picker?.start()))
        .catch(async (e) => {
          await settle({
            cancelled: true,
            reason: `start-error: ${e.message || e}`,
          });
        });
    });
  },

  'pickElement.cancel': async () => {
    if (state.pickerPending) {
      const pending = state.pickerPending;
      await pending.settle({ cancelled: true, reason: 'user-cancel' });
    }
    return { ok: true };
  },

  'pickElement.isActive': async () => ({ active: !!state.pickerPending }),

  // test-only hooks. The Rust driver never calls these; they
  // exist so vitest can synthesize click + Escape events deterministically
  // (real mouse coordination in headless CI is flaky). Guarded by the
  // `__test_` prefix convention already used by __test_set_remote_browser.
  __test_simulate_pick: async ({ selector }) => {
    if (!state.page) {
      const err = new Error('browser not launched');
      err.code = -32000;
      throw err;
    }
    await state.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('no element for selector ' + sel);
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    }, selector);
    return { ok: true };
  },

  // deterministic hover for vitest. Dispatches a mouseover
  // event on the overlay at the given selector; the overlay's
  // rAF-throttled handler fires `window.__sc_picker_hover(payload)` on
  // the next animation frame, which the server turns into a
  // `pickElement.hoverPreview` JSON-RPC notification.
  __test_simulate_hover: async ({ selector }) => {
    if (!state.page) {
      const err = new Error('browser not launched');
      err.code = -32000;
      throw err;
    }
    await state.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('no element for selector ' + sel);
      el.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, cancelable: true }),
      );
    }, selector);
    return { ok: true };
  },

  __test_simulate_pick_cancel: async () => {
    if (!state.page) {
      const err = new Error('browser not launched');
      err.code = -32000;
      throw err;
    }
    await state.page.evaluate(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
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
  // strict explicit strategies (D-06 encoding).
  // Routed on `strategy` FIRST so prefix collisions (e.g. "text=" shared
  // with legacy VisibleText) don't mis-dispatch.
  if (strategy === 'role') {
    // value shape: "role=<role-kebab>:<name>" — split on FIRST ':' so names may contain ':'
    const body = selector.slice('role='.length);
    const idx = body.indexOf(':');
    if (idx < 0) throw new Error(`invalid role selector encoding: ${selector}`);
    const role = body.slice(0, idx);
    const name = body.slice(idx + 1);
    return state.page.getByRole(role, { name, exact: true });
  }
  if (strategy === 'label') {
    // value shape: "label=<name>"
    const name = selector.slice('label='.length);
    return state.page.getByLabel(name, { exact: true });
  }
  if (strategy === 'text_exact') {
    // value shape: "text=<name>" — SAME wire prefix as legacy VisibleText, but
    // the strategy dispatch distinguishes them: 'text_exact' → exact, no fallback.
    const name = selector.slice('text='.length);
    return state.page.getByText(name, { exact: true });
  }

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

// INVARIANT: targetToLocator() returns `string | Locator`.
// All call sites MUST handle both shapes. Current call sites (as of Phase 7):
//   - waitFor:  string → page.waitForSelector(s); Locator → loc.waitFor({state:'attached'})
//   - assert:   string → page.locator(s).count(); Locator → loc.count()
// New callers: follow the same `typeof loc === 'string'` pattern.
// Phase 7 Tier 1 adds three `kind` values that return Locators:
//   "role" (value = { role, name }), "label" (value = string), "text_exact" (value = string).
function targetToLocator(target) {
  if (!target) return '*';
  if (target.kind === 'selector') return target.value;
  if (target.kind === 'testid') return `[data-testid="${target.value}"]`;
  if (target.kind === 'aria') return `[aria-label="${target.value}"]`;
  // these branches return a LOCATOR (not string).
  if (target.kind === 'role') {
    // value is an object: { role: <kebab>, name: <string> }
    const { role, name } = target.value;
    return state.page.getByRole(role, { name, exact: true });
  }
  if (target.kind === 'label') {
    return state.page.getByLabel(target.value, { exact: true });
  }
  if (target.kind === 'text_exact') {
    return state.page.getByText(target.value, { exact: true });
  }
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
  // tear down the author-time snapshot browser on sidecar shutdown.
  if (state.authorBrowser) {
    try {
      await state.authorBrowser.close();
    } catch {}
  }
  process.exit(0);
});

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// id-absent JSON-RPC notifications for live-hover preview.
// Separate from `write` so notifications share a single serialization path
// with a clear type signature. The Rust reader (playwright_driver.rs)
// dispatches any id-absent + method-present line to the broadcast channel.
function writeNotification(method, params) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n',
  );
}
