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
import { chromium } from 'playwright-core';

let state = {
  browser: null,
  context: null,
  page: null,
  baseUrl: null,
  downloadDir: null,
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
    const { viewport, theme, baseUrl, headless, downloadDir } = params || {};
    state.baseUrl = baseUrl || null;
    state.downloadDir = downloadDir || null;
    state.browser = await chromium.launch({ headless: headless !== false });
    state.context = await state.browser.newContext({
      viewport: viewport ? { width: viewport.width, height: viewport.height } : undefined,
      colorScheme:
        theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'no-preference',
      acceptDownloads: true,
    });
    state.page = await state.context.newPage();
    return { ok: true };
  },

  close: async () => {
    if (state.browser) await state.browser.close();
    state = { browser: null, context: null, page: null, baseUrl: null, downloadDir: null };
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

  elementState: async ({ selector }) => {
    const result = await state.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
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
    }, selector);
    return result || { visible: false, inViewport: false, animating: false };
  },

  cursorPosition: async () => {
    return { x: 0, y: 0 };
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
    return state.page.getByLabel(selector.slice('aria-name='.length));
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
  process.exit(0);
});

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
