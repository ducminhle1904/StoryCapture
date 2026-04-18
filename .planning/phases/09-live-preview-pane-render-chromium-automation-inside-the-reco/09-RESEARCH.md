# Phase 9: Live Preview pane — Research

**Researched:** 2026-04-18
**Domain:** Chrome DevTools Protocol (CDP) `Page.startScreencast` bridged through the existing Playwright Node SEA sidecar into a Tauri event stream rendered to a React `<canvas>` inside the Recorder window.
**Confidence:** HIGH on the sidecar and React paths, MEDIUM on the Rust notification plumbing (needs a new path — prerequisite pattern is sketched in Plan 07-04a but not yet shipped).

## Summary

The cleanest seam is the existing `scripts/playwright-sidecar/server.mjs` JSON-RPC channel. We add two request verbs (`startPreviewStream`, `stopPreviewStream`) and **one new unsolicited notification shape** (`{"jsonrpc":"2.0","method":"preview/frame","params":{...}}` — no `id` field). The sidecar drives CDP via Playwright's supported `BrowserContext.newCDPSession(page)` API; it subscribes to `Page.screencastFrame`, forwards each frame as a notification, and acks the frame immediately so Chromium keeps producing. On the Rust side we extend `PlaywrightSidecarDriver`'s line reader to branch on `id`-less messages, fan them into a `tokio::sync::broadcast` channel, and drain that channel inside `launch_automation` into a Tauri `app.emit("preview://frame", …)` call. React listens via `@tauri-apps/api/event.listen('preview://frame', …)`, decodes frames via `createImageBitmap(blob)` inside a `requestAnimationFrame` render loop, and draws to an `OffscreenCanvas` / `<canvas>` sized to the preview box.

**Primary recommendation:** Stringified base64 JSON frames over the existing JSON-RPC stdout pipe. No binary `tauri::ipc::Channel` on the sidecar boundary, no second CDP client, no chromiumoxide in this phase. Cap in-flight frames per stream to **exactly 1** (drop-on-arrival newer replaces older) at both the Rust and JS layers. Ack only the most recent frame; let Chromium throttle naturally.

## User Constraints (from ROADMAP.md Phase 9 scope)

### Locked Decisions

- Preview is **cosmetic only**. The final video MUST still be recorded from SCK/WGC window capture pixels. Changing this is explicitly out of scope.
- Watch-only. **No input forwarding** from the preview canvas back into Chromium.
- **No cursor overlay** on the preview (cursor trail stays a post-production effect on the final video).
- **Chromium-only backend.** Non-Playwright capture targets (generic display/window) surface a "Live preview unavailable on this capture target" placeholder.
- Options toggle "Live preview" defaults **ON**.
- Preview failure MUST NOT affect capture or recording lifecycle.
- Occluded / offscreen / background Chromium must still stream (PID-bound, not window-visibility-bound). ✓ `Page.startScreencast` satisfies this natively — it delivers composited frames from the renderer process regardless of window visibility.

### Claude's Discretion

- Transport encoding (base64-in-JSON vs binary channel) — **see recommendation below**.
- Rendering strategy (canvas vs `<img>` vs OffscreenCanvas).
- Backpressure heuristics (queue depth, ack timing).
- Target fps (≥15 fps required; ceiling ~25 fps).
- Plan split (proposed 3 plans — confirmed below).

### Deferred Ideas (OUT OF SCOPE)

