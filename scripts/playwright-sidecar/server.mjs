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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { emitDsl } from "./picker/generator.mjs";
import {
  nextWindowBoundsForViewport,
  VIEWPORT_FIT_MAX_ATTEMPTS,
  VIEWPORT_FIT_SETTLE_MS,
} from "./viewport-fit.mjs";

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
    candidates.push(fileURLToPath(new URL("./picker/overlay/overlay.iife.js", import.meta.url)));
  } catch {
    /* import.meta.url unavailable in some embed contexts */
  }
  try {
    const exeDir = pathDirname(process.execPath);
    candidates.push(pathResolve(exeDir, "playwright-sidecar-modules", "overlay.iife.js"));
    candidates.push(
      pathResolve(exeDir, "..", "Resources", "playwright-sidecar-modules", "overlay.iife.js"),
    );
  } catch {
    /* defensive — process.execPath should always exist */
  }
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* try next */
    }
  }
  // Last resort: empty IIFE so the sidecar still boots when running tests
  // that don't need the picker. Picker handlers will degrade — the build
  // pipeline is the source of truth.
  return "";
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
  appModeRequested: false,
  appModeReused: false,
  recordingViewport: null,
  recordingDeviceScaleFactor: null,
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
  authorContextKey: null,
  // Idle-close timer for the author browser. Closed after this many ms
  // of no captureSnapshot activity so a long editor session doesn't pin
  // ~80 MB of headless Chromium indefinitely. Re-launches on the next
  // captureSnapshot call at ~500 ms cold-start cost.
  authorIdleHandle: null,
  // Preview (Phase 09-01): CDP screencast → preview/frame notifications.
  // Preview failure must not cascade into recording (intentional isolation,
  // not a workaround per CLAUDE.md).
  cdp: null,
  latestFrame: null,
  flushScheduled: false,
  previewEveryNth: 1,
  previewViewport: null,
  previewSharpTimer: null,
  previewSharpLastLogAt: 0,
  // Phase 09-03 — bounded in-flight counter. Incremented each time a
  // screencastFrame arrives while state.latestFrame is still pending
  // flush (single-slot overwrite == dropped frame).
  previewDropCount: 0,
  // Phase 09-04 — author-time sessions keyed by streamId. Each entry is
  // an independent Chromium session (separate browserServer + context +
  // page + cdp). Isolation from the recording session is a correctness
  // requirement, not a workaround.
  //   Map<streamId, {
  //     browserServer, browser, context, page,
  //     cdp, latestFrame, flushScheduled, previewEveryNth, previewViewport,
  //     previewDropCount, paused
  //   }>
  authorSessions: new Map(),
  activeAuthorStream: null,
};

const AUTHOR_IDLE_MS = 5 * 60 * 1000;
const PREVIEW_JPEG_QUALITY = 95;
const PREVIEW_MAX_WIDTH = 1920;
const PREVIEW_MAX_HEIGHT = 1440;
const PREVIEW_SHARP_IDLE_MS = 220;
const PREVIEW_SHARP_DEVICE_SCALE_FACTOR = 2;
const PREVIEW_SHARP_LOG_INTERVAL_MS = 5_000;
const RECORDING_DEVICE_SCALE_FACTOR_FALLBACK = 1;
const CHROMIUM_UI_SUPPRESSION_ARGS = [
  "--disable-translate",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-features=Translate,TranslateUI,TranslateSubFrames",
];

function clampPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
}

function screencastViewportFor(probe) {
  const width = clampPositiveInt(probe?.width, 1280);
  const height = clampPositiveInt(probe?.height, 720);
  return {
    maxWidth: Math.min(width, PREVIEW_MAX_WIDTH),
    maxHeight: Math.min(height, PREVIEW_MAX_HEIGHT),
  };
}

function buildScreencastOptions(target) {
  const viewport = target.previewViewport ?? { maxWidth: 1280, maxHeight: 720 };
  return {
    format: "jpeg",
    quality: PREVIEW_JPEG_QUALITY,
    maxWidth: viewport.maxWidth,
    maxHeight: viewport.maxHeight,
    everyNthFrame: target.previewEveryNth,
  };
}

function contextEnvironmentOptions(browserEnvironment = {}) {
  const env =
    browserEnvironment && typeof browserEnvironment === "object" ? browserEnvironment : {};
  const opts = {};
  if (typeof env.locale === "string" && env.locale.length > 0) {
    opts.locale = env.locale;
  }
  if (typeof env.timezoneId === "string" && env.timezoneId.length > 0) {
    opts.timezoneId = env.timezoneId;
  }
  if (typeof env.acceptLanguage === "string" && env.acceptLanguage.length > 0) {
    opts.extraHTTPHeaders = { "Accept-Language": env.acceptLanguage };
  }
  return opts;
}

function browserEnvironmentLaunchArgs(browserEnvironment = {}) {
  const env =
    browserEnvironment && typeof browserEnvironment === "object" ? browserEnvironment : {};
  const args = [];
  if (typeof env.locale === "string" && env.locale.length > 0) {
    args.push(`--lang=${env.locale}`);
  }
  if (typeof env.acceptLanguage === "string" && env.acceptLanguage.length > 0) {
    args.push(`--accept-lang=${env.acceptLanguage}`);
  }
  return args;
}

function redactUrlForLog(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const value = raw.startsWith("--app=") ? raw.slice("--app=".length) : raw;
  if (value === "about:blank") return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function redactArgForLog(arg) {
  if (typeof arg !== "string") return "<non-string>";
  if (arg.startsWith("--app=")) return `--app=${redactUrlForLog(arg)}`;
  if (arg.startsWith("--accept-lang=")) return "--accept-lang=<set>";
  return arg;
}

function chromiumUiSuppressionArgs(args = []) {
  const next = Array.isArray(args) ? [...args] : [];
  const featureIndex = next.findIndex(
    (arg) => typeof arg === "string" && arg.startsWith("--disable-features="),
  );
  for (const hygieneArg of CHROMIUM_UI_SUPPRESSION_ARGS) {
    if (hygieneArg.startsWith("--disable-features=")) {
      const wanted = hygieneArg.slice("--disable-features=".length).split(",");
      if (featureIndex >= 0) {
        const existing = new Set(next[featureIndex].slice("--disable-features=".length).split(","));
        const missing = wanted.filter((flag) => !existing.has(flag));
        if (missing.length > 0) next[featureIndex] += `,${missing.join(",")}`;
      } else {
        next.push(hygieneArg);
      }
      continue;
    }
    if (!next.includes(hygieneArg)) next.push(hygieneArg);
  }
  return next;
}

function sidecarLog(evt, fields = {}) {
  process.stderr.write(`[sc-sidecar] ${JSON.stringify({ evt, ...fields })}\n`);
}

function parseStorageState(storageStateJson) {
  if (typeof storageStateJson !== "string" || storageStateJson.length === 0) {
    return undefined;
  }
  return JSON.parse(storageStateJson);
}

function pngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    return null;
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function clearSharpPreviewTimer(target) {
  if (target.previewSharpTimer) {
    clearTimeout(target.previewSharpTimer);
    target.previewSharpTimer = null;
  }
}

function scheduleSharpPreviewFrame(target, page, { streamId } = {}) {
  if (!target.cdp || target.paused || !page) return;
  clearSharpPreviewTimer(target);
  const cdpAtSchedule = target.cdp;
  target.previewSharpTimer = setTimeout(() => {
    target.previewSharpTimer = null;
    emitSharpPreviewFrame(target, page, { streamId, cdpAtSchedule }).catch((err) => {
      if (process.env.DEBUG && /storycapture-sidecar/.test(process.env.DEBUG)) {
        process.stderr.write(
          `[debug] preview sharp frame skipped: ${err && err.message ? err.message : err}\n`,
        );
      }
    });
  }, PREVIEW_SHARP_IDLE_MS);
  if (typeof target.previewSharpTimer.unref === "function") {
    target.previewSharpTimer.unref();
  }
}

async function emitSharpPreviewFrame(target, page, { streamId, cdpAtSchedule } = {}) {
  if (!target.cdp || target.cdp !== cdpAtSchedule || target.paused) return;
  const viewport = page.viewportSize();
  if (!viewport?.width || !viewport?.height) return;
  const screenshot = await target.cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    clip: {
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
      scale: PREVIEW_SHARP_DEVICE_SCALE_FACTOR,
    },
  });
  const data = screenshot.data;
  if (!target.cdp || target.cdp !== cdpAtSchedule || target.paused) return;
  const buf = Buffer.from(data, "base64");
  const size = pngSize(buf) ?? { width: 0, height: 0 };
  const expectedWidth = viewport.width * PREVIEW_SHARP_DEVICE_SCALE_FACTOR;
  const expectedHeight = viewport.height * PREVIEW_SHARP_DEVICE_SCALE_FACTOR;
  if (size.width < expectedWidth || size.height < expectedHeight) {
    process.stderr.write(
      `[sc-sidecar] preview sharp frame skipped streamId=${streamId || "(recording)"} viewport=${viewport.width}x${viewport.height} png=${size.width}x${size.height} expected=${expectedWidth}x${expectedHeight} reason=not_hi_dpi\n`,
    );
    return;
  }
  const now = Date.now();
  if (
    !target.previewSharpLastLogAt ||
    now - target.previewSharpLastLogAt >= PREVIEW_SHARP_LOG_INTERVAL_MS
  ) {
    target.previewSharpLastLogAt = now;
    process.stderr.write(
      `[sc-sidecar] preview sharp frame emitted streamId=${streamId || "(recording)"} viewport=${viewport?.width ?? 0}x${viewport?.height ?? 0} png=${size.width}x${size.height} dpr=${PREVIEW_SHARP_DEVICE_SCALE_FACTOR} idleMs=${PREVIEW_SHARP_IDLE_MS}\n`,
    );
  }
  writeNotification("preview/frame", {
    ...(streamId ? { streamId } : {}),
    data,
    width: size.width,
    height: size.height,
    timestamp: Date.now() / 1000,
    format: "png",
    mimeType: "image/png",
    sharp: true,
  });
}

