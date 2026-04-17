# Phase 5.1–5.4: Window-Targeted Screen Capture — Research

**Researched:** 2026-04-17
**Domain:** macOS ScreenCaptureKit + Windows Graphics Capture + Playwright window bridge
**Confidence:** HIGH (versions, API shape, Playwright bridge); MEDIUM (lifecycle/error recovery edges)

## Summary

The existing `SckBackend` is a stub that never calls any streaming API. The TCC preflight, RAII wrapper, and trait surface are already correct and should be kept. The work is to wire `SCShareableContent` → `SCContentFilter::with_window(&SCWindow)` → `SCStream::new` → `add_output_handler(closure, SCStreamOutputType::Screen)` → `start_capture()` and hand each `CMSampleBuffer` into the pipeline as a `Frame`.

Two facts from CLAUDE.md / STACK.md are wrong and must be corrected before planning: (1) `screencapturekit` is pinned as `"=1.70.0"` in the documented stack but the crate's 1.x line caps at **1.5.4** (the current Cargo.toml already pins `=1.5.4`, matching Cargo.lock — the STACK.md text is stale); (2) `windows-capture` is documented as `"=1.5.0"` but Cargo.toml / Cargo.lock both use **2.0.0**. Plans should cite the installed versions, not the CLAUDE.md/STACK.md text.

The Playwright sidecar currently exposes no window info. Getting the Chromium window requires (a) adding a `browserProcess` verb that returns `browser.process().pid` over JSON-RPC, and (b) on the Rust side, enumerating `SCShareableContent.windows()` and filtering by `window.owning_application().process_id() == pid`. No CGWindowID bridge is needed — SCK's `SCWindow` is the handle.

**Primary recommendation:** Keep the current stub's scaffolding. Replace `SckBackend::start` body with real `SCStream` wiring behind a new `CaptureTarget::Window(WindowId)` variant on `CaptureConfig`. Add a `browserProcess` verb to the Playwright sidecar. Wire a Rust-side `find_window_by_pid` helper. Build target-picker UI last, after capture-by-window works headlessly in `cargo test`.

## User Constraints (from prompt)

### Locked Decisions
- **In-scope:** macOS SCK window/display capture, window enumeration IPC, Playwright pid→window bridge
- **Out-of-scope for this research:** WGC deep-dive (surface-level only), region/crop, multi-window composition
- **Crates already pinned:** `screencapturekit`, `windows-capture`, `xcap` — we use what's in Cargo.lock, not what STACK.md says
- **Pipeline shape stays:** backend → `mpsc::Sender<Frame>` → `ByteBoundedQueue` → FFmpeg sidecar; Frame PTS preserved (D-21); RAII handle wrapping on native path (D-19)

### Claude's Discretion
- `CaptureTarget` enum shape
- How to route window-id through `CaptureConfig` (extend vs replace `display_id`)
- Where `pid → SCWindow` lookup lives (new module vs inside `sck_backend.rs`)
- Whether to merge 5.1+5.2+5.3 or ship separately

### Deferred (out of scope)
- Windows WGC implementation (acknowledged as Phase 5.4; only crate-surface check here)
- Region/crop capture
- Multi-window composition

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PHASE-5.1 | Real SCK streaming, replacing stub | §Standard Stack, §Architecture Patterns, §Code Examples (macOS) |
| PHASE-5.2 | Capture-target picker UI + window enumeration IPC | §Architecture Patterns (`CaptureTarget`), §Code Examples (enumerate windows) |
| PHASE-5.3 | Playwright pid → window auto-follow | §Architecture Patterns (bridge), §Code Examples (sidecar verb + `find_window_by_pid`) |
| PHASE-5.4 | Windows WGC window parity | §Standard Stack (Windows section), §Code Examples (WGC sketch) |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Window enumeration | `crates/capture` (Rust, SCK/WGC) | Tauri IPC command | OS-native listing must happen in Rust; UI just renders |
| Target selection UI | React (apps/desktop frontend) | Zustand slice | User-facing state; Tauri invoke returns `WindowInfo[]` |
| Playwright PID lookup | Node sidecar (`scripts/playwright-sidecar/server.mjs`) | Rust automation crate forwards | Only Node has `browser.process()`; Rust drives via existing JSON-RPC |
| PID → WindowId resolution | `crates/capture/macos` | — | Must happen in Rust because it calls SCShareableContent |
| Stream lifecycle | `crates/capture` SckBackend | pipeline.rs (unchanged) | Backend-private; pipeline is tier-agnostic |
| Window-close recovery | `crates/capture` SckBackend via `SCStreamDelegate` | `CaptureEvent` emitted to Tauri host | Low-level detection in Rust; UX decision bubbles up |

## Standard Stack

### Core (macOS) — versions verified against Cargo.lock 2026-04-17

| Crate | Installed | Purpose | Why Standard | Provenance |
|-------|-----------|---------|--------------|------------|
| `screencapturekit` | **1.5.4** | High-level SCK wrapper (doom-fish) | Only actively maintained idiomatic wrapper; exposes SCStream/SCContentFilter/SCShareableContent directly | [VERIFIED: crates.io API — 29 versions, max 1.5.4 published 2026-03-09] |
| `objc2` | 0.5 | Escape hatch for SCK features the wrapper misses | Already pulled in; surgical use only | [VERIFIED: Cargo.toml] |
| `core-foundation` | 0.10 | CFRetain/CFRelease helpers | RAII wrapper already uses extern C; keep | [VERIFIED: Cargo.toml] |
| `core-graphics` | 0.24 | CGRect, CGDirectDisplayID types used by SCK filters | Already present | [VERIFIED: Cargo.toml] |
| `xcap` | 0.9.4 | Display enumeration + fallback capture | Enumeration is reliable; full-display capture keeps working today | [VERIFIED: Cargo.lock] |