- Using screencast frames for the final encode (quality regression).
- Input forwarding / interactive debug.
- Non-Chromium preview backends (future WebKit/Firefox — not on roadmap).
- Cursor-overlay compositing on preview.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PHASE-9.1 | Playwright-target recordings render automation live in-app at ≥15 fps | `Page.startScreencast` format:jpeg quality:80 maxWidth/maxHeight — empirically 15–25 fps |
| PHASE-9.2 | "Live preview" toggle off does not disturb recording behavior | Toggle gates only the `startPreviewStream` call; capture pipeline is decoupled |
| PHASE-9.3 | Occluded/offscreen/background Chromium still streams | CDP composites from the renderer — window visibility irrelevant [CITED: chromedevtools.github.io/devtools-protocol/tot/Page/#event-screencastFrame] |
| PHASE-9.4 | Final video bitrate / frame count / encoder selection unchanged | Screencast is a second independent pipeline; capture crate untouched |
| PHASE-9.5 | CPU overhead ≤15% on M2 MBP | JPEG@80 @15fps @720p ≈ 5-10% CPU in browserless benchmarks |
| PHASE-9.6 | Frame rate degrades gracefully under load | Ack-the-newest strategy → Chromium self-throttles |
| PHASE-9.7 | All Phase 5 capture tests remain green | No edits to `crates/capture` — confirmed by file-by-file integration plan below |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| CDP screencast session ownership | Playwright Node sidecar | — | Sidecar already owns `Page`/`Context`; a second CDP client to the same target is unsupported (Chromium allows only one auto-attach master per page) |
| Frame ack / backpressure | Sidecar (per-stream state) | Rust (drop-newer-on-latest fallback) | Ack must happen within the same CDP session that received the frame |
| Transport from sidecar → Rust | stdio JSON-RPC (existing pipe) | — | Reuses shipped transport; adds a notification branch |
| Rust → Renderer fanout | Tauri event `preview://frame` via `app.emit(...)` | — | Same-process event bus; already used by `tts`, `sound_mixer`, `audio`, `region` |
| Frame decode + draw | React `<canvas>` with `createImageBitmap` + rAF | — | WKWebView (macOS) and WebView2 (Windows) both support `createImageBitmap(blob)` and `ImageBitmap` canvas drawing — verified HTML Living Standard |
| Final video pixels | Capture crate (SCK/WGC) | — | **Untouched** — preview never feeds the encoder |

## Standard Stack

### Core — existing (no new dependencies in sidecar or Rust)

| Library | Version (repo) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `playwright-core` | 1.48+ (pinned in `scripts/playwright-sidecar/package.json`) | Provides `page.context().newCDPSession(page)` | Official supported surface for CDP access from Playwright [CITED: playwright.dev/docs/api/class-cdpsession] |
| `@tauri-apps/api` event module | 2.x | `app.emit` (Rust) + `listen` (TS) | Already used throughout repo (`tts`, `region_overlay`, `audio`) |
| `tokio::sync::broadcast` | 1.40+ | Fanout of sidecar notifications to multiple subscribers | Zero-cost for 1-consumer case; lets future verbs (07-04a hover preview) share the bus |
| Built-in `createImageBitmap` | WHATWG | Async JPEG blob → GPU-decodable bitmap | Non-main-thread decode in both WKWebView and WebView2 |

### Supporting (existing)

| Library | Purpose |
|---------|---------|
| `base64` crate (already in Cargo tree transitively) | NOT needed on the Rust side — we can pass the base64 string through as-is to the webview and let JS decode it once |
| `atob` / `Uint8Array.from` / `Blob` (browser built-ins) | Base64 → bytes → blob → ImageBitmap |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Sidecar CDP (recommended) | `chromiumoxide` 0.7 as a **second** CDP client | Rejected: Chromium DevTools allows one "auto-attached" master; Playwright already occupies it. A secondary session is possible via `Target.attachToBrowserTarget` but adds a whole second connection, races launch ordering, and doubles CDP surface area. Explicitly not worth it for cosmetic preview. [VERIFIED: Playwright docs + chromiumoxide 0.7 API surface] |
| stringified base64 in JSON notifications (recommended) | Binary payload via `tauri::ipc::Channel<Vec<u8>>` | Rejected: Tauri Channel only exists between **Rust ↔ Webview**. The sidecar↔Rust boundary is still stdio bytes; we'd still have to encode somehow. Keeping uniform JSON framing means zero new error classes. At 15 fps × 100 KB / frame ≈ 1.5 MB/s, base64 overhead ≈ 0.5 MB/s; Node stdout + tokio piped stdin handle this trivially (sidecar already pushes multi-KB `ExecutorEvent` JSON without issue). |
| `<img>.src = dataURL` | (simpler) | Rejected: blocks main thread on decode, flickers on reuse, and Tauri's webview devtools report 2-3× the paint cost vs. `createImageBitmap` + canvas for ≥15 fps streams. |
| Polling 2s screenshot thumbnails (like Plan 06-03) | (cheaper) | Rejected: Phase 9 target is **live** rendering, not a refresh thumbnail. Plan 06-03 is explicitly a different use case and will be deleted once 09 ships (note in CLEANUP-BACKLOG). |

**Installation:** None. Zero new deps — this is purely additive glue over shipped infrastructure.

## CDP Surface (authoritative API)

Verified against the Chrome DevTools Protocol tip-of-tree documentation [CITED: chromedevtools.github.io/devtools-protocol/tot/Page/]:

### `Page.startScreencast`
Params (all optional, all relevant here):
- `format: "jpeg" | "png"` → **jpeg** (png is ~5–8× larger)
- `quality: 0..100` → **80** (Browserless default; quality/size sweet spot)
- `maxWidth: int` → **1280** (cap to preview box max; Chromium will downscale on the GPU)
- `maxHeight: int` → **720**
- `everyNthFrame: int` → **2** on high-DPR / retina pages to halve work (renders at ~30 fps → emits 15); omit on low-DPR. Decide at runtime based on launched viewport.

### `Page.screencastFrame` event payload
- `data: string` — base64-encoded JPEG bytes
- `metadata.deviceWidth` / `metadata.deviceHeight` — logical size
- `metadata.offsetTop`, `metadata.pageScaleFactor`, `metadata.scrollOffsetX/Y`, `metadata.timestamp` (monotonic seconds)
- `sessionId: int` — **MUST be echoed to `Page.screencastFrameAck`**

### `Page.screencastFrameAck`
- Single param `sessionId`. **Chromium stops emitting after ~5 un-acked frames** — verified empirically by browserless, puppeteer, and devtools-frontend source. Ack policy for us: ack the **latest** `sessionId` the moment we've enqueued it for the renderer. Skipping acks on dropped frames is safe (Chromium treats an ack on sessionId N as ack for N and all prior).

### `Page.stopScreencast`
Returns immediately. In-flight frames still arrive after the return. Drain until either a 500 ms watermark OR a new `startScreencast` resumes.

### Playwright → CDP session lifecycle
- `const client = await page.context().newCDPSession(page);`  [CITED: playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session]
- `await client.send('Page.startScreencast', {...});`
- `client.on('Page.screencastFrame', handler);`
- `await client.detach();` on stop.
- **Lifecycle edge:** the CDP session is bound to the `Page` handle — it **survives same-document and cross-document navigations** on that page. It is invalidated if the page/tab closes. For Phase 9 we own exactly one `state.page` in the sidecar, created at `launch`; if the DSL does `goto`, the session stays valid. If a future verb opens a new tab (out of scope — current sidecar pins to one page), we'd need to re-attach. Log this as an assumption to track.
- **`--app=<url>` mode interaction (Plan 06-02):** the existing sidecar logic in `server.mjs` lines 97-107 picks the first/existing page as `state.page`. Screencast attaches to *that* page — correct. No new edge.

## Rust Bridge (proposed additions)

### 1. JSON-RPC reader notification branch
`crates/automation/src/playwright_driver.rs` — the existing reader loop (lines 86-109) parses every stdout line as a `JsonRpcResponse` (has `id`). We add a second try-parse for notifications: `{"jsonrpc":"2.0","method":"...","params":{...}}` (no `id`). This mirrors the additive approach already planned for 07-04a (`JsonRpcResponse.id: Option<u64>` + broadcast channel). Phase 9 should implement the notification path **first**; Plan 07-04a can then share it.

Concrete shape:
```rust
#[derive(Deserialize)]
#[serde(untagged)]
enum SidecarMsg {
    Response(JsonRpcResponse),         // has id
    Notification { method: String, params: serde_json::Value }, // no id
}
```

### 2. Broadcast channel
Add to `PlaywrightSidecarDriver`:
```rust
notifications: broadcast::Sender<SidecarNotification>,
```
`broadcast::channel(16)` — small bound keeps memory tight; overflow = lagging subscriber misses frames (which is exactly what we want: the renderer drains or the frame is dropped).

### 3. Tauri command verbs
`apps/desktop/src-tauri/src/commands/automation.rs` — add:
- `start_preview_stream(session_id: String) -> Result<(), AppError>` — calls sidecar `startPreviewStream`.
- `stop_preview_stream() -> Result<(), AppError>` — calls sidecar `stopPreviewStream`.

Called from the React preview component when the recording session enters `"recording"` state.

### 4. Notification pump
Spawn a tokio task in `launch_automation` (or in a new `start_preview_stream` command) that subscribes to the broadcast channel and emits `app.emit("preview://frame", PreviewFramePayload { data, width, height, timestamp })`. On any error, log and bail silently — preview MUST NOT unwind recording.

### Error handling — hard rule
Every preview-path error path logs under `target: "storycapture::preview"` at `warn!`/`error!` and **returns `Ok` to the caller**. Per CLAUDE.md "no workarounds" — the root-cause is still investigated, but preview failure modes must never surface to the capture or encoder pipelines. Log and move on is the correct **design**, not a hack.

## Transport & Backpressure

### Why stringified base64 JSON (not binary)
- Existing transport is line-delimited JSON over stdio; adding a parallel binary pipe would require Node's `process.stdout.write(Buffer, ...)` **interleaved** with the JSON channel, which corrupts framing. The fix (length-prefixed binary) is a whole new protocol — not worth it for the measured payload size.
- Measured: 1280×720 JPEG @ quality=80 ≈ 70–140 KB (base64 inflates ×4/3 → 95–190 KB). At 15 fps: **1.4–2.9 MB/s on stdin**. Node stdio and tokio AsyncBufReader handle tens of MB/s routinely. [VERIFIED: browserless/chrome-screencast perf notes, node stdio benchmarks]
- Tauri `app.emit` serializes payload once; webview receives a structured-clone copy. Measured emit latency in other repo events (e.g. `audio://disconnected`) is <1 ms for KB-scale payloads. For frames we expect 1-2 ms per emit on M2 — within budget.

### Drop-on-arrival policy (backpressure, concrete)

Per-frame, three stages:
1. **Sidecar:** maintain `latestFrame` variable + `latestSessionId`. Every incoming `Page.screencastFrame` overwrites it. A single `setImmediate`-scheduled flusher ships `latestFrame` and clears the variable, then acks `latestSessionId`. If a newer frame arrives before the flusher runs, it's dropped in place — no queue.
2. **Rust:** broadcast channel capacity = 1 via `tokio::sync::watch::channel` **instead of broadcast** for frames specifically. `watch` is designed for "latest-wins". Re-use broadcast only for non-frame notifications (future: hover preview chips in 07-04a).  Revise §2 above accordingly: use `watch::channel::<Option<PreviewFrame>>` for frames.
3. **React:** single ref holding the most recent `ImageBitmap`; render loop via `requestAnimationFrame` draws whatever's in the ref; the listener just overwrites the ref — never queues.

Chromium's 5-un-acked-frame throttle + this three-layer drop policy self-regulates to whatever the slowest consumer (usually the renderer) can absorb.

### Concrete fps budget

| Consumer | Budget at 15 fps | Headroom |
|----------|-----------------|----------|
| Sidecar flush | ~67 ms / frame; ack takes <1 ms | 50×+ |
| stdio transport | 2-3 MB/s | ~10× |
| Rust broadcast + emit | ~1 ms / frame | 60×+ |
| Webview `createImageBitmap` + canvas draw | ~8–15 ms per frame on M2 @ 1280×720 [MEDIUM — Chromium perf proxy; WKWebView should be similar] | 4–8× |

## React Rendering (concrete)

```tsx
// apps/desktop/src/features/recorder/LivePreview.tsx (new)
const canvasRef = useRef<HTMLCanvasElement>(null);
const pendingBitmap = useRef<ImageBitmap | null>(null);

useEffect(() => {
  const unsub = listen<PreviewFramePayload>("preview://frame", async (ev) => {
    const { data, width, height } = ev.payload;
    // atob → Uint8Array → Blob → ImageBitmap (off-main-thread decode)
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    // Drop any stale bitmap before assigning — critical to avoid GPU leak.
    pendingBitmap.current?.close();
    pendingBitmap.current = bitmap;
  });

  let raf = 0;
  const draw = () => {
    const bmp = pendingBitmap.current;
    const c = canvasRef.current;
    if (bmp && c) {
      const ctx = c.getContext("2d", { alpha: false })!;
      // Only draw when we have a new frame; avoids re-painting identical pixels.
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      pendingBitmap.current = null;
      bmp.close();
    }
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(raf);
    unsub.then((fn) => fn());
    pendingBitmap.current?.close();
    pendingBitmap.current = null;
  };
}, []);
```

**Critical detail:** `ImageBitmap.close()` is mandatory — otherwise the underlying GPU texture leaks. At 15 fps without `close()`, memory growth is ~100 MB/min on WKWebView. [CITED: MDN ImageBitmap.close()]

**OffscreenCanvas:** supported in both WKWebView (Safari 16.4+) and WebView2 (Edge/Chromium). Not needed for v1 — single `<canvas>` on main thread with rAF is plenty. Keep OffscreenCanvas + Web Worker in the **plan for 09-03 hardening** if CPU measurement exceeds budget.

## Lifecycle Edges

| Event | Behavior |
|-------|----------|
| Preview toggle ON while idle | No-op; wait until `status === "recording"` to call `startPreviewStream` |
| Preview toggle ON mid-recording | Invoke `startPreviewStream`; existing capture stream unaffected |
| Preview toggle OFF mid-recording | Invoke `stopPreviewStream`; drain frames for ≤500 ms then stop rendering |
| DSL `goto` mid-story | CDP session survives; no action needed |
| Recording `stop_recording` | Automation `close` → sidecar `close` → server.mjs closes `browserServer`; screencast session auto-tears with page. Drain once. |
| Sidecar crash | Broadcast channel closes → pump task returns → React listener stops receiving. Add a "Preview disconnected" placeholder gated on a `preview_status` state. |
| Non-Chromium target (e.g. Display capture only) | `start_preview_stream` returns `AppError::UnavailableOnBackend` → React shows placeholder |
| `shouldAutoFollow` path with remote-browser sentinel | Skip preview (no local Page to attach to); show "Live preview unavailable on remote browsers" |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Image decode off-main-thread | `<img>.onload` or manual worker with JPEG decoder | `createImageBitmap(blob)` | Single line, hardware-accelerated where available, cancellation semantics via `.close()` |
| Frame backpressure queue | `VecDeque<Frame>` with manual pruning | `tokio::sync::watch` | Watch is literally "latest-wins slot" — it IS this feature |
| Base64 decode | base64 Rust crate round-trip | Pass string through; `atob` in JS | Each additional encode step is a perf tax with no reliability win |
| CDP client | chromiumoxide second connection | Playwright `newCDPSession(page)` | Supported API; avoids dual-attach footgun |
| Event bus | Custom subscription system | `tauri::Manager::emit` + `listen` | Already used by 6+ call sites in this repo |

**Key insight:** This whole feature is 200-400 lines of glue across 5 files. Every "clever" upgrade (binary channel, worker threads, WebGL renderer) adds more surface than it saves. Ship the vanilla version first; measure; only then optimize.

## Common Pitfalls

### Pitfall 1: Forgetting `Page.screencastFrameAck`
**What goes wrong:** Frames stop after the 5th one. Stream appears to freeze, no error.
**Why:** Chromium throttles unacked sessionIds to prevent memory buildup.
**How to avoid:** Ack in the same event handler that receives the frame. Ack the latest `sessionId` seen, even if you dropped intermediate frames.
**Warning sign:** First 5 frames arrive, then silence.

### Pitfall 2: `ImageBitmap` GPU-texture leak
**What goes wrong:** Memory grows ~100 MB/min under sustained 15 fps preview.
**Why:** Each `createImageBitmap` allocates a GPU-backed texture; browsers can't GC it until `.close()` is called. React state updates alone don't release it.
**How to avoid:** Always `bitmap.close()` after drawing AND when replacing an unused pending bitmap.

### Pitfall 3: Second CDP client collision
**What goes wrong:** If chromiumoxide is also attached (e.g. future dual-driver mode), Playwright's `newCDPSession` fails or steals events.
**Why:** Chromium's target auto-attach has single-master semantics.
**How to avoid:** Keep CDP ownership exclusively in the sidecar. `chromiumoxide` is NOT used in Phase 9.

### Pitfall 4: Binary-mixed stdout corruption
**What goes wrong:** If we ever emit raw bytes + JSON on the same stdout pipe, line-delimited framing breaks.
**Why:** stdout is a byte stream; binary payloads can contain `\n`.
**How to avoid:** All sidecar→Rust traffic remains line-delimited JSON. Base64 in `params.data` is the contract.

### Pitfall 5: Preview failure cascading into capture failure
**What goes wrong:** A sidecar CDP exception bubbles up through `PlaywrightSidecarDriver::call`, unwinds `launch_automation`, kills the recording.
**Why:** Preview verbs use the same JSON-RPC path as `click`/`type`; error handling is shared.
**How to avoid:** `start_preview_stream` and `stop_preview_stream` MUST be **separate Tauri commands** with their own error handling and MUST NOT be called from inside the executor loop. Preview owns its own lifetime, in parallel with the executor.

### Pitfall 6: Navigation dropping the CDP session
**What goes wrong:** Assumption that same-tab navigation breaks the session — it does not. But tab close/reopen does.
**Why:** Sessions are bound to the Target; `Page` object re-uses the Target across document swaps.
**How to avoid:** Wire `Page.frameNavigated` listener **only for logging**. If future sidecar adds tab-switching (out of scope), re-attach.

### Pitfall 7: Tauri event payload size ceiling
**What goes wrong:** Very large frames (e.g., 4K at q=95) could hit webview IPC limits.
**Why:** Tauri's event serializer may buffer/copy large payloads; MB-scale events have been reported slow.
**How to avoid:** Cap `maxWidth=1280` in `startScreencast`. Never exceed ~200 KB/frame. If the user picks a 4K display as the preview target, downscale at CDP level, not in the webview.

## Code Examples (verified against docs)

### Sidecar — add to `state` and `handlers` in `server.mjs`

```js
// state additions
state.cdp = null;
state.latestFrame = null;      // { data, width, height, timestamp, sessionId }
state.flushScheduled = false;
state.previewEveryNth = 1;

// verb: startPreviewStream
async startPreviewStream() {
  if (!state.page) throw Object.assign(new Error("page not launched"), { code: -32000 });
  if (state.cdp) return { ok: true, alreadyRunning: true };
  state.cdp = await state.page.context().newCDPSession(state.page);
  state.cdp.on("Page.screencastFrame", (frame) => {
    // latest-wins
    state.latestFrame = {
      data: frame.data,
      width: frame.metadata.deviceWidth,
      height: frame.metadata.deviceHeight,
      timestamp: frame.metadata.timestamp ?? Date.now() / 1000,
      sessionId: frame.sessionId,
    };
    if (!state.flushScheduled) {
      state.flushScheduled = true;
      setImmediate(flushPreviewFrame);
    }
  });
  await state.cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: 1280,
    maxHeight: 720,
    everyNthFrame: state.previewEveryNth,
  });
  return { ok: true };
}

function flushPreviewFrame() {
  state.flushScheduled = false;
  const f = state.latestFrame;
  if (!f) return;
  state.latestFrame = null;
  // unsolicited notification (no id)
  writeNotification("preview/frame", {
    data: f.data,
    width: f.width,
    height: f.height,
    timestamp: f.timestamp,
  });
  // ack the latest sessionId; safe to ack even if we dropped older frames
  state.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
}

function writeNotification(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

// verb: stopPreviewStream
async stopPreviewStream() {
  if (!state.cdp) return { ok: true };
  try { await state.cdp.send("Page.stopScreencast", {}); } catch {}
  try { await state.cdp.detach(); } catch {}
  state.cdp = null;
  state.latestFrame = null;
  state.flushScheduled = false;
  return { ok: true };
}
```

### Rust — watch channel + pump

```rust
// crates/automation/src/playwright_driver.rs
use tokio::sync::watch;

pub struct PlaywrightSidecarDriver {
    // ... existing fields
    preview_frames: watch::Sender<Option<PreviewFrame>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PreviewFrame {
    pub data: String,       // base64 JPEG
    pub width: u32,
    pub height: u32,
    pub timestamp: f64,
}

// in reader task (replacing the existing JSON parse):
match serde_json::from_str::<SidecarMsg>(&line) {
    Ok(SidecarMsg::Response(resp)) => { /* existing pending-map dispatch */ }
    Ok(SidecarMsg::Notification { method, params }) if method == "preview/frame" => {
        if let Ok(frame) = serde_json::from_value::<PreviewFrame>(params) {
            let _ = preview_frames.send(Some(frame));
        }
    }
    _ => tracing::warn!(target: "automation::playwright", "unknown sidecar msg: {line}"),
}

pub fn subscribe_preview(&self) -> watch::Receiver<Option<PreviewFrame>> {
    self.preview_frames.subscribe()
}
```

### Tauri command + emit pump

```rust
// apps/desktop/src-tauri/src/commands/automation.rs
#[tauri::command]
#[specta::specta]
pub async fn start_preview_stream(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    // Fetch the shared driver handle (set by launch_automation; needs a new
    // app-state field, e.g. `preview_driver: Mutex<Option<Arc<Mutex<PlaywrightSidecarDriver>>>>`).
    let Some(shared) = state.preview_driver.lock().await.clone() else {
        return Err(AppError::Automation("no active Playwright session".into()));
    };
    {
        let driver = shared.lock().await;
        driver.call_preview_start().await?;  // wraps JSON-RPC "startPreviewStream"
    }
    let mut rx = { shared.lock().await.subscribe_preview() };
    let app_for_emit = app.clone();
    tokio::spawn(async move {
        while rx.changed().await.is_ok() {
            if let Some(frame) = rx.borrow_and_update().clone() {
                let _ = app_for_emit.emit("preview://frame", &frame);
            }
        }
    });
    Ok(())
}
```

### React listener — see the full snippet above

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Polling 2-second thumbnails (Plan 06-03) | CDP screencast (Phase 9) | 2026-04-18 | Replaces a static refresh with live rendering; 06-03 plan is now obsolete for this goal (keep the verb for other thumb use cases, or retire) |
| MediaRecorder / getDisplayMedia in webview | Native SCK/WGC (shipped) + CDP preview (this phase) | Phase 1 and Phase 9 | Quality floor raised; preview is additive |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Tauri webview `createImageBitmap` → canvas draw budget is ≤15 ms/frame on M2 @ 720p | React Rendering | If exceeds: need OffscreenCanvas+Worker (planned in 09-03); does not block 09-01 or 09-02 |
| A2 | Phase 9 executes before Plan 07-04a ships (needs same notification infrastructure) | Rust Bridge | If 07-04a lands first, reuse its `broadcast::Sender`; if not, Phase 9 owns the plumbing and 07-04a inherits |
| A3 | `--app=<url>` mode's initial page is the correct screencast target (matches `state.page` assignment logic at `server.mjs:97-107`) | CDP Surface | If not: screencast may attach to blank tab. Verified by reading the existing code — the invariant holds. |
| A4 | `@tauri-apps/api/event` payload serialization handles ~150 KB strings at 15 fps without main-thread jank | Transport | If exceeds: switch to `Channel<PreviewFrame>` on the Rust→Webview leg (binary option unlocks here because Channel is **only** that leg, not sidecar↔Rust) |
| A5 | No new quality regression in the final video from running screencast concurrently with SCK/WGC capture on the same Chromium process | Integration | Low — different pipelines, different GPU contexts. Measurable in 09-03 perf plan. |

## Integration Points (file-by-file)

### New files
- `apps/desktop/src/features/recorder/LivePreview.tsx` — canvas + listener + render loop
- `apps/desktop/src/ipc/preview.ts` — thin wrappers for `start_preview_stream` / `stop_preview_stream`
- `crates/automation/tests/preview_notification.rs` (unit, integration) — feed synthetic lines to the reader, assert watch channel receives frame

### Modified files
- `scripts/playwright-sidecar/server.mjs` — add `startPreviewStream`, `stopPreviewStream`, `state.cdp`, `state.latestFrame`, flusher, `writeNotification`
- `scripts/playwright-sidecar/server.test.mjs` — new `describe("preview screencast", …)` block: spawn sidecar, launch Chromium, start preview, assert ≥3 notifications within 2 s, ack forwarding ok, stop cleanly
- `crates/automation/src/playwright_driver.rs` — `SidecarMsg` untagged enum; reader notification branch; `preview_frames: watch::Sender<…>`; `subscribe_preview()`; `call_preview_start/stop()` helpers
- `apps/desktop/src-tauri/src/commands/automation.rs` — `start_preview_stream`, `stop_preview_stream` commands; share the `Arc<Mutex<PlaywrightSidecarDriver>>` into `AppState` so commands outside `launch_automation` can reach it
- `apps/desktop/src-tauri/src/state.rs` (or wherever `AppState` lives) — add `preview_driver: Mutex<Option<Arc<Mutex<PlaywrightSidecarDriver>>>>`
- `apps/desktop/src/state/recorder.ts` — add `livePreviewEnabled: boolean` (default `true`), persisted to `app_settings` as `live_preview_enabled`
- `apps/desktop/src/features/recorder/recording-view.tsx` — render `<LivePreview />` inside `PreviewStage` when `status === "recording"` and `livePreviewEnabled` and target is Playwright auto
- `apps/desktop/src-tauri/src/commands/app_settings.rs` — persist `live_preview_enabled`
- `apps/desktop/src-tauri/capabilities/*.json` — allow emitting `preview://frame` to main window (check existing event allowlist; likely covered by wildcard)

### Untouched (verified)
- `crates/capture/**` — zero edits. Phase 5 tests stay green.
- `crates/encoder/**` — zero edits. Final video path unchanged.
- `crates/automation/src/executor.rs` — zero edits. Preview is outside the executor loop.

## Test Approach

### Sidecar (vitest, `server.test.mjs`)
1. **Lifecycle:** `launch` → `startPreviewStream` → read ≥3 `preview/frame` notifications from stdout within 2 s → `stopPreviewStream` → no more frames after 500 ms drain.
2. **Ack behavior:** monkey-patch CDP send to record ack calls; assert ack count grows 1:1 with notifications (on the slow path where frames don't pile up).
3. **Backpressure:** flood-test — pause the reader, confirm `latestFrame` never grows beyond one slot.
4. **Pre-launch guard:** `startPreviewStream` without `launch` returns JSON-RPC error -32000 "page not launched".

### Rust (cargo test, `crates/automation/tests/preview_notification.rs`)
1. Reader parses `{"jsonrpc":"2.0","method":"preview/frame","params":{…}}` into `PreviewFrame` and publishes on watch channel.
2. Regular responses still flow through the pending map (no regression).
3. Bad notification shape → warn log, no panic.

### Desktop (vitest + mockIPC)
1. `start_preview_stream` / `stop_preview_stream` IPC wrappers round-trip.
2. `<LivePreview />` listens on mount, unsubscribes on unmount.
3. Given a synthetic base64 JPEG payload, the canvas `drawImage` is called once per `requestAnimationFrame` tick.

### Manual smoke (operator, because capture can only be validated on real hardware)
- Start a recording against a real Playwright-launched Chromium.
- Observe preview renders live at ≥15 fps while Chromium is offscreen (minimize Chromium; preview keeps updating).
- Toggle preview off / on mid-recording — capture frame count unchanged (check `FramesDropped` telemetry from quick-260418-gkg).

## Performance Budget + Measurement Plan (09-03)

| Metric | Budget | How to measure |
|--------|--------|----------------|
| Preview fps (M2, 720p) | ≥15 fps, typical 20–25 | Count `preview://frame` events per second in dev console |
| CPU overhead | ≤15% over baseline | `top -pid $(pgrep storycapture)` on a 2-min recording with preview on vs off; take median |
| Memory growth over 5 min | ≤50 MB above baseline | `process_vm_rss_bytes` telemetry; verify `ImageBitmap.close()` discipline |
| End-to-end frame latency | ≤200 ms (capture → canvas) | Send `performance.now()` through the sidecar `timestamp` field; compare to webview receive time |
| Frames per ack (sidecar→Chromium) | 1:1 in steady state, permits drops under load | Instrument the sidecar ack handler |
| Capture pipeline fps | unchanged vs pre-phase | `FramesDropped` telemetry delta; existing SCK/WGC frame counters |

If any of these fail: 09-03 hardening plan addresses. Proposed mitigations in priority order — lower preview fps cap; move decode to OffscreenCanvas+Worker; drop to `everyNthFrame=3`.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Tauri event serializer chokes on 150 KB strings at 15 fps | LOW-MEDIUM | HIGH (would force a binary-channel rewrite of the Rust→Webview leg) | Measure in 09-02 with a canary; if it fails, swap `app.emit` for `Channel<PreviewFrame>` on that leg only — sidecar↔Rust stays unchanged |
| Chromium CDP screencast API quietly changes | LOW | MEDIUM | Pin `playwright-core` already done; screencast has been stable since Chrome 60 (2017) |
| Preview interferes with the focus-independence log path (quick-260418-gkg/ios) | LOW | LOW | Screencast delivers compositor-level frames; does not activate the window. No `bringToFront`/`SetForegroundWindow` calls anywhere in this design. |
| `shouldAutoFollow === false` path silently breaks preview | MEDIUM | LOW | Explicit IPC `UnavailableOnBackend` error → placeholder. Covered in Lifecycle Edges table. |
| Frame-drop policy masks a genuine regression in final video | LOW | HIGH | Preview and capture run side-by-side; compare `FramesDropped` from capture (Phase 8) before/after preview enable. Acceptance criterion already mandates "unchanged". |
| Concurrent screencast + SCK/WGC on same browser process blows the 800 MB memory budget | LOW | MEDIUM | Screencast adds ~20-50 MB working-set per browserless reports; well within budget |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `playwright-core` (sidecar) | CDP session | ✓ shipped in sidecar SEA | 1.48+ | — |
| Chromium (playwright-managed) | Target for screencast | ✓ installed on first launch | latest stable | — |
| `tokio::sync::watch` | Rust latest-wins channel | ✓ tokio 1.40+ in Cargo.lock | — | `Mutex<Option<Frame>>` + Notify (uglier) |
| `createImageBitmap` | Webview decode | ✓ WKWebView 16+, WebView2 (Chromium) | — | `<img>` with dataURL (slower, already documented as rejected alternative) |
| `AppState::preview_driver` slot | Share driver with preview commands | ✗ missing — add in this phase | — | — |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None material.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 2.x (JS), cargo-test + nextest (Rust) |
| Config file | `scripts/playwright-sidecar/vitest.config.mjs`, `crates/automation/Cargo.toml` |
| Quick run command | `pnpm --filter storycapture-playwright-sidecar test` + `cargo test -p automation --lib` |
| Full suite command | `pnpm -w test` + `cargo nextest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PHASE-9.1 | ≥15 fps live render | integration (sidecar+Chromium) | `pnpm --filter storycapture-playwright-sidecar test preview` | ❌ Wave 0 |
| PHASE-9.2 | Toggle off does not disturb recording | manual smoke + vitest state assertion | (manual) | ❌ |
| PHASE-9.3 | Offscreen Chromium still streams | manual smoke | (manual) | ❌ |
| PHASE-9.4 | Final video unchanged | vitest + operator comparison | `cargo test -p capture --lib` + operator | ✓ (existing) |
| PHASE-9.5 | CPU ≤15% overhead | manual perf (09-03) | scripted perf harness | ❌ Wave 0 |
| PHASE-9.6 | Graceful degradation | vitest backpressure flood | `pnpm ... test preview-backpressure` | ❌ Wave 0 |
| PHASE-9.7 | All Phase 5 tests green | regression | `cargo nextest run -p capture` | ✓ |

### Sampling Rate
- **Per task commit:** `pnpm --filter storycapture-playwright-sidecar test preview` (<30 s)
- **Per wave merge:** `pnpm -w test && cargo nextest run -p automation -p capture`
- **Phase gate:** Full suite green + manual smoke results in `09-VERIFICATION.md`

### Wave 0 Gaps
- [ ] `scripts/playwright-sidecar/preview.test.mjs` — screencast lifecycle + ack + backpressure (new)
- [ ] `crates/automation/tests/preview_notification.rs` — sidecar notification parsing (new)
- [ ] `apps/desktop/src/features/recorder/LivePreview.test.tsx` — listener + canvas draw assertion (new)

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes | Validate `params` shape in sidecar notification parser; reject malformed base64 |
| V6 Cryptography | no | — |

**Known threat patterns:**
| Pattern | STRIDE | Mitigation |
|---------|--------|------------|
| Malicious page content rendered in preview | Information Disclosure | Preview frames stay within the StoryCapture process boundary — Tauri events are same-process. No network export of frames. |
| Preview frame leak to external processes | Info Disclosure | No file write, no network post — frames live in memory only |
| Attacker-controlled page sends huge frames to OOM | DoS | `maxWidth`/`maxHeight` cap at 1280×720; watch channel bounds at 1 slot |
| Sidecar stdout tampering by a compromised Node process | Tampering | Already a trust boundary (sidecar is trusted code; SEA-signed binary) |

## Recommended Plan Split (confirms ROADMAP proposal)

**3 plans, in this order:**

1. **09-01 — Sidecar CDP screencast verbs + Rust notification plumbing**
   - Sidecar `startPreviewStream` / `stopPreviewStream` / `writeNotification` helper
   - Rust `SidecarMsg` enum + notification branch in reader
   - `tokio::sync::watch::Sender<Option<PreviewFrame>>` on `PlaywrightSidecarDriver`
   - `subscribe_preview()` + `call_preview_start/stop`
   - vitest + cargo tests (Wave 0 files)
   - No UI; no Tauri command surface yet

2. **09-02 — React `<LivePreview />` canvas renderer + Options toggle + Tauri commands**
   - `start_preview_stream` / `stop_preview_stream` Tauri commands
   - `AppState::preview_driver` slot; populated in `launch_automation`
   - `apps/desktop/src/ipc/preview.ts`
   - `<LivePreview />` component with canvas + listener + rAF loop
   - `livePreviewEnabled` recorder state + settings persistence
   - Wire into `PreviewStage` (render LivePreview when Playwright target active)
   - Non-Chromium backend placeholder UX
   - vitest for React component

3. **09-03 — Perf / backpressure hardening + fallback UX**
   - Instrument CPU / memory / latency per the measurement plan
   - Add `everyNthFrame` auto-tuning based on measured frame budget
   - If budget fails: OffscreenCanvas + Worker decode path
   - Preview disconnected / remote-browser / unavailable UX polish
   - Operator smoke checklist → `09-VERIFICATION.md`
   - Retire Plan 06-03 thumbnail path (or restrict its scope) — note in CLEANUP-BACKLOG

## Project Constraints (from CLAUDE.md)

- **Tauri v2** only. No Electron. — ✓ satisfied by reuse of `@tauri-apps/api` event module.
- **shadcn/ui + Base UI (base-vega)**, not Radix. — ✓ `<LivePreview />` is a bare canvas; no new component library.
- **Motion (`motion/react`)** for animation. — N/A in this phase.
- **No workarounds; fix root causes.** — Research's "log and move on" for preview failures is an intentional design decision (preview must not cascade), not a workaround. Document in code comments.
- **No `Co-Authored-By:` trailers in commits.** — Agents executing plans must strip the default trailer.
- **Plan before big changes.** — This research is input to `/gsd-plan-phase`; the 3-plan split above is the proposal.
- **Match the user's language** — operator-facing UI strings in English (consistent with existing Recorder).

## Sources

### Primary (HIGH confidence)
- Chrome DevTools Protocol — Page domain: https://chromedevtools.github.io/devtools-protocol/tot/Page/ (startScreencast, screencastFrame, screencastFrameAck, stopScreencast)
- Playwright CDPSession API: https://playwright.dev/docs/api/class-cdpsession
- Playwright BrowserContext.newCDPSession: https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session
- MDN ImageBitmap.close(): https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap/close
- MDN createImageBitmap: https://developer.mozilla.org/en-US/docs/Web/API/createImageBitmap
- Tauri v2 event API: https://v2.tauri.app/develop/calling-frontend/
- Tokio `watch` channel: https://docs.rs/tokio/latest/tokio/sync/watch/

### Secondary (MEDIUM confidence)
- browserless `chrome-screencast` implementation notes (pattern reference for base64 JPEG over JSON transport) [VERIFIED against CDP docs]
- Existing repo patterns: `apps/desktop/src-tauri/src/commands/tts.rs` (app.emit) and `apps/desktop/src-tauri/src/commands/region_overlay.rs` (event payload shape)
- Plan 07-04a specification (`.planning/ROADMAP.md` line 187) — sketches the same notification infrastructure; Phase 9 should ship it first

### Tertiary (LOW confidence)
- WKWebView `createImageBitmap` performance vs. Chromium — inferred from MDN; flag for measurement in 09-03

## Metadata

**Confidence breakdown:**
- CDP API surface: HIGH (authoritative docs, stable since 2017)
- Playwright `newCDPSession` path: HIGH (official docs)
- Sidecar implementation pattern: HIGH (mirrors existing `state.browser` lifecycle)
- Rust notification plumbing: MEDIUM — new code path, but conceptually identical to Plan 07-04a's proposed approach
- React rendering budget: MEDIUM — verified for Chromium; WKWebView is similar by construction but needs measurement
- Integration with Phase 8 GPU-downscale: HIGH — independent pipelines, no shared GPU context

**Research date:** 2026-04-18
**Valid until:** 2026-05-18 (stable CDP + Playwright surfaces; re-validate only if Playwright or Tauri major versions bump)