// Map a renderer-side KeyboardEvent {key, code} pair to the string accepted
// by Playwright's `page.keyboard.down/up`. Prefer `code` for layout-
// independent physical keys (modifiers, navigation, function keys); prefer
// `key` for character-producing keys so Shift-modified characters carry
// their shifted form (e.g. "A" vs "a"). See plan §4.8.
export function toPlaywrightKey(event) {
  if (!event || typeof event !== "object") return null;
  const { key, code } = event;
  if (
    typeof code === "string" &&
    code.length > 0 &&
    (code.startsWith("Shift") ||
      code.startsWith("Control") ||
      code.startsWith("Alt") ||
      code.startsWith("Meta") ||
      code === "Tab" ||
      code === "Enter" ||
      code === "Escape" ||
      code === "Backspace" ||
      code === "Delete" ||
      code.startsWith("Arrow") ||
      code.startsWith("Page") ||
      code === "Home" ||
      code === "End" ||
      /^F\d{1,2}$/.test(code))
  ) {
    return code;
  }
  if (typeof key === "string" && key.length > 0) return key;
  if (typeof code === "string" && code.length > 0) return code;
  return null;
}

// Phase 09-04 — helpers for per-streamId author sessions. Each session is
// an independent Chromium launch, tracked in `state.authorSessions`.
function getAuthorSession(streamId) {
  if (typeof streamId !== "string" || streamId.length === 0) {
    throw Object.assign(new Error("streamId required"), { code: -32602 });
  }
  const s = state.authorSessions.get(streamId);
  if (!s) {
    throw Object.assign(new Error(`author session not found: ${streamId}`), {
      code: -32000,
    });
  }
  return s;
}

// When a simulator or author-scoped runner sets `state.activeAuthorStream`,
// bare automation verbs (goto/click/type/etc.) target that session's page.
// Falls back to the recording page (`state.page`) otherwise. Throws a
// descriptive error when neither is available so step failures carry a
// clear cause instead of a null-dereference TypeError.
function pickPage() {
  if (state.activeAuthorStream) {
    const s = state.authorSessions.get(state.activeAuthorStream);
    if (s && s.page) return s.page;
    throw new Error(`active author stream ${state.activeAuthorStream} has no page`);
  }
  if (state.page) return state.page;
  throw new Error("no page available — neither recording nor author session is active");
}

async function teardownAuthorSession(session) {
  clearSharpPreviewTimer(session);
  if (session.cdp) {
    try {
      await session.cdp.send("Page.stopScreencast", {});
    } catch {}
    try {
      await session.cdp.detach();
    } catch {}
    session.cdp = null;
  }
  if (session.browser) {
    try {
      await session.browser.close();
    } catch {}
  }
  if (session.browserServer) {
    try {
      await session.browserServer.close();
    } catch {}
  }
  session.browser = null;
  session.browserServer = null;
  session.context = null;
  session.page = null;
}

async function closeAuthorBrowser() {
  const b = state.authorBrowser;
  state.authorBrowser = null;
  state.authorContext = null;
  state.authorContextKey = null;
  if (state.authorIdleHandle) {
    clearTimeout(state.authorIdleHandle);
    state.authorIdleHandle = null;
  }
  if (b) {
    try {
      await b.close();
    } catch {}
  }
}

async function fitViewportToContent(page, context, viewport) {
  if (!viewport || !viewport.width || !viewport.height) {
    return null;
  }

  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");

    for (let attempt = 1; attempt <= VIEWPORT_FIT_MAX_ATTEMPTS; attempt += 1) {
      const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
      const inner = await page.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
      }));
      const fit = nextWindowBoundsForViewport(bounds, inner, viewport);

      if (fit.done) {
        return { ok: true, attempts: attempt, bounds, inner, fit };
      }

      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          width: fit.nextBounds.width,
          height: fit.nextBounds.height,
          windowState: "normal",
        },
      });
      await page.waitForTimeout(VIEWPORT_FIT_SETTLE_MS);
    }

    const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
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

async function ensureCaptureWindowVisible(page) {
  await page.bringToFront().catch(() => {});
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    const before = await cdp.send("Browser.getWindowBounds", { windowId }).catch(() => null);
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await page.waitForTimeout(120);
    await page.bringToFront().catch(() => {});
    const after = await cdp.send("Browser.getWindowBounds", { windowId }).catch(() => null);
    return { ok: true, before: before?.bounds ?? null, after: after?.bounds ?? null };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function waitForAppModeContext(browser, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const context = browser.contexts().find((candidate) => candidate.pages().length > 0);
    if (context) return context;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return browser.contexts().find((candidate) => candidate.pages().length > 0) ?? null;
}

async function applyEnvironmentToExistingPage(page, browserEnvironment = {}) {
  const env =
    browserEnvironment && typeof browserEnvironment === "object" ? browserEnvironment : {};
  if (typeof env.acceptLanguage === "string" && env.acceptLanguage.length > 0) {
    await page.context().setExtraHTTPHeaders({ "Accept-Language": env.acceptLanguage });
  }
  if (typeof env.locale === "string" && env.locale.length > 0) {
    await page.context().addInitScript((locale) => {
      const languages = [locale, locale.split("-")[0]].filter(Boolean);
      Object.defineProperty(Navigator.prototype, "language", {
        configurable: true,
        get: () => locale,
      });
      Object.defineProperty(Navigator.prototype, "languages", {
        configurable: true,
        get: () => languages,
      });
    }, env.locale);
  }
  if (
    typeof env.locale !== "string" &&
    typeof env.timezoneId !== "string"
  ) {
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  try {
    if (typeof env.locale === "string" && env.locale.length > 0) {
      await cdp.send("Emulation.setLocaleOverride", { locale: env.locale });
    }
    if (typeof env.timezoneId === "string" && env.timezoneId.length > 0) {
      await cdp.send("Emulation.setTimezoneOverride", { timezoneId: env.timezoneId });
    }
  } finally {
    try {
      await cdp.detach();
    } catch {}
  }
}

async function pageDiagnostics(page) {
  try {
    return await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
    }));
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

function normalizeRecordingDeviceScaleFactor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return RECORDING_DEVICE_SCALE_FACTOR_FALLBACK;
  return Math.min(Math.max(n, 1), 4);
}

async function detectRecordingDeviceScaleFactor(page) {
  const diag = await pageDiagnostics(page);
  return normalizeRecordingDeviceScaleFactor(diag.devicePixelRatio);
}

async function ensureRecordingDeviceScaleFactor(page, reason) {
  if (!state.appModeRequested || !state.recordingViewport || page.context() !== state.context) {
    return null;
  }
  if (state.recordingDeviceScaleFactor == null) {
    state.recordingDeviceScaleFactor = await detectRecordingDeviceScaleFactor(page);
    sidecarLog("recording_device_scale_factor_detected", {
      reason,
      deviceScaleFactor: state.recordingDeviceScaleFactor,
    });
  }
  // Do not use Emulation.setDeviceMetricsOverride here. This is a real,
  // visible Chromium window captured by ScreenCaptureKit; forcing CDP device
  // metrics can desynchronize Chromium's compositor surface from the native
  // window and produce wrapped/duplicated captured pixels. Fit the actual
  // native window instead, then only report DPR so the host can scale crops.
  const diag = await pageDiagnostics(page);
  const result = {
    ok: !diag.error,
    expectedDeviceScaleFactor: state.recordingDeviceScaleFactor,
    actualDevicePixelRatio: diag.devicePixelRatio ?? null,
    innerWidth: diag.innerWidth ?? null,
    innerHeight: diag.innerHeight ?? null,
    outerWidth: diag.outerWidth ?? null,
    outerHeight: diag.outerHeight ?? null,
    deviceMetricsOverride: false,
    error: diag.error ?? null,
  };
  sidecarLog("recording_device_scale_factor", { reason, ...result });
  return result;
}