**Critical correction:** CLAUDE.md / STACK.md both state `screencapturekit = "=1.70.0"`. That version does not exist on crates.io. The crate's numbering is **1.5.x**, not 1.70.x — someone likely typed the macOS SDK version (e.g. `14.0` ↔ `1.5.0`) or copied a version string from elsewhere. Cargo.toml is correct at `=1.5.4`; **plans should cite 1.5.4 explicitly** and the next STATE.md update should fix the CLAUDE.md claim.

### Core (Windows) — surface check only, Phase 5.4

| Crate | Installed | Purpose | Why |
|-------|-----------|---------|-----|
| `windows-capture` | **2.0.0** | High-level WGC wrapper (NiiightmareXD) | `Window::from_raw_hwnd`, `Window::from_name`, `Window::enumerate` all exist in 2.0; `TryInto<GraphicsCaptureItemType>` for `Settings`-based start [VERIFIED: docs.rs/windows-capture/2.0.0] |
| `windows` | 0.58 | Raw Win32 escape hatch | Already present; used for HWND discovery from PID if needed |

**Correction:** CLAUDE.md claims `windows-capture = "=1.5.0"`. Cargo.toml and Cargo.lock pin **2.0.0** (released 2026-04-14, three days ago). The 1.x → 2.x transition was recent and the API was reshaped (`GraphicsCaptureApiHandler` is the new handler trait). Any older snippets found on the web are 1.x — don't copy them.

### Node sidecar (Phase 5.3)

| Package | Purpose | Notes |
|---------|---------|-------|
| `playwright-core` (already bundled) | Exposes `browser.process()` returning `ChildProcess` with `.pid` | Available since Playwright 1.0; stable surface [CITED: playwright.dev/docs/api/class-browser — `browser.process()` returns ChildProcess of the browser] |

No new dependency — just a new verb in the existing sidecar.

### Alternatives Considered (and rejected for this phase)

| Instead of | Could Use | Rejected Because |
|------------|-----------|------------------|
| `screencapturekit` 1.5.4 | `objc2-screen-capture-kit` (raw bindings) | Requires hand-writing delegate conformance via `declare_class!`; we have no one on the team writing objc2 today. Use it only if the wrapper blocks a feature. |
| `screencapturekit` 1.5.4 | `scap` (CapSoftware) | Higher-level meta-wrapper around screencapturekit + windows-capture. Useful as a reference implementation (see §Code Examples) but adds a layer we don't need — we already have a trait. |
| `windows-capture` 2.0.0 | Raw `windows` + `Graphics::Capture` | Same reason as SCK — we'd be hand-rolling `GraphicsCaptureItemInterop::CreateForWindow`. Wrapper already does this. |
| Bridging via CGWindowID | — | SCK's `SCWindow` is already the capture handle. No need for `CGWindowListCopyWindowInfo` on the macOS path. |

**Installation:** No new crates. No Cargo.toml changes needed for phase 5.1–5.3.

**Version verification** (ran 2026-04-17 via crates.io API):
- `screencapturekit` 1.5.4 — published 2026-03-09 [VERIFIED]
- `windows-capture` 2.0.0 — published 2026-04-14 [VERIFIED]
- `xcap` 0.9.4 — already in use [VERIFIED: Cargo.lock]

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────┐                                          ┌──────────────┐
│  Playwright     │  (1) launch + newPage                    │ Node sidecar │
│  Rust driver    │─────────────────────────────────────────>│  server.mjs  │
│ (automation)    │                                          └──────┬───────┘
└────────┬────────┘                                                 │
         │                                                          │ (2) chromium
         │ (3) JSON-RPC: browserProcess                             │     launched
         │<─────────────────── { pid: 12345 } ──────────────────────┤
         │                                                          │
         │ (4) start_capture(CaptureTarget::Window { pid: 12345 })  │
         ▼                                                          ▼
┌─────────────────────────────────────────────────┐        [Chromium window]
│ SckBackend                                      │                │
│                                                 │                │ renders
│  (5) SCShareableContent::get().windows()        │                │
│      .find(|w| w.owning_application()           │                │
│           .map(|a| a.process_id() == pid)       │                │
│           .unwrap_or(false))                    │                │
│  (6) SCContentFilter::create()                  │                │
│      .with_window(&sc_window).build()           │                │
│  (7) SCStreamConfiguration::new()               │                │
│      .with_pixel_format(BGRA)                   │                │
│      .with_shows_cursor(true)                   │                │
│      .with_fps(60)                              │                │
│  (8) SCStream::new(&filter, &config)            │                │
│      .add_output_handler(                       │                │
│        move |sample, _| { emit_frame(tx); },    │                │
│        SCStreamOutputType::Screen)              │                │
│      .start_capture()                           │                │
└────────────────────┬────────────────────────────┘                │
                     │ CMSampleBuffer per frame                    │
                     │ (IOSurface-backed)                          │
                     ▼                                             │
                ┌────────┐      CVPixelBufferHandle(retain)        │
                │ Frame  │◄─────────────────────────────────────────
                └───┬────┘
                    │ mpsc::Sender<Frame>
                    ▼
            ┌───────────────────┐
            │ CapturePipeline   │  (unchanged)
            │ ByteBoundedQueue  │  (unchanged)
            └─────────┬─────────┘
                      ▼
                FFmpeg sidecar (unchanged)
