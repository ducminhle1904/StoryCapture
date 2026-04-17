---
phase: 06-recording-v2-audio-region-capture-chrome-hiding-multi-browse
plan: 02
subsystem: capture + automation + desktop
tags: [region, chrome-hiding, cursor, sck, wgc, overlay, playwright, d-07-amendment]
requires:
  - 06-01 (recording pipeline v2 baseline)
  - 05-01 (CaptureTarget enum + window targeting)
  - 05-02 (Playwright auto-follow)
  - 05-03 (Windows WGC backend)
provides:
  - CaptureTarget::DisplayRegion variant (crate: capture)
  - RegionRect struct + validate() (crate: capture)
  - SCK source_rect native crop (macOS)
  - WGC post-capture CPU crop (Windows) + Criterion bench gate
  - LaunchConfig.args field — forwarded to Playwright launchServer
  - Chromium --app= chrome-hiding toggle (non-sticky, Chromium-family only)
  - Per-recording cursor toggle (non-sticky, defaults ON)
  - Region-selection transparent overlay window + IPC commands
affects:
  - crates/capture/src/target.rs, macos/sck_backend.rs, windows/wgc_backend.rs, windows/frame_from_wgc.rs
  - crates/automation/src/driver.rs, playwright_driver.rs
  - scripts/playwright-sidecar/server.mjs (+ server.test.mjs)
  - apps/desktop/src-tauri/src/commands/{capture.rs, encode.rs, automation.rs, region_overlay.rs, mod.rs}
  - apps/desktop/src-tauri/src/ipc_spec.rs
  - apps/desktop/src/features/{capture/RegionOverlay.tsx, capture/TargetPicker.tsx, recorder/*, settings/browser-presets.ts}
  - apps/desktop/src/state/recorder.ts
  - apps/desktop/src/ipc/{capture.ts, automation.ts, encode.ts}
  - apps/desktop/src/routes/index.tsx (new /region-overlay route)
tech-stack:
  added: [criterion 0.5 (dev), url 2 (desktop-tauri)]
  patterns:
    - "Platform-native crop (SCK source_rect) on macOS; in-process CPU row copy on Windows per D-07 amendment"
    - "Non-sticky per-recording toggles via Zustand reset()"
    - "Env-var tunneling (STORYCAPTURE_CHROME_HIDING) to thread UI flag → LaunchConfig::from_meta without touching executor call sites"
    - "Additive enum variant + #[serde(default)] optional field — full backwards compat with Phase 5 IPC payloads"
key-files:
  created:
    - apps/desktop/src-tauri/src/commands/region_overlay.rs
    - apps/desktop/src/features/capture/RegionOverlay.tsx
    - apps/desktop/src/features/recorder/ChromeHidingToggle.tsx
    - apps/desktop/src/features/recorder/CursorToggle.tsx
    - apps/desktop/src/features/settings/browser-presets.ts
    - crates/capture/benches/windows_cpu_crop.rs
  modified:
    - crates/capture/src/target.rs (RegionRect + DisplayRegion variant)
    - crates/capture/src/macos/sck_backend.rs (source_rect branch + compute_region_math helper)
    - crates/capture/src/windows/wgc_backend.rs (crop_rect flag + WithoutCursor dispatch)
    - crates/capture/src/windows/frame_from_wgc.rs (PhysicalRectU32 + cpu_crop_bgra)
    - crates/capture/src/fallback/xcap_backend.rs (DisplayRegion → UnsupportedTarget)
    - crates/capture/src/orchestrator.rs (DisplayRegion included in is_window_target)
    - crates/automation/src/driver.rs (LaunchConfig.args + 6 new tests)
    - scripts/playwright-sidecar/server.mjs (args spread + pages()[0] reuse)
    - apps/desktop/src-tauri/src/commands/capture.rs (CaptureTargetDto::DisplayRegion + bounds validation)
    - apps/desktop/src-tauri/src/commands/automation.rs (chrome_hiding param + url::Url gate)
    - apps/desktop/src-tauri/src/commands/encode.rs (include_cursor field)
    - apps/desktop/src/features/recorder/recording-view.tsx (wire all three toggles + region overlay + listener)
decisions:
  - D-07-amendment-verified: windows-capture 2.0.0 has no native region API; post-capture CPU crop is the only path until the crate ships one. Flagged in plan with "⚠ D-07 amendment" note; implementation matches the spirit of D-07 (no FFmpeg -vf crop) while deviating from the letter (WGC native).
  - D-19/D-20-non-sticky: cursor toggle defaults to true on every recorder mount + reset(). Same pattern used for chromeHiding (D-10).
  - Region overlay uses createBrowserRouter path-based route (`/region-overlay`) rather than a hash-route because Tauri's WebviewUrl::App resolves paths directly via the served SPA.
  - STORYCAPTURE_CHROME_HIDING env-var tunneling chosen over extending LaunchConfig through the executor — minimizes blast radius; from_meta already reads STORYCAPTURE_BROWSER_PATH via the same mechanism (Phase 1 precedent).
metrics:
  duration: auto-mode execution
  completed: 2026-04-17
  tasks_completed: 7 (T-00 through T-06)
  commits: 5
  files_touched: ~26
---

# Phase 06 Plan 02: Region Capture + Chromium Chrome-Hiding + Cursor Toggle Summary

**One-liner:** Per-display region capture with platform-correct crop (SCK source_rect on macOS, CPU row copy on Windows), Chromium `--app=` chrome-hiding with single-page reuse, and a per-recording cursor toggle — all three non-sticky and landing as additive surface on Phase 5's capture pipeline.

## What shipped

### Task 0 — `CaptureTarget::DisplayRegion` enum variant + IPC
- `RegionRect { x, y, w, h: f64 }` + `validate(disp_logical_w, disp_logical_h)` rejects 7 bad-rect cases (NaN/Inf, zero-area, negative origin/size, out-of-bounds) with structured errors — T-06-08 mitigation lives in `start_capture_target` at the IPC boundary.
- DTO `CaptureTargetDto::DisplayRegion` + `RegionRectDto` mirror the Rust shape. TS union gets a matching `{ kind: "display_region"; display_id; rect }` branch.
- 12 target-module unit tests green.

### Task 1 — macOS SCK source_rect branch
- `build_filter` return signature extended to `(filter, width_px, height_px, Option<CGRect>)`. DisplayRegion arm passes the logical-point rect (verbatim from UI) as SCStreamConfiguration source_rect; `compute_region_math` helper handles the point→pixel scale via `disp.width() / disp.frame().width` (Pitfall 7) with `.round()` for 1.5× fractional scales.
- `with_source_rect(src) + with_destination_rect(0,0,w_px,h_px) + with_scales_to_fit(false)` applied to the stream config when source_rect is Some.
- 3 region-math unit tests (2×, 1×, 1.5× scales) run without TCC — the helper is split out of `build_filter` exactly so tests are hardware-free.

### Task 2 — Windows WGC post-capture CPU crop + Criterion bench
- `PhysicalRectU32` + stride-aware `cpu_crop_bgra(src, w, h, stride, rect) -> Option<Vec<u8>>` in `frame_from_wgc`. 5 unit tests: 1×1 edge, origin full-width, padded-stride alignment, overflow → None, zero-size → None.
- `crop_rect` threaded through `WgcFlags` → `WgcHandler` → `on_frame_arrived`. After `to_frame` produces the nopadding buffer, crop runs row-by-row before emit; overflow drops the frame and bumps the drop counter (defence-in-depth; IPC validation already rejects out-of-bounds rects before we get here).
- `CaptureTarget::DisplayRegion` arm in `start()` resolves the display via `enumerate_displays` and scales logical → physical pixels via `disp.scale_factor`. WGC itself still captures the full primary monitor (no native region API — RESEARCH Pitfall 5); the crop is Rust-side.
- **Criterion bench** at `crates/capture/benches/windows_cpu_crop.rs` — 1080p→720p + 1080p full-frame. The bench compiles to an empty `main` on non-Windows hosts so every developer can `cargo bench --no-run` without a Windows toolchain; the real <5ms gate runs on the actual Windows runner as part of Task 6 human-verify (deferred to operator — see Known Stubs below).

### Task 3 — Region overlay window + TargetPicker hook
- New Tauri window via `WebviewWindowBuilder` with `transparent=true + decorations=false + fullscreen=true + always_on_top=true + skip_taskbar=true` — the standard screenshot-tool overlay shape. Window URL points at `/region-overlay?display_id=…` in the main webview bundle (createBrowserRouter route).
- `RegionOverlay.tsx` — drag-to-draw rect with live dimensions badge and "Drag · Enter confirm · Esc cancel" affordance. On commit/cancel emits `region://selected` to the main window and calls `getCurrentWebviewWindow().close()`; the overlay disposes itself.
- `TargetPicker` gets optional `onOpenRegion` prop — renders a subtle "Crop to region…" underline button ONLY when the selected target is a Display (D-05); hidden for window/PlaywrightAuto.
- `recording-view.tsx` listens for `region://selected` and promotes the recorder's captureTarget to a `display_region` variant on confirm.

### Task 4 — LaunchConfig.args + Playwright `--app` passthrough
- `LaunchConfig` gains `#[serde(default)] args: Vec<String>`. `from_meta` checks `STORYCAPTURE_CHROME_HIDING=1` env var AND validates `meta.app` starts with `http(s)://` before pushing `--app=<url>` to args. 6 unit tests: default empty, backwards-compat deserialize without field, chrome-hiding on/off, and `javascript:` URL rejection.
- `PlaywrightSidecarDriver::launch` forwards the args array to the sidecar JSON-RPC `launch` verb.
- `server.mjs` spreads `args` into `launchOpts.args`. **Critical `--app` caveat from RESEARCH Pitfall 6:** when `--app=<url>` is in the args, Chromium already opens the URL as an initial app-mode page; calling `context.newPage()` would spawn a stray `about:blank`. Sidecar now reuses `context.pages()[0]` when it exists (the typical path) and only calls `newPage()` defensively if the context has no pages.
- `server.test.mjs` — 2 new vitest cases: `--app=` reuse (launch + follow-up goto verbs succeed against the reused page) + backwards-compat launch-without-args field.
- Host `launch_automation` gains `chrome_hiding: Option<bool>` param; pre-parses the story to extract `meta.app`, validates via `url::Url::parse()` with `http|https` scheme allow-list (T-06-09), then flips the env var. Non-sticky — the recorder's Zustand store resets chromeHiding to `false` every run.

### Task 5 — Cursor toggle through CaptureConfig
- `StartRecordingArgs.include_cursor: Option<bool>` (default `Some(true)` preserves Phase 5 D-06 behavior). Threaded into `CaptureConfig`.
- SCK's `with_shows_cursor(cfg.include_cursor)` was already dynamic from Phase 5. WGC's hardcoded `CursorCaptureSettings::WithCursor` is now a match on `cfg.include_cursor` → `WithCursor | WithoutCursor`.
- `CursorToggle` + `ChromeHidingToggle` Base-UI-style switch components. `ChromeHidingToggle` greys out when the active browser preset isn't Chromium-family via the new `isChromiumFamily()` helper in `features/settings/browser-presets.ts` (covers chromium/chrome/msedge/brave/arc + exec-path basename heuristic).
- Zustand `recorder` state: `includeCursor` (default true) + `chromeHiding` (default false). Both reset in `reset()` = non-sticky per D-19/D-20 (cursor) and D-10 (chrome-hiding).

### Task 6 — Human-verify checkpoint (AUTO-APPROVED per chain flag)

Operator manual verification is **pending** — documented below in **Operator Verification Runbook**. Auto-mode was active, so the executor stub-approved this gate and logged the TODO to this SUMMARY. No manual test run has confirmed the macOS/Windows end-to-end flows yet.

## Deviations from Plan

### None required (Rule 1–3)
The plan file and RESEARCH amendments covered the Windows no-native-region gotcha (D-07 amendment), the Chromium `--app` single-page reuse (Pitfall 6), and the SCK point/pixel scale (Pitfall 7) explicitly. Implementation matched all three without surprises.

### Auto-approved checkpoint (Rule: auto-mode active)
Task 6 is a `checkpoint:human-verify` — in standard mode the executor would have stopped and returned to an operator. With `workflow.auto_advance=true` and the chain-flag set, the executor auto-approved per the Execution Rules in the prompt. This SUMMARY flags the outstanding manual work.

## Operator Verification Runbook

**These steps were NOT run by the executor. An operator on macOS and a Windows runner must complete them before 06-02 is considered production-ready.**

### macOS (TCC-granted host)
1. `pnpm --filter @storycapture/desktop tauri:dev` → open recorder view.
2. Select a Display target → "Crop to region…" link appears → click.
3. Transparent overlay covers the chosen display. Drag a ~640×480 rect; live dimensions badge updates.
4. Esc → overlay dismisses, no region applied. Re-open, Enter → overlay dismisses, toast "Region set: 640×480 on display N" appears.
5. Record 3s → output MP4 dimensions are exactly `rect.w × point_pixel_scale × rect.h × point_pixel_scale`. Verify via `ffprobe -show_streams`.
6. Set BrowserRow preset to Chrome → `ChromeHidingToggle` enables → turn ON → record. Output MP4 has no tab bar / URL bar / forward-back buttons. OS title bar IS visible (expected per D-12).
7. Change BrowserRow to "firefox" (or any non-Chromium) → toggle disables/greys out.
8. Turn `CursorToggle` OFF → record → output MP4 has no cursor. Close and reopen recorder view → toggle is back ON (non-sticky).

### Windows (real-capture-windows host)
9. Repeat steps 2–6 on Windows. Region output MP4 matches the drawn rect's physical pixels (logical × DPI scale).
10. `cargo bench -p capture --bench windows_cpu_crop` → confirm `cpu_crop_bgra_1080p_*` mean <5ms on reference hardware. **If >5ms, file a follow-up issue with the measured number** and consider rayon row-parallel. The plan explicitly treats the bench as a perf note, not a correctness block.
11. Repeat step 8 on Windows — WGC produces cursor-less frames when `CursorCaptureSettings::WithoutCursor` is dispatched.

## Chrome-hiding integration note
The `context.pages()[0]` reuse path works cleanly in theory (RESEARCH Pitfall 6 fix) and is covered by one new vitest assertion, but the test verifies only that subsequent verbs succeed — it doesn't introspect `state.context.pages().length`. A stricter assertion could shim Playwright's `newContext` to count `newPage` calls; deferred as the current coverage is sufficient for the common path.

## Windows CPU-crop bench result
**Pending operator measurement on actual Windows hardware.** The bench is written, compiles on macOS dev hosts, and is ready to run. No number recorded yet.

## Upstream issue on `windows-capture` native region
Not filed. If 06-02 operator verification shows the CPU-crop path stays green, a follow-up task can open an upstream feature request at [NiiightmareXD/windows-capture](https://github.com/NiiightmareXD/windows-capture/issues) for SDK `GraphicsCaptureSession.CreateCaptureItemForWindow` + cropped capture item. Low priority — CPU crop will remain the shipped path for v1 regardless.

## Known Stubs

- **Task 6 operator verification** — auto-approved; 11 checklist items above need human eyes on real hardware. Tracked here explicitly so a verifier catches it.
- **Windows bench number** — bench compiles but hasn't been run on Windows. The <5ms gate is aspirational until measured.

## Self-Check: PASSED

**Commits verified:**
- `498b3b4` feat(capture): 06-02-T00..T01 DisplayRegion + SCK source_rect ✓
- `4376cb1` feat(capture): 06-02-T02 WGC CPU crop + bench ✓
- `83065ab` feat(desktop): 06-02-T03 region overlay + TargetPicker ✓
- `60e8d98` feat(automation+desktop): 06-02-T04..T05 chrome-hiding + cursor toggles ✓
- `cdd4865` feat(capture): 06-02-T05 WGC cursor routing ✓

**Files verified present:**
- `crates/capture/benches/windows_cpu_crop.rs` ✓
- `apps/desktop/src-tauri/src/commands/region_overlay.rs` ✓
- `apps/desktop/src/features/capture/RegionOverlay.tsx` ✓
- `apps/desktop/src/features/recorder/CursorToggle.tsx` ✓
- `apps/desktop/src/features/recorder/ChromeHidingToggle.tsx` ✓
- `apps/desktop/src/features/settings/browser-presets.ts` ✓

**Automated tests green:**
- `cargo test -p capture --lib` — 24 passed, 0 failed
- `cargo test -p automation --lib launch_config` — 6 passed, 0 failed
- `cargo check -p storycapture` — clean (warnings only in pre-existing audio code)
- `pnpm typecheck` in apps/desktop — clean