async function pageContentCrop(page) {
  const metrics = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenX: window.screenX,
    screenY: window.screenY,
    devicePixelRatio: window.devicePixelRatio || 1,
  }));
  const horizontalChrome = Math.max(0, metrics.outerWidth - metrics.innerWidth);
  const verticalChrome = Math.max(0, metrics.outerHeight - metrics.innerHeight);
  // Return logical/CSS coordinates plus the outer-window basis. Native capture
  // backends may deliver Retina/DPI-scaled frames even when Chromium reports
  // devicePixelRatio=1, so the host scales this rect against the actual frame.
  const crop = {
    x: Math.max(0, Math.round(horizontalChrome / 2)),
    y: Math.max(0, Math.round(verticalChrome)),
    w: Math.max(1, Math.round(metrics.innerWidth)),
    h: Math.max(1, Math.round(metrics.innerHeight)),
    basis_w: Math.max(1, Math.round(metrics.outerWidth)),
    basis_h: Math.max(1, Math.round(metrics.outerHeight)),
  };

  let bounds = null;
  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      const response = await cdp.send("Browser.getWindowBounds", { windowId });
      bounds = response.bounds ?? null;
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch (e) {
    bounds = { error: e?.message || String(e) };
  }

  return { crop, metrics, bounds };
}

function armAuthorIdleClose() {
  if (state.authorIdleHandle) clearTimeout(state.authorIdleHandle);
  state.authorIdleHandle = setTimeout(() => {
    state.authorIdleHandle = null;
    closeAuthorBrowser().catch(() => {});
  }, AUTHOR_IDLE_MS);
  if (typeof state.authorIdleHandle.unref === "function") {
    state.authorIdleHandle.unref();
  }
}