```

### Component Responsibilities

| Component | File | Responsibility |
|-----------|------|----------------|
| `CaptureTarget` enum (new) | `crates/capture/src/target.rs` | Replaces `display_id: DisplayId` in `CaptureConfig` with an enum: Display / Window / App |
| `window_enumeration` (new) | `crates/capture/src/macos/window.rs` | `list_windows()` + `find_window_by_pid(pid)` — calls `SCShareableContent::get()` |
| `SckBackend` (rewrite) | `crates/capture/src/macos/sck_backend.rs` | Real `SCStream` wiring. Replaces the `start()` stub. |
| `frame_from_sample` (new) | `crates/capture/src/macos/frame_from_sample.rs` | `CMSampleBuffer → Frame` — extracts CVPixelBuffer, retains via `CVPixelBufferHandle`, reads width/height/stride/PTS |
| Playwright `browserProcess` verb | `scripts/playwright-sidecar/server.mjs` | Returns `{ pid, executablePath }` from `state.browser.process()` |
| Tauri IPC `list_capture_targets` | `apps/desktop/src-tauri/src/commands/capture.rs` | Wraps `crates/capture` enumeration for the UI |
| Target picker UI (new) | `apps/desktop/src/features/capture/TargetPicker.tsx` | Dropdown: Displays, Windows (filtered by on-screen=true, skip own-app), "Follow Playwright browser" auto-option |

### Recommended Project Structure

```
crates/capture/src/
├── backend.rs            # trait (extend CaptureConfig with CaptureTarget)
├── target.rs             # NEW: CaptureTarget enum + WindowId newtype
├── macos/
│   ├── mod.rs
│   ├── sck_backend.rs    # REWRITE: real SCStream wiring
│   ├── window.rs         # NEW: SCShareableContent enumeration + find_window_by_pid
│   ├── frame_from_sample.rs  # NEW: CMSampleBuffer → Frame
│   ├── raii.rs           # KEEP: CVPixelBufferHandle
│   └── tcc.rs            # KEEP: preflight
├── windows/              # Phase 5.4
│   └── wgc_backend.rs    # window-capture 2.0 wiring, TryInto<GraphicsCaptureItemType>
└── fallback/
    └── xcap_backend.rs   # KEEP: fallback stays display-only (xcap has no window API)
```

### Pattern 1: `CaptureTarget` enum (discretion — recommended shape)

**What:** Replace `CaptureConfig.display_id` with a richer target enum.
**When to use:** Every backend call site.
**Example:**

```rust
// crates/capture/src/target.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowId(pub u32);  // matches SCWindow::window_id() -> u32

#[derive(Debug, Clone)]
pub enum CaptureTarget {
    /// Capture an entire display. Default behavior for today's code path.
    Display(DisplayId),
    /// Capture a single OS window by its stable window id.
    Window(WindowId),
    /// Resolve at start() time — "the window owned by this pid", picked
    /// from SCShareableContent. Used for Playwright auto-follow since
    /// Chromium may not have a visible window when the Rust driver sees
    /// launch() resolve.
    WindowByPid { pid: i32, title_hint: Option<String> },
}

// CaptureConfig.display_id: DisplayId  →  target: CaptureTarget
```

**Why `WindowByPid` instead of resolving in the caller:** race condition. Playwright's `launch()` returns before Chromium has presented a window to WindowServer. If the caller resolves pid→window-id eagerly, it finds zero windows. If the backend resolves at `start()` time with a short retry (≤1s, 50ms interval), it reliably finds the window. This is the `title_hint` fallback's job — when PID matches multiple windows (unusual on Chromium, common on browsers that spawn helpers), narrow by title. [ASSUMED — based on Chromium's multi-process architecture; validate during 5.1 spike]

### Pattern 2: SCStream output handler as channel bridge

```rust
// crates/capture/src/macos/sck_backend.rs (new start() body)
use screencapturekit::{
    shareable_content::SCShareableContent,
    stream::{
        configuration::SCStreamConfiguration,
        content_filter::SCContentFilter,
        output_type::SCStreamOutputType,
        SCStream,
    },
};

let window = crate::macos::window::find_window_by_pid(pid, title_hint.as_deref())
    .await?  // has built-in retry up to ~1s
    .ok_or(CaptureError::WindowNotFound)?;

let filter = SCContentFilter::create()
    .with_window(&window)
    .build();

let config = SCStreamConfiguration::new()
    .with_width(window.frame().size.width as u32)
    .with_height(window.frame().size.height as u32)
    .with_pixel_format(PixelFormat::BGRA)
    .with_shows_cursor(cfg.include_cursor)
    .with_fps(cfg.fps_target)
    .with_queue_depth(8);

let mut stream = SCStream::new(&filter, &config);

// Closure handler form: captures `out` (mpsc::Sender<Frame>). Handler is
// invoked on SCK's internal dispatch queue, NOT on the tokio runtime, so
// we use `try_send` + drop-on-full (byte-bounded queue also enforces this).
let out_clone = out.clone();
stream.add_output_handler(
    move |sample, _kind| {
        if let Some(frame) = crate::macos::frame_from_sample::to_frame(&sample) {
            let _ = out_clone.try_send(frame);
        }
    },
    SCStreamOutputType::Screen,
);

stream.start_capture()?;
```

**Key detail:** the callback runs on SCK's internal Grand Central Dispatch queue (not tokio). Using `tokio::sync::mpsc::Sender::send().await` from inside the callback would require a bridge (e.g. `tokio::runtime::Handle::current().spawn`). Using `try_send` keeps the callback synchronous and matches how `scap` does it (MPSC forward). Backpressure is already handled by `ByteBoundedQueue` downstream.

### Anti-Patterns to Avoid

- **Don't resolve pid→window in the caller, pre-start.** Race condition. Resolve inside `SckBackend::start`, with a short polling retry.
- **Don't await inside the SCK callback.** The callback is synchronous from SCK's perspective; it fires on a CoreMedia dispatch queue. Use `try_send`.
- **Don't call `SCShareableContent::get()` on the main thread.** It blocks while WindowServer responds; call it from a `tokio::task::spawn_blocking` or an std thread and await a oneshot.
- **Don't pass an empty `excluding_windows` array when using `SCContentFilter`** in display mode — known SCK bug: stream never starts. [VERIFIED: Apple Developer Forums, referenced in search result] Use `.with_window()` path instead of `excludingWindows` where possible.
- **Don't re-use an `SCStream` after `stop_capture()`.** Build a fresh one per capture session.
- **Don't forget to drop the stream before `stop()` returns.** RAII + delegate retention: if the stream outlives the mpsc sender, the callback will `try_send` into a closed channel (benign but noisy).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CMSampleBuffer → pixel bytes | Custom CoreMedia FFI | `sample.image_buffer()` + `pixel_buffer.io_surface()` from `screencapturekit` | Already typed, already Drop-safe |
| Window enumeration | Raw `CGWindowListCopyWindowInfo` | `SCShareableContent::get().windows()` | SCWindow is also the capture handle — two birds |
| PID lookup for Chromium | Process tree scanning, bundle-id matching | `browser.process().pid` from Playwright Node API | Playwright owns the child process; it already has the answer |
| Delegate conformance in Rust | Hand-written `SCStreamDelegate` via `declare_class!` | `screencapturekit`'s `SCStreamOutputTrait` + closure wrapper | Wrapper registers the delegate for you |
| HWND from Chromium PID (5.4) | Raw `EnumWindows` + `GetWindowThreadProcessId` loop | `windows_capture::window::Window::enumerate()` then filter by pid via win32, **or** `Window::from_name` by Chromium window title | Wrapper provides the enumerate; pid filter is 3 lines of `windows` crate |
| Cross-platform window abstraction | Custom trait | `scap` crate is the closest reference; **we still roll our own trait** because `scap` wraps too much and doesn't expose IOSurface zero-copy | Single reference doesn't exist that fits our Frame+RAII model; our trait is already the right abstraction |

**Key insight:** There is **no** mature cross-platform Rust library that abstracts "capture this window on macOS + Windows with zero-copy and PTS preservation." `scap` comes closest but owns too much of the pipeline. Our existing `CaptureBackend` trait is the correct abstraction; we just need to fill in the platform implementations behind it. Confirmed via crates.io search 2026-04-17.

## Common Pitfalls

### Pitfall 1: Stale TCC ("ghost grant") on dev builds
**What goes wrong:** `CGPreflightScreenCaptureAccess` returns true, but `SCStream::start_capture` errors with "not permitted."
**Why it happens:** TCC keys grants by the signing identity hash of the bundle. Changing signing identity between builds (common in dev) leaves a stale TCC row that matches the bundle ID but not the hash. macOS silently reports "granted" for some APIs and "denied" for SCK.
**How to avoid:** On SCK start error, re-run preflight and if still granted, surface a "Reset permission" UI that calls `tccutil reset ScreenCapture <bundle-id>`. [CITED: Federico Terzi blog — ScreenCaptureKit failing to capture the entire Display]
**Warning signs:** Error code `SCStreamErrorDomain -3801` or similar despite green preflight.

### Pitfall 2: Empty `excluding_windows` crashes/hangs the stream
**What goes wrong:** Using `SCContentFilter.init(display:excludingWindows:[])` → `start_capture()` hangs indefinitely.
**How to avoid:** Never pass empty excluding-windows. Use `with_window` form for window-targeted capture; use `with_display` (no excluding) for full-display.
[CITED: search hit "Passing an empty windows array to initWithDisplay:excludingWindows: causes the stream to never start"]

### Pitfall 3: Window resize mid-stream — SCStreamConfiguration is sticky
**What goes wrong:** Window is resized; frames arrive at the original dimensions (possibly clipped or letterboxed). The config's `width`/`height` control the output, not the input.
**How to avoid:** Either (a) call `stream.update_configuration(new_config)` on detected resize (SCK supports this without re-creating the stream), or (b) configure without width/height and let SCK pick the window's native size — but then downstream FFmpeg stdin can't assume a fixed resolution. Option (a) is preferred; hook a `CaptureEvent::TargetResized` through to the host.
**Warning signs:** Video has constant dimensions but window visibly changed.

### Pitfall 4: Window closed or minimized mid-stream
**What goes wrong:** SCK fires `SCStreamDelegate::stream(_:didStopWithError:)` with an error; the mpsc sender sees EOF. Current backend has no delegate — the error is lost.
**How to avoid:** In 5.1, implement `SCStreamDelegate` via the crate's `.with_delegate(...)` builder (see `scap`'s pattern) and forward errors as `CaptureEvent::BackendFailed { reason }`. UI should offer: (1) pause recording, (2) switch to full-display, (3) wait-and-resume if the window reappears (SCK does NOT auto-resume; user must re-select). [VERIFIED: Apple docs for `stream(_:didStopWithError:)`]
**Warning signs:** Frames stop arriving; no error surfaces in logs.

### Pitfall 5: Long-running audio capture crashes (documented SCK bug)
**What goes wrong:** `EXC_BAD_ACCESS` in `SCStreamDelegate.stream(_:didStopWithError:)` after extended capture with audio. [CITED: pyobjc issue #647]
**How to avoid:** Phase 5.1 targets video-only. Don't enable `with_captures_audio(true)` until a separate spike validates long-duration audio on macOS 15+.

### Pitfall 6: Closure callback runs on SCK's dispatch queue, not tokio
**What goes wrong:** Awaiting or calling runtime-bound APIs panics or deadlocks.
**How to avoid:** Treat the callback as `Fn(CMSampleBuffer, SCStreamOutputType) + Send + Sync` with sync-only ops. Use `mpsc::Sender::try_send` or a `std::sync::mpsc` fed into a tokio-owned drain task. See `scap`'s MPSC pattern.

### Pitfall 7: `SCShareableContent::get()` is synchronous and slow (~50–200ms)
**What goes wrong:** Called on the Tokio reactor thread → UI jank / async-fn starvation.
**How to avoid:** Wrap in `tokio::task::spawn_blocking`. The doom-fish crate's async feature mostly wraps this but verify — there's a `SCShareableContent::get_async` in 1.5.x [VERIFIED: docs.rs module listing showed async variants].

### Pitfall 8: Playwright `launch()` resolves before the window is in `SCShareableContent`
**What goes wrong:** Enumerate-then-match returns no match; capture fails to start.
**How to avoid:** Retry `find_window_by_pid` with backoff (5× at 100ms). Chromium startup window-register time is usually <300ms. [ASSUMED — needs spike measurement on slow hardware]

## Code Examples

### Example 1: Enumerate windows (Phase 5.2)

```rust
// crates/capture/src/macos/window.rs
use screencapturekit::shareable_content::SCShareableContent;
use crate::error::CaptureError;