// Attach a Page.startScreencast session to `target` (either the top-level
// `state` or an entry in `state.authorSessions`). Mutates target.cdp /
// latestFrame / previewDropCount / flushScheduled / previewEveryNth.
async function attachScreencast(target, page, { streamId, scheduleFlush, isPaused } = {}) {
  target.cdp = await page.context().newCDPSession(page);
  target.cdp.on("Page.screencastFrame", (frame) => {
    if (isPaused && isPaused()) return;
    if (target.latestFrame !== null) target.previewDropCount++;
    target.latestFrame = {
      data: frame.data,
      width: frame.metadata?.deviceWidth ?? 0,
      height: frame.metadata?.deviceHeight ?? 0,
      timestamp: frame.metadata?.timestamp ?? Date.now() / 1000,
      sessionId: frame.sessionId,
      format: "jpeg",
      mimeType: "image/jpeg",
      sharp: false,
    };
    if (!target.flushScheduled) {
      target.flushScheduled = true;
      setImmediate(scheduleFlush);
    }
  });
  const probe = await page
    .evaluate(() => ({
      dpr: window.devicePixelRatio,
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    .catch(() => ({ dpr: 1, width: 1280, height: 720 }));
  target.previewEveryNth = probe.dpr >= 2 || probe.width > 1600 ? 2 : 1;
  target.previewViewport = screencastViewportFor(probe);
  if (process.env.DEBUG && /storycapture-sidecar/.test(process.env.DEBUG)) {
    process.stderr.write(
      `[debug] previewEveryNth=${target.previewEveryNth} dpr=${probe.dpr} vp=${probe.width}x${probe.height} max=${target.previewViewport.maxWidth}x${target.previewViewport.maxHeight}${streamId ? ` streamId=${streamId}` : ""}\n`,
    );
  }
  await target.cdp.send("Page.startScreencast", buildScreencastOptions(target));
  scheduleSharpPreviewFrame(target, page, { streamId });
  return target.previewEveryNth;
}

async function detachScreencast(target) {
  if (!target.cdp) return 0;
  clearSharpPreviewTimer(target);
  const cdp = target.cdp;
  try {
    await cdp.send("Page.stopScreencast", {});
  } catch {}
  try {
    await cdp.detach();
  } catch {}
  const dropped = target.previewDropCount;
  target.cdp = null;
  target.latestFrame = null;
  target.flushScheduled = false;
  target.previewDropCount = 0;
  target.previewViewport = null;
  target.previewSharpTimer = null;
  return dropped;
}

async function restartScreencast(target) {
  clearSharpPreviewTimer(target);
  try {
    await target.cdp.send("Page.stopScreencast", {});
  } catch {}
  target.latestFrame = null;
  target.flushScheduled = false;
  await target.cdp.send("Page.startScreencast", buildScreencastOptions(target));
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
      browserEnvironment,
      storageState,
    } = params || {};
    state.baseUrl = baseUrl || null;
    state.downloadDir = downloadDir || null;
    // Plan 06-02: args is an optional array of Chromium CLI flags (e.g.
    // ["--app=https://demo.com"] for chrome-hiding per D-09/D-10). Defaults
    // to [] so pre-06-02 call sites (Plan 05-02 tests) keep working.
    const extraArgs = chromiumUiSuppressionArgs(args);
    for (const envArg of browserEnvironmentLaunchArgs(browserEnvironment)) {
      const key = envArg.split("=")[0];
      if (!extraArgs.some((arg) => typeof arg === "string" && arg.startsWith(`${key}=`))) {
        extraArgs.push(envArg);
      }
    }
    const appArg = extraArgs.find((a) => typeof a === "string" && a.startsWith("--app="));
    const hasApp = typeof appArg === "string";
    state.recordingViewport =
      hasApp && viewport?.width && viewport?.height
        ? { width: viewport.width, height: viewport.height }
        : null;
    state.recordingDeviceScaleFactor = null;
    if (hasApp) {
      sidecarLog("app_mode_launch_requested", {
        appUrl: redactUrlForLog(appArg),
        headless: headless !== false,
        executableSet: Boolean(executable),
        channel: channel || null,
        args: extraArgs.map(redactArgForLog),
        browserEnvironment: {
          locale: browserEnvironment?.locale ?? null,
          timezoneId: browserEnvironment?.timezoneId ?? null,
          acceptLanguageSet: typeof browserEnvironment?.acceptLanguage === "string",
        },
        storageStateSet: typeof storageState === "string" && storageState.length > 0,
      });
    }
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
    const appContext = hasApp ? await waitForAppModeContext(state.browser) : null;
    state.appModeRequested = hasApp;
    state.appModeReused = Boolean(appContext);
    if (hasApp) {
      sidecarLog("app_mode_context_resolution", {
        appContextFound: Boolean(appContext),
        contextCount: state.browser.contexts().length,
        contexts: state.browser.contexts().map((context, index) => ({
          index,
          pageCount: context.pages().length,
          urls: context.pages().map((page) => redactUrlForLog(page.url())),
        })),
      });
    }
    state.context =
      appContext ??
      (await state.browser.newContext({
        viewport: null,
        colorScheme: theme === "dark" ? "dark" : theme === "light" ? "light" : "no-preference",
        acceptDownloads: true,
        ...(storageState ? { storageState: parseStorageState(storageState) } : {}),
        ...contextEnvironmentOptions(browserEnvironment),
      }));
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
    const existingPages = state.context.pages();
    if (hasApp && existingPages.length > 0) {
      state.page = existingPages[0];
    } else if (existingPages.length > 0) {
      state.page = existingPages[0];
    } else {
      state.page = await state.context.newPage();
    }
    if (appContext) {
      await applyEnvironmentToExistingPage(state.page, browserEnvironment);
    }
    if (hasApp) {
      const diag = await pageDiagnostics(state.page);
      sidecarLog("app_mode_page_selected", {
        reusedAppContext: Boolean(appContext),
        pageUrl: redactUrlForLog(diag.url),
        title: diag.title ?? null,
        innerWidth: diag.innerWidth ?? null,
        innerHeight: diag.innerHeight ?? null,
        outerWidth: diag.outerWidth ?? null,
        outerHeight: diag.outerHeight ?? null,
        language: diag.language ?? null,
        languages: diag.languages ?? null,
        error: diag.error ?? null,
      });
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
        if (hasApp) {
          sidecarLog("app_mode_viewport_fit", {
            ok: Boolean(result?.ok),
            attempts: result?.attempts ?? 0,
            wantedWidth: viewport.width,
            wantedHeight: viewport.height,
            innerWidth: result?.inner?.w ?? null,
            innerHeight: result?.inner?.h ?? null,
            boundsWidth: result?.bounds?.width ?? null,
            boundsHeight: result?.bounds?.height ?? null,
          });
        }
      } catch (e) {
        process.stderr.write(
          `[playwright-sidecar] warn: CDP content-size fit failed: ${e.message}\n`,
        );
        if (hasApp) {
          sidecarLog("app_mode_viewport_fit_error", { error: e.message || String(e) });
        }
      }
      if (hasApp) {
        try {
          await ensureRecordingDeviceScaleFactor(state.page, "post_launch_viewport_fit");
        } catch (e) {
          sidecarLog("recording_device_scale_factor_error", { error: e.message || String(e) });
        }
      }
    }
    return { ok: true };
  },

  close: async () => {
    // Preview teardown first — must never throw and must never block close.
    if (state.cdp) {
      try {
        await state.cdp.send("Page.stopScreencast", {});
      } catch (e) {
        process.stderr.write(`[playwright-sidecar] warn: stopScreencast on close: ${e.message}\n`);
      }
      try {
        await state.cdp.detach();
      } catch {}
    }
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
    // also tear down the author-time snapshot browser.
    await closeAuthorBrowser();
    // Phase 09-04 — close every author-session Chromium.
    for (const [, s] of state.authorSessions) {
      await teardownAuthorSession(s);
    }
    state = {
      browser: null,
      context: null,
      page: null,
      baseUrl: null,
      downloadDir: null,
      browserServer: null,
      appModeRequested: false,
      appModeReused: false,
      recordingViewport: null,
      recordingDeviceScaleFactor: null,
      fakeRemoteBrowser: false,
      pickerPending: null,
      pickerBoundPages: new WeakSet(),
      pickerHoverBoundPages: new WeakSet(),
      authorBrowser: null,
      authorContext: null,
      authorContextKey: null,
      authorIdleHandle: null,
      cdp: null,
      latestFrame: null,
      flushScheduled: false,
      previewEveryNth: 1,
      previewViewport: null,
      previewSharpTimer: null,
      previewSharpLastLogAt: 0,
      previewDropCount: 0,
      authorSessions: new Map(),
      activeAuthorStream: null,
    };
    return { ok: true };
  },

  goto: async ({ url }) => {
    const target = absolute(url);
    const page = await pickPage();
    await page.goto(target, { waitUntil: "load" });
    if (state.context && page.context() === state.context) {
      if (state.appModeRequested) {
        await ensureRecordingDeviceScaleFactor(page, "after_goto");
      }
      const diag = await pageDiagnostics(page);
      sidecarLog("recording_goto_complete", {
        appModeRequested: state.appModeRequested,
        appModeReused: state.appModeReused,
        targetUrl: redactUrlForLog(target),
        pageUrl: redactUrlForLog(diag.url),
        title: diag.title ?? null,
        innerWidth: diag.innerWidth ?? null,
        innerHeight: diag.innerHeight ?? null,
        outerWidth: diag.outerWidth ?? null,
        outerHeight: diag.outerHeight ?? null,
        devicePixelRatio: diag.devicePixelRatio ?? null,
        language: diag.language ?? null,
        error: diag.error ?? null,
      });
    }
    return { ok: true };
  },

  click: async ({ selector, strategy, nth }) => {
    const locator = await locate(selector, strategy, nth);
    await locator.click();
    return { ok: true };
  },

  type: async ({ selector, strategy, text, nth }) => {
    const locator = await locate(selector, strategy, nth);
    await locator.fill(text);
    return { ok: true };
  },

  scroll: async ({ direction, amount }) => {
    const px = amount || 400;
    const [x, y] =
      direction === "down"
        ? [0, px]
        : direction === "up"
          ? [0, -px]
          : direction === "right"
            ? [px, 0]
            : [-px, 0];
    await pickPage().evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y]);
    return { ok: true };
  },

  hover: async ({ selector, strategy, nth }) => {
    const locator = await locate(selector, strategy, nth);
    await locator.hover();
    return { ok: true };
  },

  drag: async ({ from, to, fromStrategy, toStrategy, fromNth, toNth }) => {
    const page = pickPage();
    const [fromLoc, toLoc] = await Promise.all([
      locate(from, fromStrategy, fromNth),
      locate(to, toStrategy, toNth),
    ]);
    const [fb, tb] = await Promise.all([fromLoc.boundingBox(), toLoc.boundingBox()]);
    if (!fb || !tb) {
      throw new Error("drag failed: cannot resolve bounding box for locator");
    }
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    return { ok: true };
  },

  select: async ({ selector, strategy, value, nth }) => {
    const loc = await locate(selector, strategy, nth);
    await loc.selectOption(value);
    return { ok: true };
  },

  upload: async ({ selector, strategy, path, nth }) => {
    const loc = await locate(selector, strategy, nth);
    await loc.setInputFiles(path);
    return { ok: true };
  },

  waitMs: async ({ ms }) => {
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true };
  },

  waitFor: async ({ target, timeoutMs }) => {
    const page = pickPage();
    if (target.kind === "text" && target.value && target.value.startsWith("download:")) {
      const download = await page.waitForEvent("download", { timeout: timeoutMs });
      const dest =
        state.downloadDir != null
          ? `${state.downloadDir}/${download.suggestedFilename()}`
          : await download.path();
      if (state.downloadDir) await download.saveAs(dest);
      return { ok: true, downloaded: dest };
    }
    const loc = targetToLocator(target);
    if (typeof loc === "string") {
      await page.waitForSelector(loc, { timeout: timeoutMs });
    } else {
      // Locator — wait for it to attach.
      await loc.waitFor({ state: "attached", timeout: timeoutMs });
    }
    return { ok: true };
  },

  assert: async ({ target }) => {
    const loc = targetToLocator(target);
    const count =
      typeof loc === "string" ? await pickPage().locator(loc).count() : await loc.count();
    if (count === 0) throw new Error(`assert failed: no elements match ${JSON.stringify(target)}`);
    return { ok: true };
  },

  screenshot: async ({ name, outDir }) => {
    const path = `${outDir}/${name}.png`;
    await pickPage().screenshot({ path });
    return { ok: true, path };
  },

  elementState: async ({ selector, strategy, nth }) => {
    // Route through the same `locate()` helper as click/type so that
    // prefixed values (aria-name=, text=, label=, text~=) are resolved
    // via Playwright's locator engine instead of raw CSS querySelector.
    const locator = await locate(selector, strategy, nth);
    const handle = await locator
      .first()
      .elementHandle()
      .catch(() => null);
    if (!handle) {
      return { visible: false, inViewport: false, animating: false };
    }
    const result = await handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const visible =
        s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0;
      const inViewport =
        r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
      const animating = el.getAnimations
        ? el.getAnimations().some((a) => a.playState === "running")
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
      process.stderr.write(`[debug] browserProcess pid=${pid} exec=${executablePath}\n`);
    }
    return { pid, executablePath };
  },

  pageContentCrop: async () => {
    const page = await pickPage();
    await ensureRecordingDeviceScaleFactor(page, "before_page_content_crop");
    const info = await pageContentCrop(page);
    sidecarLog("page_content_crop", {
      crop: info.crop,
      innerWidth: info.metrics?.innerWidth ?? null,
      innerHeight: info.metrics?.innerHeight ?? null,
      outerWidth: info.metrics?.outerWidth ?? null,
      outerHeight: info.metrics?.outerHeight ?? null,
      devicePixelRatio: info.metrics?.devicePixelRatio ?? null,
      bounds: info.bounds ?? null,
    });
    return info;
  },

  ensureCaptureWindowVisible: async () => {
    const page = await pickPage();
    const result = await ensureCaptureWindowVisible(page);
    sidecarLog("capture_window_visible", {
      ok: Boolean(result?.ok),
      before: result?.before ?? null,
      after: result?.after ?? null,
    });
    return result;
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
    if (state.page.url() !== "about:blank") {
      return { ok: true, url: state.page.url() };
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.page.off("framenavigated", onNav);
        reject(new Error(`waitForFirstPaint timeout after ${t}ms`));
      }, t);
      const onNav = (frame) => {
        if (frame !== state.page.mainFrame()) return;
        const url = frame.url();
        if (!url || url === "about:blank") return;
        clearTimeout(timer);
        state.page.off("framenavigated", onNav);
        resolve();
      };
      state.page.on("framenavigated", onNav);
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
  captureSnapshot: async ({ url, viewport, timeoutMs, browserEnvironment, storageState } = {}) => {
    if (typeof url !== "string" || url.length === 0) {
      const err = new Error("captureSnapshot: url must be a non-empty string");
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
      state.authorBrowser = await chromium.launch({
        headless: true,
        args: chromiumUiSuppressionArgs([]),
      });
    }
    const contextViewport =
      viewport && typeof viewport.width === "number"
        ? { width: viewport.width, height: viewport.height }
        : { width: 1280, height: 800 };
    const contextKey = JSON.stringify({
      viewport: contextViewport,
      browserEnvironment: browserEnvironment ?? null,
      storageState: storageState ?? null,
    });
    if (state.authorContext && state.authorContextKey !== contextKey) {
      await state.authorContext.close().catch(() => {});
      state.authorContext = null;
      state.authorContextKey = null;
    }
    if (!state.authorContext) {
      state.authorContext = await state.authorBrowser.newContext({
        viewport: contextViewport,
        ...(storageState ? { storageState: parseStorageState(storageState) } : {}),
        ...contextEnvironmentOptions(browserEnvironment),
      });
      state.authorContextKey = contextKey;
    }

    const page = await state.authorContext.newPage();
    try {
      await page.goto(resolved, { waitUntil: "load", timeout: t });
      const innerHTML = await page.evaluate(() => document.documentElement.outerHTML);
      const buf = await page.screenshot({ type: "png", fullPage: false });
      const screenshotBase64 = buf.toString("base64");
      const domHash = createHash("sha256").update(innerHTML).digest("hex");
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

  // Phase 09-04 — author-session lifecycle (separate Chromium per streamId).
  // Keyed by caller-supplied streamId; recording session (state.page) is
  // never shared. Used by editor-surface Live Preview + Phase 10 simulator.
  "author.launch": async ({
    streamId,
    url,
    viewport,
    headless,
    executable,
    channel,
    theme,
    browserEnvironment,
  } = {}) => {
    if (typeof streamId !== "string" || streamId.length === 0) {
      throw Object.assign(new Error("streamId required"), { code: -32602 });
    }
    if (state.authorSessions.has(streamId)) {
      throw Object.assign(new Error(`author session exists: ${streamId}`), {
        code: -32000,
      });
    }
    const launchOpts = { headless: headless !== false, args: chromiumUiSuppressionArgs([]) };
    if (executable) launchOpts.executablePath = executable;
    else if (channel) launchOpts.channel = channel;
    const browserServer = await chromium.launchServer(launchOpts);
    const browser = await chromium.connect({ wsEndpoint: browserServer.wsEndpoint() });
    const context = await browser.newContext({
      viewport:
        viewport && viewport.width && viewport.height
          ? { width: viewport.width, height: viewport.height }
          : { width: 1280, height: 800 },
      colorScheme: theme === "dark" ? "dark" : theme === "light" ? "light" : "no-preference",
      acceptDownloads: true,
      ...contextEnvironmentOptions(browserEnvironment),
    });
    // Phase 11-03 — inject the picker overlay IIFE into every author-session
    // page so Preview-panel Pick (picker_start_author → pickElement.start
    // with streamId) has `window.__sc_picker` available exactly like the
    // recorder-path context does (see state.context branch above).
    // Keep failure non-fatal: other author verbs (goto/navigate/screencast)
    // must still work even if the overlay bundle is missing at runtime.
    if (OVERLAY_IIFE && OVERLAY_IIFE.length > 0) {
      try {
        await context.addInitScript({ content: OVERLAY_IIFE });
      } catch (e) {
        process.stderr.write(
          `[playwright-sidecar] warn: author.launch addInitScript(overlay) failed: ${e.message}\n`,
        );
      }
    }
    const page = await context.newPage();
    if (typeof url === "string" && url.length > 0) {
      try {
        await page.goto(url, { waitUntil: "load", timeout: 15000 });
      } catch (e) {
        process.stderr.write(
          `[playwright-sidecar] warn: author.launch goto failed: ${e.message}\n`,
        );
      }
    }
    const initialUrl = page.url() || "about:blank";
    const session = {
      browserServer,
      browser,
      context,
      page,
      cdp: null,
      latestFrame: null,
      flushScheduled: false,
      previewEveryNth: 1,
      previewViewport: null,
      previewSharpTimer: null,
      previewSharpLastLogAt: 0,
      previewDropCount: 0,
      paused: false,
      // Browser-style nav history tracked per session. Playwright doesn't
      // expose canGoBack/canGoForward, so we maintain index+stack ourselves.
      history: [initialUrl],
      historyIndex: 0,
      lastBroadcastedUrl: initialUrl,
      onMainFrameNav: null,
    };
    const onMainFrameNav = (frame) => {
      if (frame !== session.page.mainFrame()) return;
      const newUrl = frame.url();
      if (newUrl === session.lastBroadcastedUrl) return;
      const cur = session.history[session.historyIndex];
      if (newUrl === cur) {
        // already in sync (handlers below pre-adjust index)
      } else if (session.historyIndex > 0 && newUrl === session.history[session.historyIndex - 1]) {
        session.historyIndex -= 1;
      } else if (
        session.historyIndex < session.history.length - 1 &&
        newUrl === session.history[session.historyIndex + 1]
      ) {
        session.historyIndex += 1;
      } else {
        session.history = session.history.slice(0, session.historyIndex + 1);
        session.history.push(newUrl);
        session.historyIndex = session.history.length - 1;
      }
      session.lastBroadcastedUrl = newUrl;
      emitNavNotification(streamId, session);
    };
    session.onMainFrameNav = onMainFrameNav;
    page.on("framenavigated", onMainFrameNav);
    state.authorSessions.set(streamId, session);
    emitNavNotification(streamId, session);
    return { ok: true, streamId };
  },

  "author.close": async ({ streamId } = {}) => {
    const s = state.authorSessions.get(streamId);
    if (!s) return { ok: true, closed: false };
    if (s.onMainFrameNav && s.page) {
      try {
        s.page.off("framenavigated", s.onMainFrameNav);
      } catch {}
      s.onMainFrameNav = null;
    }
    state.authorSessions.delete(streamId);
    await teardownAuthorSession(s);
    return { ok: true, closed: true };
  },

  "author.sessionProfile": async ({ streamId } = {}) => {
    const s = getAuthorSession(streamId);
    const [runtime, storageState] = await Promise.all([
      s.page.evaluate(() => ({
        locale: navigator.language || null,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        url: location.href || null,
      })),
      s.context.storageState(),
    ]);
    const locale = typeof runtime.locale === "string" ? runtime.locale : null;
    return {
      environment: {
        locale,
        timezoneId: typeof runtime.timezoneId === "string" ? runtime.timezoneId : null,
        acceptLanguage: null,
      },
      currentUrl: typeof runtime.url === "string" ? runtime.url : null,
      storageStateJson: JSON.stringify(storageState),
    };
  },

  "author.setViewport": async ({ streamId, width, height } = {}) => {
    const s = getAuthorSession(streamId);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw Object.assign(new Error("invalid viewport"), { code: -32602 });
    }
    const nextPreviewViewport = screencastViewportFor({ width, height });
    const currentViewport = s.page.viewportSize();
    if (
      currentViewport?.width === width &&
      currentViewport?.height === height &&
      s.previewViewport?.maxWidth === nextPreviewViewport.maxWidth &&
      s.previewViewport?.maxHeight === nextPreviewViewport.maxHeight
    ) {
      return { ok: true, width, height };
    }
    await s.page.setViewportSize({ width, height });
    s.previewViewport = nextPreviewViewport;
    if (s.cdp && !s.paused) {
      await restartScreencast(s);
      scheduleSharpPreviewFrame(s, s.page, { streamId });
    }
    return { ok: true, width, height };
  },

  "author.goto": async ({ streamId, url } = {}) => {
    const s = getAuthorSession(streamId);
    if (typeof url !== "string" || !url) {
      throw Object.assign(new Error("invalid url"), { code: -32602 });
    }
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("non-http(s) url");
      }
    } catch {
      throw Object.assign(new Error("invalid url"), { code: -32602 });
    }
    await s.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    scheduleSharpPreviewFrame(s, s.page, { streamId });
    return { ok: true, url };
  },

  // Read the current URL of an author-session page. Used by the host to
  // decide whether navigate-replay is needed before a Pick — if the user
  // has already browsed past the script's destination, replay would yank
  // them back to the start URL.
  "author.currentUrl": async ({ streamId } = {}) => {
    if (typeof streamId !== "string" || !streamId) {
      throw Object.assign(new Error("streamId required"), { code: -32000 });
    }
    const s = state.authorSessions.get(streamId);
    if (!s || !s.page) {
      throw Object.assign(new Error(`unknown streamId: ${streamId}`), { code: -32000 });
    }
    return { url: s.page.url() || "" };
  },

  // Phase 11-03 — author.navigateTo: warm an author-session page for the
  // element picker. Unlike author.goto (which uses domcontentloaded),
  // this RPC additionally waits for `networkidle` with a bounded 10s
  // timeout (Pitfall 4 sequencing) so the picker overlay has a quiescent
  // DOM to attach against. Timeout is swallowed — a slow site still
  // proceeds to the pick rather than hanging forever.
  //
  // Rejects unknown streamId with -32000 (same contract as author.goto
  // via getAuthorSession); rejects non-http(s) URLs with -32602.
  "author.navigateTo": async ({ streamId, url } = {}) => {
    if (typeof streamId !== "string" || !streamId) {
      throw Object.assign(new Error("streamId required"), { code: -32000 });
    }
    if (typeof url !== "string" || !url) {
      throw Object.assign(new Error("url required"), { code: -32000 });
    }
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("non-http(s) url");
      }
    } catch {
      throw Object.assign(new Error("invalid url"), { code: -32602 });
    }
    const s = state.authorSessions.get(streamId);
    if (!s || !s.page) {
      throw Object.assign(new Error(`unknown streamId: ${streamId}`), { code: -32000 });
    }
    // Skip the goto + networkidle wait when the page is already at the target
    // URL — picker re-warms during rapid pick-cancel cycles would otherwise
    // pay a 10s networkidle timeout for no navigation work.
    if (s.page.url() === url) {
      return { ok: true, url, alreadyAtUrl: true };
    }
    await s.page.goto(url, { waitUntil: "load" });
    // Pitfall 4 sequencing — proceed even if networkidle doesn't fire;
    // the picker needs a bounded warm-up, not an infinite wait.
    await s.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    return { ok: true, url: s.page.url() };
  },

  // URL-bar back/forward/reload for the editor Live Preview header.
  // History tracking is sidecar-side (Playwright doesn't expose canGoBack/
  // canGoForward); each handler pre-adjusts historyIndex so the
  // framenavigated listener stays in sync.
  "author.goBack": async ({ streamId } = {}) => {
    const s = getAuthorSession(streamId);
    if (!s.history || s.historyIndex <= 0) {
      return { ok: false, reason: "no-history" };
    }
    s.historyIndex -= 1;
    try {
      await s.page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 });
    } catch (e) {
      s.historyIndex += 1;
      throw Object.assign(new Error("goBack failed: " + (e.message || e)), { code: -32000 });
    }
    s.lastBroadcastedUrl = s.history[s.historyIndex];
    emitNavNotification(streamId, s);
    return { ok: true, url: s.page.url() };
  },

  "author.goForward": async ({ streamId } = {}) => {
    const s = getAuthorSession(streamId);
    if (!s.history || s.historyIndex >= s.history.length - 1) {
      return { ok: false, reason: "no-forward" };
    }
    s.historyIndex += 1;
    try {
      await s.page.goForward({ waitUntil: "domcontentloaded", timeout: 10_000 });
    } catch (e) {
      s.historyIndex -= 1;
      throw Object.assign(new Error("goForward failed: " + (e.message || e)), { code: -32000 });
    }
    s.lastBroadcastedUrl = s.history[s.historyIndex];
    emitNavNotification(streamId, s);
    return { ok: true, url: s.page.url() };
  },

  "author.reload": async ({ streamId } = {}) => {
    const s = getAuthorSession(streamId);
    await s.page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    s.lastBroadcastedUrl = s.history[s.historyIndex];
    emitNavNotification(streamId, s);
    return { ok: true, url: s.page.url() };
  },

  // Phase 11-extension — forward renderer-side canvas pointer events to the
  // headless author browser via Playwright's page.mouse API (CDP under the
  // hood). Enables interactive picking without a headful Chromium window:
  // the LivePreview canvas is the input surface, the author browser is the
  // DOM target. Coordinates are in page viewport space (canvas → page
  // conversion happens in the renderer).
  "author.dispatchInput": async ({ streamId, event } = {}) => {
    if (typeof streamId !== "string" || !streamId) {
      throw Object.assign(new Error("streamId required"), { code: -32602 });
    }
    if (!event || typeof event !== "object") {
      throw Object.assign(new Error("event required"), { code: -32602 });
    }
    const s = state.authorSessions.get(streamId);
    if (!s || !s.page) {
      throw Object.assign(new Error(`unknown streamId: ${streamId}`), { code: -32000 });
    }
    // state.pickerPending is the authoritative "overlay is armed" flag;
    // it's set/cleared by pickElement.start / cleanup.
    const pickerArmed = !!state.pickerPending;
    // Pointer/wheel events carry x/y in page-viewport space; keyboard
    // events don't, so the coord parse lives inside the pointer cases.
    const parseXY = () => {
      const x = Number(event.x);
      const y = Number(event.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw Object.assign(new Error("x,y must be finite numbers"), { code: -32602 });
      }
      return [x, y];
    };
    let result;
    switch (event.type) {
      case "mousemove": {
        const [x, y] = parseXY();
        await s.page.mouse.move(x, y);
        result = { ok: true };
        break;
      }
      case "click": {
        const [x, y] = parseXY();
        const button =
          event.button === "right" || event.button === "middle" ? event.button : "left";
        // Click is rare + high-signal: always log so picker captures are
        // diagnosable without an extra RUST_LOG flag.
        process.stderr.write(
          `[sc-sidecar] dispatchInput click streamId=${streamId} x=${x} y=${y} button=${button} pickerArmed=${pickerArmed}\n`,
        );
        try {
          await s.page.mouse.click(x, y, { button });
        } catch (e) {
          process.stderr.write(
            `[sc-sidecar] dispatchInput click FAILED: ${e && e.message ? e.message : e}\n`,
          );
          throw e;
        }
        result = { ok: true };
        break;
      }
      case "wheel": {
        const [x, y] = parseXY();
        const dx = Number(event.deltaX) || 0;
        const dy = Number(event.deltaY) || 0;
        // page.mouse.wheel dispatches a wheel event at the current mouse
        // position, so move first to align with the caller's (x, y).
        await s.page.mouse.move(x, y);
        await s.page.mouse.wheel(dx, dy);
        result = { ok: true };
        break;
      }
      case "keydown": {
        if (pickerArmed) {
          result = { ok: true, skipped: "picker-armed" };
          break;
        }
        // Browser auto-repeat would call page.keyboard.down repeatedly,
        // which Playwright doesn't translate to native autoRepeat. Skipping
        // is acceptable: most pages handle repeat by checking event.repeat
        // themselves, and the tradeoff buys us simpler state-tracking.
        if (event.repeat) {
          result = { ok: true, skipped: "repeat" };
          break;
        }
        const k = toPlaywrightKey(event);
        if (!k) {
          throw Object.assign(new Error("keydown requires key or code"), { code: -32602 });
        }
        await s.page.keyboard.down(k);
        result = { ok: true };
        break;
      }
      case "keyup": {
        if (pickerArmed) {
          result = { ok: true, skipped: "picker-armed" };
          break;
        }
        const k = toPlaywrightKey(event);
        if (!k) {
          throw Object.assign(new Error("keyup requires key or code"), { code: -32602 });
        }
        await s.page.keyboard.up(k);
        result = { ok: true };
        break;
      }
      case "text": {
        if (pickerArmed) {
          result = { ok: true, skipped: "picker-armed" };
          break;
        }
        const text = String(event.text ?? "");
        if (text.length === 0) {
          result = { ok: true, skipped: "empty" };
          break;
        }
        if (text.length > 8192) {
          throw Object.assign(new Error("text too long (>8192)"), { code: -32602 });
        }
        // Privacy: NEVER log the text content — user may be typing
        // a password/secret into the previewed page.
        process.stderr.write(
          `[sc-sidecar] dispatchInput text streamId=${streamId} len=${text.length}\n`,
        );
        await s.page.keyboard.insertText(text);
        result = { ok: true };
        break;
      }
      default:
        throw Object.assign(new Error(`unsupported event type: ${event.type}`), { code: -32602 });
    }
    scheduleSharpPreviewFrame(s, s.page, { streamId });
    return result;
  },

  setActiveAuthorStream: async ({ streamId } = {}) => {
    if (streamId == null) {
      state.activeAuthorStream = null;
      return { ok: true, streamId: null };
    }
    if (typeof streamId !== "string" || streamId.length === 0) {
      throw Object.assign(new Error("streamId must be a non-empty string or null"), {
        code: -32602,
      });
    }
    if (!state.authorSessions.has(streamId)) {
      throw Object.assign(new Error(`unknown streamId: ${streamId}`), { code: -32000 });
    }
    state.activeAuthorStream = streamId;
    return { ok: true, streamId };
  },

  startPreviewStream: async ({ streamId } = {}) => {
    if (typeof streamId === "string" && streamId.length > 0) {
      const s = getAuthorSession(streamId);
      if (s.cdp) return { ok: true, alreadyRunning: true };
      const everyNthFrame = await attachScreencast(s, s.page, {
        streamId,
        scheduleFlush: () => flushAuthorPreviewFrame(streamId),
        isPaused: () => s.paused,
      });
      return { ok: true, everyNthFrame, streamId };
    }
    if (!state.page) {
      throw Object.assign(new Error("page not launched"), { code: -32000 });
    }
    if (state.cdp) return { ok: true, alreadyRunning: true };
    const everyNthFrame = await attachScreencast(state, state.page, {
      scheduleFlush: flushPreviewFrame,
    });
    return { ok: true, everyNthFrame };
  },

  stopPreviewStream: async ({ streamId } = {}) => {
    if (typeof streamId === "string" && streamId.length > 0) {
      const s = state.authorSessions.get(streamId);
      if (!s) return { ok: true };
      const dropped = await detachScreencast(s);
      return { ok: true, dropped };
    }
    const dropped = await detachScreencast(state);
    if (dropped > 0) {
      process.stderr.write(JSON.stringify({ evt: "preview_drop_summary", dropped }) + "\n");
    }
    return { ok: true, dropped };
  },

  // PHASE-9.9 — pause/resume a running screencast without tearing it down.
  // Wraps Page.stopScreencast/Page.startScreencast on the existing CDP
  // session. Idempotent; required by Phase 10 simulator + Phase 11 picker
  // for exclusive-lock concurrency.
  pauseStream: async ({ streamId } = {}) => {
    const s = getAuthorSession(streamId);
    if (!s.cdp) return { ok: true, paused: false };
    if (s.paused) return { ok: true, paused: true };
    clearSharpPreviewTimer(s);
    try {
      await s.cdp.send("Page.stopScreencast", {});
    } catch {}
    s.paused = true;
    return { ok: true, paused: true };
  },

  resumeStream: async ({ streamId } = {}) => {
    const s = getAuthorSession(streamId);
    if (!s.cdp) return { ok: true, paused: false };
    if (!s.paused) return { ok: true, paused: false };
    try {
      await s.cdp.send("Page.startScreencast", buildScreencastOptions(s));
    } catch {}
    s.paused = false;
    scheduleSharpPreviewFrame(s, s.page, { streamId });
    return { ok: true, paused: false };
  },

  // Test-only shim (Plan 05-02 Task 0): let vitest exercise the
  // remote-browser response shape without a real remote CDP endpoint.
  // Safe to ship because it only mutates a non-observable flag — all
  // real capture paths ignore it unless a browser is actually attached.
  __test_set_remote_browser: async ({ enabled }) => {
    state.fakeRemoteBrowser = Boolean(enabled);
    return { ok: true };
  },

  // Test-only debug introspection for backpressure test (gated by env).
  __debugPreviewState: async () => {
    if (process.env.SIDECAR_TEST !== "1") {
      throw Object.assign(new Error("debug verb disabled"), { code: -32601 });
    }
    return {
      hasLatest: !!state.latestFrame,
      flushScheduled: state.flushScheduled,
      cdpAttached: !!state.cdp,
      previewDropCount: state.previewDropCount,
      previewEveryNth: state.previewEveryNth,
    };
  },

  // Test-only: force pause the setImmediate flusher so synthetic
  // screencastFrame events can accumulate drops deterministically.
  __debugPausePreviewFlush: async ({ paused } = {}) => {
    if (process.env.SIDECAR_TEST !== "1") {
      throw Object.assign(new Error("debug verb disabled"), { code: -32601 });
    }
    state.__flushPaused = !!paused;
    return { ok: true, paused: state.__flushPaused };
  },

  // Test-only: synthesize a screencastFrame path through the handler
  // without a real Chromium. Exercises the drop-counter invariant.
  __debugInjectFrame: async () => {
    if (process.env.SIDECAR_TEST !== "1") {
      throw Object.assign(new Error("debug verb disabled"), { code: -32601 });
    }
    if (state.latestFrame !== null) state.previewDropCount++;
    state.latestFrame = {
      data: "AAAA",
      width: 1,
      height: 1,
      timestamp: Date.now() / 1000,
      sessionId: 0,
    };
    if (!state.flushScheduled && !state.__flushPaused) {
      state.flushScheduled = true;
      setImmediate(flushPreviewFrame);
    }
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
  "pickElement.start": async ({ timeoutMs = 60000, streamId } = {}) => {
    // Phase 11-03 (D-16, Pitfall 3): when streamId is supplied, route the
    // picker to the author-session page registered in `state.authorSessions`
    // (Phase 9-04 map). Unknown streamId throws (-32000) — NEVER falls
    // through to `state.page`, which would mix the recording-browser surface
    // with the author-session surface. When streamId is omitted, preserve
    // the legacy recorder-path behavior untouched.
    let page;
    if (typeof streamId === "string" && streamId.length > 0) {
      const s = state.authorSessions.get(streamId);
      if (!s || !s.page) {
        const err = new Error(
          `no author page for streamId=${streamId} — call start_author_preview first`,
        );
        err.code = -32000;
        throw err;
      }
      page = s.page;
    } else {
      if (!state.page) {
        const err = new Error("browser not launched");
        err.code = -32000;
        throw err;
      }
      page = state.page;
    }
    const url = page.url() || "";
    if (/^(chrome|about|view-source):/i.test(url)) {
      return { cancelled: true, reason: "unsupported-url" };
    }
    if (state.pickerPending) {
      const err = new Error("picker already active");
      err.code = -32000;
      throw err;
    }
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
          try {
            page.off("framenavigated", framenavListener);
          } catch {}
          framenavListener = null;
        }
        try {
          await page.evaluate(() => window.__sc_picker?.stop());
        } catch {}
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
        settle({ cancelled: true, reason: "navigation" });
      };
      timer = setTimeout(
        () => settle({ cancelled: true, reason: "timeout" }),
        Math.max(1, Number(timeoutMs) || 60000),
      );

      state.pickerPending = { settle, cleanup };
      page.on("framenavigated", framenavListener);

      // BUG FIX (second-pick hang): Playwright's exposeBinding is one-shot
      // per page+name pair. Previously the binding callback closed over the
      // FIRST pick's `settled`/`settle` locals; every subsequent pick
      // (cached via pickerBoundPages) dispatched into that dead closure,
      // leaving the new pick's promise hanging until timeout. The binding
      // now dispatches through state.pickerPending (set at start, cleared
      // at cleanup) so each pick's settle function is always the current
      // one.
      const exposePromise = state.pickerBoundPages.has(page)
        ? Promise.resolve()
        : page
            .exposeBinding("__sc_picker_emit", async ({ page: boundPage }, payload) => {
              const pending = state.pickerPending;
              if (!pending) return; // no active pick — ignore stragglers
              if (payload && payload.__cancel) {
                await pending.settle({ cancelled: true, reason: "user-cancel" });
                return;
              }
              try {
                const result = await emitDsl(boundPage, payload);
                await pending.settle(result);
              } catch (e) {
                await pending.settle({
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
      //
      // Dispatches via state.pickerPending (same rationale as above) so
      // cached bindings from earlier picks don't silently drop hover
      // payloads on subsequent picks.
      const hoverExposePromise = state.pickerHoverBoundPages.has(page)
        ? Promise.resolve()
        : page
            .exposeBinding("__sc_picker_hover", async ({ page: _p }, payload) => {
              if (!state.pickerPending) return;
              writeNotification("pickElement.hoverPreview", payload || {});
            })
            .then(() => {
              state.pickerHoverBoundPages.add(page);
            })
            .catch(() => {
              state.pickerHoverBoundPages.add(page);
            });

      Promise.all([exposePromise, hoverExposePromise])
        .then(() =>
          page.evaluate(() => {
            const p = window.__sc_picker;
            if (!p) return { started: false, reason: "no-__sc_picker" };
            p.start();
            return { started: true, active: p.isActive() };
          }),
        )
        .then((r) => {
          process.stderr.write(
            `[sc-sidecar] pickElement.start overlay streamId=${streamId || "(recorder)"} url=${page.url()} result=${JSON.stringify(r)}\n`,
          );
        })
        .catch(async (e) => {
          process.stderr.write(
            `[sc-sidecar] pickElement.start overlay FAILED: ${e && e.message ? e.message : e}\n`,
          );
          await settle({
            cancelled: true,
            reason: `start-error: ${e.message || e}`,
          });
        });
    });
  },

  "pickElement.cancel": async () => {
    if (state.pickerPending) {
      const pending = state.pickerPending;
      await pending.settle({ cancelled: true, reason: "user-cancel" });
    }
    return { ok: true };
  },

  "pickElement.isActive": async () => ({ active: !!state.pickerPending }),

  // test-only hooks. The Rust driver never calls these; they
  // exist so vitest can synthesize click + Escape events deterministically
  // (real mouse coordination in headless CI is flaky). Guarded by the
  // `__test_` prefix convention already used by __test_set_remote_browser.
  __test_simulate_pick: async ({ selector, streamId } = {}) => {
    // Phase 11-03 — resolve the page by streamId when supplied so tests
    // can target an author-session page; omitted streamId preserves the
    // pre-11-03 recorder-path behavior (state.page).
    let page;
    if (typeof streamId === "string" && streamId.length > 0) {
      const s = state.authorSessions.get(streamId);
      if (!s || !s.page) {
        const err = new Error(`no author page for streamId=${streamId}`);
        err.code = -32000;
        throw err;
      }
      page = s.page;
    } else {
      if (!state.page) {
        const err = new Error("browser not launched");
        err.code = -32000;
        throw err;
      }
      page = state.page;
    }
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("no element for selector " + sel);
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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
      const err = new Error("browser not launched");
      err.code = -32000;
      throw err;
    }
    await state.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("no element for selector " + sel);
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
    }, selector);
    return { ok: true };
  },

  __test_simulate_pick_cancel: async () => {
    if (!state.page) {
      const err = new Error("browser not launched");
      err.code = -32000;
      throw err;
    }
    await state.page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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

// Apply optional 1-indexed `nth` modifier to a Locator or string selector.
// Strings get wrapped in `page.locator(...)` so we can chain `.nth(n - 1)`
// (DSL is 1-indexed; Playwright's `.nth()` is 0-indexed).
//
// `nth == null/undefined/0` is a no-op — preserves "any unique match"
// semantics for legacy targets that omit the modifier.
function applyNth(locOrStr, nth, pageFn) {
  if (nth == null) return locOrStr;
  const n = Number(nth);
  if (!Number.isFinite(n) || n < 1) return locOrStr;
  const loc = typeof locOrStr === "string" ? pageFn().locator(locOrStr) : locOrStr;
  return loc.nth(n - 1);
}

async function locate(selector, strategy, nth) {
  const page = pickPage();
  const withNth = (loc) => applyNth(loc, nth, pickPage);

  // strict explicit strategies. Routed on `strategy` FIRST so prefix
  // collisions (e.g. "text=" shared with legacy VisibleText) don't
  // mis-dispatch.
  if (strategy === "role") {
    // value shape: "role=<role-kebab>:<name>" — split on FIRST ':' so names may contain ':'
    const body = selector.slice("role=".length);
    const idx = body.indexOf(":");
    if (idx < 0) throw new Error(`invalid role selector encoding: ${selector}`);
    const role = body.slice(0, idx);
    const name = body.slice(idx + 1);
    return withNth(page.getByRole(role, { name, exact: true }));
  }
  if (strategy === "label") {
    return withNth(page.getByLabel(selector.slice("label=".length), { exact: true }));
  }
  if (strategy === "text_exact") {
    // SAME wire prefix as legacy VisibleText, but `text_exact` strategy →
    // exact match, no fallback.
    return withNth(page.getByText(selector.slice("text=".length), { exact: true }));
  }
  // The Rust SmartSelector emits strategy-prefixed values; map them to
  // playwright-locator literals. Anything else is treated as raw CSS.
  if (strategy === "css" || strategy === "testid" || strategy === "aria") {
    return withNth(page.locator(selector));
  }
  if (selector.startsWith("aria-name=")) {
    // accessible-name covers form labels AND interactive text (links,
    // buttons, headings, etc.). getByLabel only handles form labels, so
    // chain it with role-by-name and visible-text for the common cases.
    const name = selector.slice("aria-name=".length);
    return withNth(
      page
        .getByRole("link", { name, exact: true })
        .or(page.getByRole("button", { name, exact: true }))
        .or(page.getByLabel(name))
        .or(page.getByText(name, { exact: true })),
    );
  }
  if (selector.startsWith("text=")) {
    return withNth(page.getByText(selector.slice("text=".length), { exact: true }));
  }
  if (selector.startsWith("label=")) {
    return withNth(page.getByLabel(selector.slice("label=".length)));
  }
  if (selector.startsWith("text~=")) {
    return withNth(page.getByText(selector.slice("text~=".length)));
  }
  return withNth(page.locator(selector));
}

// INVARIANT: targetToLocator() returns `string | Locator`.
// All call sites MUST handle both shapes. Current call sites (as of Phase 7):
//   - waitFor:  string → page.waitForSelector(s); Locator → loc.waitFor({state:'attached'})
//   - assert:   string → page.locator(s).count(); Locator → loc.count()
// New callers: follow the same `typeof loc === 'string'` pattern.
// Three `kind` values return Locators:
//   "role" (value = { role, name }), "label" (value = string), "text_exact" (value = string).
//
// When `target.nth` is set, the result is ALWAYS a Locator (string targets
// get coerced via `page.locator(s).nth(n - 1)` so callers don't need a
// separate nth-handling path).
function targetToLocator(target) {
  if (!target) return "*";
  let result;
  if (target.kind === "selector") {
    result = target.value;
  } else if (target.kind === "testid") {
    result = `[data-testid="${target.value}"]`;
  } else if (target.kind === "aria") {
    result = `[aria-label="${target.value}"]`;
  } else if (target.kind === "role") {
    // value is an object: { role: <kebab>, name: <string> }
    const { role, name } = target.value;
    result = pickPage().getByRole(role, { name, exact: true });
  } else if (target.kind === "label") {
    result = pickPage().getByLabel(target.value, { exact: true });
  } else if (target.kind === "text_exact") {
    result = pickPage().getByText(target.value, { exact: true });
  } else {
    result = `text=${target.value}`;
  }
  return applyNth(result, target.nth, pickPage);
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  const { id, method, params } = req;
  const handler = handlers[method];
  if (!handler) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    return;
  }
  try {
    const result = await handler(params || {});
    write({ jsonrpc: "2.0", id, result });
  } catch (e) {
    write({ jsonrpc: "2.0", id, error: { code: -32000, message: String((e && e.message) || e) } });
  }
});

rl.on("close", async () => {
  if (state.cdp) {
    try {
      await state.cdp.send("Page.stopScreencast", {});
    } catch {}
    try {
      await state.cdp.detach();
    } catch {}
  }
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
  // Phase 09-04 — kill every per-streamId author session on exit.
  for (const [, s] of state.authorSessions) {
    await teardownAuthorSession(s);
  }
  process.exit(0);
});

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// id-absent JSON-RPC notifications for live-hover preview.
// Separate from `write` so notifications share a single serialization path
// with a clear type signature. The Rust reader (playwright_driver.rs)
// dispatches any id-absent + method-present line to the broadcast channel.
function writeNotification(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

// Emit current nav state for an author session as a `preview/nav`
// notification. Called after framenavigated fires and after the
// goBack/goForward/reload handlers complete.
function emitNavNotification(streamId, session) {
  if (!session || !session.history) return;
  writeNotification("preview/nav", {
    streamId,
    url: session.history[session.historyIndex] ?? "",
    canGoBack: session.historyIndex > 0,
    canGoForward: session.historyIndex < session.history.length - 1,
  });
}

// Phase 09-01 — latest-wins preview flusher. Emits one preview/frame
// notification per setImmediate tick and acks the latest sessionId so
// Chromium keeps streaming. Never logs `data` (info-disclosure T-09-01-03).
function flushPreviewFrame() {
  state.flushScheduled = false;
  // Phase 09-03 test hook — paused flusher lets synthetic frames pile up.
  if (state.__flushPaused) return;
  const f = state.latestFrame;
  if (!f) return;
  state.latestFrame = null;
  writeNotification("preview/frame", {
    data: f.data,
    width: f.width,
    height: f.height,
    timestamp: f.timestamp,
  });
  if (state.cdp) {
    state.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  }
}

// Phase 09-04 — per-streamId author-session flusher. Payload carries
// streamId so Rust/webview can multiplex frames across concurrent
// sessions (recording + editor).
function flushAuthorPreviewFrame(streamId) {
  const s = state.authorSessions.get(streamId);
  if (!s) return;
  s.flushScheduled = false;
  if (s.paused) return;
  const f = s.latestFrame;
  if (!f) return;
  s.latestFrame = null;
  writeNotification("preview/frame", {
    streamId,
    data: f.data,
    width: f.width,
    height: f.height,
    timestamp: f.timestamp,
  });
  if (s.cdp) {
    s.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  }
}