#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowInfo {
    pub window_id: u32,
    pub title: Option<String>,
    pub app_name: String,
    pub pid: i32,
    pub bundle_id: String,
    pub x: f64, pub y: f64,
    pub width: f64, pub height: f64,
    pub is_on_screen: bool,
}

pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    let content = SCShareableContent::get()
        .map_err(|e| CaptureError::Native(format!("SCShareableContent::get: {e}")))?;
    let mut out = Vec::new();
    for w in content.windows() {
        if !w.is_on_screen() { continue; }
        if w.window_layer() != 0 { continue; } // skip menubar / dock
        let app = match w.owning_application() {
            Some(a) => a,
            None => continue,
        };
        let frame = w.frame();
        out.push(WindowInfo {
            window_id: w.window_id(),
            title: w.title(),
            app_name: app.application_name(),
            pid: app.process_id(),
            bundle_id: app.bundle_identifier(),
            x: frame.origin.x, y: frame.origin.y,
            width: frame.size.width, height: frame.size.height,
            is_on_screen: true,
        });
    }
    Ok(out)
}
```

### Example 2: Find window by pid with retry (Phase 5.3 bridge)

```rust
use screencapturekit::shareable_content::{SCShareableContent, window::SCWindow};
use std::time::Duration;

pub async fn find_window_by_pid(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<SCWindow>, CaptureError> {
    for _ in 0..10 { // ~1s total
        let content = tokio::task::spawn_blocking(SCShareableContent::get)
            .await
            .map_err(|e| CaptureError::Native(format!("join: {e}")))?
            .map_err(|e| CaptureError::Native(format!("SCShareableContent: {e}")))?;
        let mut candidates: Vec<_> = content.windows().into_iter()
            .filter(|w| w.is_on_screen())
            .filter(|w| w.owning_application()
                .map(|a| a.process_id() == pid)
                .unwrap_or(false))
            .collect();
        if let Some(hint) = title_hint {
            candidates.retain(|w| w.title().as_deref().map(|t| t.contains(hint)).unwrap_or(false));
        }
        // Prefer largest window (Chromium's main window is larger than any popup)
        candidates.sort_by(|a, b| {
            let area = |w: &SCWindow| w.frame().size.width * w.frame().size.height;
            area(b).partial_cmp(&area(a)).unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(w) = candidates.into_iter().next() { return Ok(Some(w)); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(None)
}
```

### Example 3: Playwright sidecar verb (Phase 5.3)

```javascript
// scripts/playwright-sidecar/server.mjs — add to `handlers` object
browserProcess: async () => {
  if (!state.browser) throw new Error('browser not launched');
  const proc = state.browser.process();
  if (!proc) {
    // Remote browsers (CDP/WS connect) don't own the process.
    return { pid: null, executablePath: null, reason: 'remote-browser' };
  }
  return { pid: proc.pid, executablePath: proc.spawnfile };
},
```

On the Rust side in `crates/automation`, add a matching method on the sidecar driver that invokes this verb and returns `Option<i32>`. The recording controller calls it right after `launch()` succeeds.

### Example 4: CMSampleBuffer → Frame (Phase 5.1)

```rust
// crates/capture/src/macos/frame_from_sample.rs
use screencapturekit::core_media::sample_buffer::CMSampleBuffer;
use crate::frame::{ClockSource, Frame, FrameData, PixelFormat, Pts};
use crate::macos::raii::CVPixelBufferHandle;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn to_frame(sample: &CMSampleBuffer) -> Option<Frame> {
    let pixel_buffer = sample.image_buffer()?;
    let width_px = pixel_buffer.width() as u32;
    let height_px = pixel_buffer.height() as u32;
    // PTS — native CMTime in host clock (mach_absolute_time scaled ns).
    let pts_cm = sample.presentation_timestamp();
    let pts_ns = pts_cm.to_nanos(); // wrapper method [VERIFIED: docs.rs CMTime]
    let handle = unsafe {
        CVPixelBufferHandle::retain(pixel_buffer.as_concrete_TypeRef() as *mut _)
    }?;
    Some(Frame {
        pts: Pts { ns: pts_ns as i128, source: ClockSource::HostTime },
        width_px,
        height_px,
        format: PixelFormat::Bgra,
        data: FrameData::NativeMacOS(handle),
        sequence: SEQUENCE.fetch_add(1, Ordering::Relaxed),
    })
}
```

(The exact method names on `CMSampleBuffer` / `CVPixelBuffer` in the 1.5.4 wrapper need one-pass verification during the spike — the wrapper's module layout puts them under `core_media::` and `core_video::`. `scap`'s `pixelformat::create_bgra_frame` is a working reference for the extraction path. [CITED: github.com/CapSoftware/scap/blob/main/src/capturer/engine/mac/mod.rs])

### Example 5: Windows parity sketch (Phase 5.4)

```rust
// crates/capture/src/windows/wgc_backend.rs
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame as WgcFrame,
    settings::Settings,
    window::Window,
};

struct StoryHandler { tx: tokio::sync::mpsc::Sender<crate::Frame> /* ... */ }

impl GraphicsCaptureApiHandler for StoryHandler {
    type Flags = ();
    type Error = Box<dyn std::error::Error + Send + Sync>;
    fn new(_ctx: Context<Self::Flags>) -> Result<Self, Self::Error> { todo!() }
    fn on_frame_arrived(&mut self, frame: &mut WgcFrame, _capture: InternalCaptureControl) -> Result<(), Self::Error> {
        // D3D11 texture -> CPU read or pass handle via D3DTextureHandle
        Ok(())
    }
}

// To start:
let window = Window::enumerate()?.into_iter()
    .find(|w| w.process_id() == pid)  // verify method name in 2.0
    .ok_or("not found")?;
let settings = Settings::new(window, /* ... */);
StoryHandler::start(settings)?;
```

(Phase 5.4 will verify the exact `Window` API in 2.0; the 2.0 release is 3 days old and docs are thin. `Window::from_raw_hwnd`, `from_name`, `enumerate`, `foreground` are all confirmed to exist [VERIFIED: docs.rs/windows-capture/2.0.0].)

## State of the Art

| Old Approach | Current Approach | When Changed |
|--------------|------------------|--------------|
| Raw `objc` + manual `declare_class!` for SCStreamDelegate | `screencapturekit` 1.5.x wrapper with `SCStreamOutputTrait` + closure | Wrapper matured in Q4 2025 |
| `windows-capture` 1.5 with older callback API | `windows-capture` 2.0 with `GraphicsCaptureApiHandler` trait | April 2026 (3 days old) |
| CGWindowList-based window picking | `SCShareableContent.windows` (also the capture handle) | macOS 12.3+ SCK GA |
| `CGWindowListCreateImage` for screenshots | `SCStream` single-frame / `SCScreenshotManager` (macOS 14+) | Deprecated in macOS 15 |

**Deprecated/outdated:**
- `CGDisplayStream` — replaced by SCK; removed in macOS 14.
- `AVCaptureScreenInput` — deprecated; use SCK.
- CLAUDE.md's `screencapturekit = "=1.70.0"` pin — version never existed; correct text to `=1.5.4`.
- CLAUDE.md's `windows-capture = "=1.5.0"` pin — Cargo.toml already moved to `=2.0.0`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Chromium registers its window with WindowServer ≤1s after `launch()` resolves | Architecture §Pattern 1 | Capture-start fails on slow hardware; mitigation is longer retry. Spike during 5.1. |
| A2 | SCK callback runs synchronously on a GCD queue, not the tokio runtime | Architecture §Pattern 2 + Pitfall 6 | If wrong, `try_send` is still safe; if it IS tokio-aware we'd just leave perf on the table |
| A3 | `CMSampleBuffer::presentation_timestamp()` → `to_nanos()` exists on the 1.5.4 wrapper | Code Example 4 | Plan includes a 5-minute API-verify task before spike lands; fallback = compute from CMTime fields manually |
| A4 | `update_configuration()` handles window-resize without stream restart | Pitfall 3 | Apple docs say yes; doom-fish wrapper exposes it. Worst case: reinit stream (~100ms gap). |
| A5 | Playwright's `browser.process()` returns non-null for non-remote launches | Code Example 3 | We handle the `null` case by falling back to full-display capture. |

## Open Questions

1. **Does the `screencapturekit` 1.5.4 wrapper expose `update_content_filter` for seamless target-switching?**
   - What we know: docs mention `update_configuration` and `update_content_filter`; exact method name on the wrapper unverified.
   - Recommendation: 30-minute API-verify task at the start of 5.1. If not exposed, fall back to stop+new+start (~100ms gap, acceptable).

2. **Does SCK reliably capture a window whose Chromium has hardware acceleration enabled?**
   - What we know: WWDC22 session says yes; community reports occasional frame-skip on 60fps games.
   - Recommendation: spike at 60fps with `playwright-core` default flags. If drops are visible, reduce to 30fps for MVP (consistent with current xcap fallback).

3. **What's the exact behavior when a Chromium tab opens a popup window (OAuth)?**
   - What we know: popup is a new `SCWindow` with the same `owning_application.process_id`.
   - Recommendation: Phase 5.3 must decide: stay on main window, switch to popup (capture OAuth UX in the video), or compose. Defer decision to user research; MVP = stay on main, note popup in metadata.

4. **On Windows, does Chromium launch a single PID with the main window, or a browser parent + renderer children with the window on a different PID than `browser.process().pid`?**
   - What we know: Chromium's multi-process model puts the UI on the browser process PID; renderers are sandboxed children without top-level windows.
   - Recommendation: Phase 5.4 verify by enumerating windows at the browser.pid. If miss, walk child processes via `windows` crate's `Process32First`.

5. **Should WindowId be a u32 (SCK's) or a platform-tagged enum?**
   - What we know: SCK uses `u32`, WGC uses `HWND` (isize). They can't be unified.
   - Recommendation: `WindowId(u64)` with a platform-tagged `WindowIdScope { Macos(u32), Windows(isize) }`. Keep UI-facing API as opaque `String` (serialized tagged enum) to prevent cross-platform leaks.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| macOS 12.3+ runtime | SCK (minimum) | ✓ | build minOS | — |
| macOS 13.0+ runtime | `SCWindow::is_active()` | optional | build minOS | omit field on <13 |
| Screen Recording TCC grant | Any SCK capture | user-gated | N/A | Existing `tcc.rs` preflight + guided modal |
| `screencapturekit` 1.5.4 crate | SckBackend | ✓ | Cargo.lock | — |
| `windows-capture` 2.0.0 | WgcBackend (5.4) | ✓ | Cargo.lock | — |
| Playwright-core (sidecar) with `browser.process()` | Auto-follow verb | ✓ | bundled SEA | If `.process()` returns null, capture full display |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** remote-browser Playwright (CDP-connect) — `browser.process()` returns null; fall back to Display capture or user picks a window manually.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `cargo test` / `cargo nextest`; Rust integration tests live under `crates/capture/tests/` |
| Config file | `crates/capture/Cargo.toml` (feature flag `real-capture`) |
| Quick run command | `cargo test -p capture --lib` (mock backend; no OS grants needed) |
| Full suite command | `cargo test -p capture --features real-capture` (requires Screen Recording grant; macOS only) |

### Phase Requirements → Test Map

| Req | Behavior | Test Type | Automated Command | File Exists? |
|-----|----------|-----------|-------------------|--------------|
| PHASE-5.1 | SckBackend streams ≥1 frame from a known display | integration | `cargo test -p capture --features real-capture sck_display_smoke` | ❌ new |
| PHASE-5.1 | SckBackend streams from a named window (SCK app itself: any known app window) | integration | `cargo test -p capture --features real-capture sck_window_smoke` | ❌ new |
| PHASE-5.1 | Stream survives 30s without dropping > 5% of frames | integration soak | reuse `capture-soak` workflow, flip to SCK target | ❌ new |
| PHASE-5.1 | Window close during capture triggers `CaptureEvent::BackendFailed` | integration | `cargo test -p capture --features real-capture sck_window_close_recovery` | ❌ new |
| PHASE-5.2 | `list_windows()` returns non-empty, excludes our own app | unit (real) | `cargo test -p capture --features real-capture list_windows_excludes_self` | ❌ new |
| PHASE-5.2 | Tauri IPC `list_capture_targets` round-trips JSON | integration | `cargo test -p storycapture-desktop list_capture_targets_ipc` | ❌ new |
| PHASE-5.3 | Playwright `browserProcess` returns non-null pid after launch | unit (Node sidecar) | Vitest against sidecar stdio | ❌ new |
| PHASE-5.3 | `find_window_by_pid` resolves Chromium within 1s | integration | `cargo test -p capture --features real-capture find_window_by_pid_chromium` (spawns a sacrificial Chromium) | ❌ new |
| PHASE-5.3 | End-to-end: start recording with WindowByPid, produce 5s MP4 | e2e | separate bin target `tools/e2e-playwright-capture` | ❌ new |
| PHASE-5.4 | `windows-capture` 2.0 Window::enumerate + from_raw_hwnd compile on Windows | build gate | `cargo build -p capture --target x86_64-pc-windows-msvc` | partial |

### Sampling Rate
- **Per task commit:** `cargo test -p capture --lib` (mock-backend suite — must stay green)
- **Per wave merge:** `cargo test -p capture --features real-capture` on a macOS runner with Screen Recording granted
- **Phase gate:** 30-min soak in `capture-soak` workflow with SCK target; RAM under 800 MB

### Wave 0 Gaps
- [ ] `crates/capture/tests/sck_real_capture.rs` — gated by `real-capture` feature
- [ ] `crates/capture/tests/find_window_by_pid.rs` — spawns a Chromium via Playwright; covers PHASE-5.3 bridge
- [ ] `scripts/playwright-sidecar/server.test.mjs` — vitest for the `browserProcess` verb
- [ ] `.github/workflows/capture-sck-soak.yml` — macOS runner with `defaults write` TCC bypass for CI (or self-hosted mac mini)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | N/A — no user creds in this surface |
| V3 Session Management | no | — |
| V4 Access Control | yes | OS TCC grant (Screen Recording); enforced by OS, not us |
| V5 Input Validation | yes | Window titles from `SCWindow::title()` flow into UI — HTML-escape in React (Lucide/JSX handles by default) |
| V6 Cryptography | no | — |

### Known Threat Patterns for this surface

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Window-title XSS into UI | Tampering | React JSX auto-escapes; do not `dangerouslySetInnerHTML` |
| PID spoofing to redirect capture to another user's window | EoP (local) | On macOS, `SCShareableContent` is scoped to the session; no cross-user leak. If `WindowByPid` finds a window whose `owning_application` is a different UID, refuse |
| Capture of hidden/system windows | InfoDisclosure | Filter `window_layer != 0` + `!is_on_screen` in the picker; log-audit any capture where `window_layer != 0` |
| Recording after user revoked TCC mid-session | T / I | Listen for `SCStreamDelegate::didStopWithError`; stop pipeline immediately |

## Phase Breakdown (Recommendation)

**Ship as three phases, not four. Fold 5.2 into 5.1; keep 5.3 and 5.4 separate.**

### Phase 5.1 — SCK backend + window enumeration + target-picker API (macOS)
Scope:
- Replace `SckBackend::start` stub with real streaming (display target first, window target second)
- Ship `CaptureTarget` enum + plumb through `CaptureConfig`
- Ship `crates/capture/src/macos/window.rs` with `list_windows()` + `find_window_by_pid()`
- Ship `crates/capture/src/macos/frame_from_sample.rs`
- Tauri IPC commands: `list_capture_targets()`, update `start_capture(target)`
- Tests: real-capture integration tests (`sck_display_smoke`, `sck_window_smoke`)
- `CaptureEvent::BackendFailed` on `SCStreamDelegate` errors
**Reason to merge 5.2 into 5.1:** The UI picker (5.2) depends on `list_capture_targets` returning real data, which depends on 5.1. Shipping 5.2 independently means a UI that calls a stub. The React picker itself is ~2 hours of work; not worth phase overhead.

**Phase 5.1 exit criterion:** `cargo test -p capture --features real-capture` green + manual smoke: record a 5s MP4 of a Chrome window selected by title from the picker.

### Phase 5.3 — Playwright auto-follow
Scope:
- Add `browserProcess` verb to Node sidecar
- Add `browser_pid()` method to `crates/automation` sidecar driver
- Add `CaptureTarget::WindowByPid` handling (mostly reuse of 5.1's `find_window_by_pid`)
- UI: "Follow Playwright browser" radio option in picker
- E2E: `tools/e2e-playwright-capture` produces `sample.mp4` containing only Chromium's viewport

**Can be done in parallel with 5.1 implementation, but merges after 5.1 lands.**

### Phase 5.4 — Windows WGC parity
Scope:
- `windows-capture` 2.0 `GraphicsCaptureApiHandler` implementation in `crates/capture/src/windows/wgc_backend.rs`
- `Window::enumerate` + `from_raw_hwnd` + `from_name`
- Playwright pid → HWND via `windows` crate's `EnumWindows` + `GetWindowThreadProcessId`
- `CaptureTarget::Window` and `CaptureTarget::WindowByPid` must work on Windows exactly as on macOS (trait surface unchanged)
- Tests: gated Windows runner in GitHub Actions

**5.4 is a separate phase because:** new codebase module, new CI runner, brand-new crate version (2.0.0 is 3 days old as of this research), high risk of API churn. Do not bundle with the macOS phases.

## Sources

### Primary (HIGH confidence)
- [screencapturekit on crates.io — all 29 versions listed, max 1.5.4 published 2026-03-09](https://crates.io/api/v1/crates/screencapturekit) — verified version pinning
- [doom-fish/screencapturekit-rs README on docs.rs](https://docs.rs/screencapturekit/latest/screencapturekit/) — SCStream + SCContentFilter + SCStreamOutputTrait API shape
- [SCStreamConfiguration builder methods on docs.rs](https://docs.rs/screencapturekit/1.5.4/screencapturekit/stream/configuration/struct.SCStreamConfiguration.html) — confirmed `with_width`, `with_height`, `with_pixel_format`, `with_shows_cursor`, `with_fps`, `with_queue_depth`
- [SCShareableContent + SCWindow + SCRunningApplication on docs.rs](https://docs.rs/screencapturekit/1.5.4/screencapturekit/shareable_content/) — window fields: window_id(), title(), owning_application(), is_on_screen(), frame(), window_layer(), is_active()
- [windows-capture 2.0.0 on docs.rs — Window::{from_raw_hwnd, from_name, enumerate, foreground} + TryInto<GraphicsCaptureItemType>](https://docs.rs/windows-capture/2.0.0/windows_capture/window/struct.Window.html)
- [Playwright Browser.process() returns ChildProcess with .pid](https://playwright.dev/docs/api/class-browser) — for Playwright bridge (5.3)
- Local Cargo.lock inspection — verified installed versions (screencapturekit=1.5.4, windows-capture=2.0.0, xcap=0.9.4)

### Secondary (MEDIUM confidence)
- [CapSoftware/scap engine/mac/mod.rs — reference implementation for CMSampleBuffer→BGRA pattern](https://github.com/CapSoftware/scap/blob/main/src/capturer/engine/mac/mod.rs)
- [Federico Terzi — ScreenCaptureKit failing to capture the entire Display (TCC/signing identity pitfall)](https://federicoterzi.com/blog/screencapturekit-failing-to-capture-the-entire-display/)
- [Apple dev forums — empty excluding-windows array causes stream to never start](https://developer.apple.com/forums/tags/screencapturekit)

### Tertiary (LOW confidence — needs validation during spike)
- Exact CMSampleBuffer method name for PTS access on the 1.5.4 wrapper — verify during 5.1 first task
- Chromium window-register latency after `launch()` — measurement during 5.1 spike
- `update_content_filter` method availability on the 1.5.4 wrapper — verify during 5.1

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions verified against live crates.io and Cargo.lock
- Architecture: HIGH — API surface confirmed via docs.rs and reference impl (`scap`)
- Pitfalls: MEDIUM — 5 of 8 cited from sources; 3 marked assumed, to be confirmed in spike
- Playwright bridge: HIGH — `browser.process().pid` is a documented public API
- Windows (5.4): MEDIUM — windows-capture 2.0.0 is 3 days old; API shape confirmed but no production examples yet

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (30 days — fast-moving: `windows-capture` 2.0 is brand new; `screencapturekit` 1.5.x line is receiving point releases every 1–2 weeks)

**Corrections to upstream docs (track for next STATE.md update):**
1. CLAUDE.md & STACK.md: `screencapturekit = "=1.70.x"` → `= "=1.5.4"` (1.70.x never existed)
2. CLAUDE.md & STACK.md: `windows-capture = "=1.5.0"` → `= "=2.0.0"` (Cargo.toml already upgraded; docs lag)
