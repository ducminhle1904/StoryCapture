# Phase 6 Cleanup Backlog

Generated from `/simplify` review (code-reuse + quality + efficiency agents) after all four 06-xx plans landed. Findings sorted by severity. Nothing here blocks shipping — the code is correct for the demonstrated use cases. Items are ranked by correctness risk × fix cost.

---

## BLOCKER — fix before first production build

### 1. Env-var IPC between host and `automation` crate is racy

**Locations:**
- `apps/desktop/src-tauri/src/commands/automation.rs` — sets `STORYCAPTURE_CHROME_HIDING=1` and `STORYCAPTURE_BROWSER_PATH=<path>` as process-global state
- `crates/automation/src/driver.rs::LaunchConfig::from_meta` — reads them back

**Problem:** `std::env::set_var` is `unsafe` in Rust 1.80+ (concurrent readers can fault). Two concurrent `launch_automation` invocations stomp each other. The tests at `driver.rs:298–324` even admit this (`Serial env-var manipulation — cargo test runs in threads`).

**Fix:** thread config as a parameter instead of via env vars.
```rust
// Preferred shape
pub struct LaunchOptions {
    pub chrome_hiding: bool,
    pub executable_override: Option<PathBuf>,
}
LaunchConfig::from_meta(meta: &Meta, opts: &LaunchOptions)
```
Migrate both env vars into the struct. Delete the `std::env::set_var` calls in `launch_automation`.

**Test impact:** `LaunchConfig::from_meta` unit tests need `LaunchOptions` fixtures. Low risk; contained.

---

## MAJOR — real perf/correctness issues, worth a dedicated PR

### 2. WGC `on_frame_arrived` allocates per-frame (~240MB/s churn @ 1080p30)
**Location:** `crates/capture/src/windows/frame_from_wgc.rs:169`

`let mut bgra = vec![0u8; stride * height_px as usize];` runs every frame. At 1920×1080×4 = ~8MB × 30fps = **240MB/s of allocator churn on Windows captures**.

**Fix:** pool buffers in `WgcHandler` state. Swap out via `std::mem::take` into the emitted `Frame`, or keep a small ring of reusable buffers. The crop path (line 63) needs the same treatment — separate `crop_out` buffer owned by the handler.

### 3. Thumbnail re-enumerates displays every 2s (Windows)
**Locations:**
- `crates/capture/src/windows/thumbnail.rs:129`
- `crates/capture/src/windows/wgc_backend.rs:327`

Every thumbnail refresh calls `enumerate_displays()` (full xcap system walk) just to resolve the region's `scale_factor`. With `refetchInterval: 2000` active, this is a full display enumeration every 2s.

**Fix:** cache `scale_factor` per `DisplayId` in a `OnceLock<HashMap>` with TTL, or precompute `PhysicalRectU32` at `setCaptureTarget` time and cache on the DTO.

### 4. Windows thumbnail BGRA→RGBA loop is per-pixel
**Location:** `crates/capture/src/windows/thumbnail.rs:264–267`

`extend_from_slice(&[px[2], px[1], px[0], px[3]])` per pixel — ~2M iterations for a 1920×1080 source, with per-push bounds checks. **Fix:** `rgba.resize(n, 0)` then `chunks_exact_mut(4).zip(chunks_exact(4))` for a single-pass swap in pre-sized buffer. Or check if `image::codecs::png::PngEncoder` supports `ExtendedColorType::Bgra8` directly to skip the swap entirely.

### 5. Thumbnail busy-polls with 10ms sleep
**Location:** `crates/capture/src/windows/thumbnail.rs:215–223`

Spin loop checks a `Mutex` ~100×/sec while waiting for the one frame. Wastes a `spawn_blocking` worker. **Fix:** `tokio::sync::oneshot` inside `ThumbFlags`, signalled from `on_frame_arrived`. `spawn_blocking` owner awaits via `blocking_recv` with timeout.

### 6. Duplicated thumbnail PNG-encode paths (macOS vs Windows)
**Locations:**
- `crates/capture/src/macos/screenshot.rs:104–141::encode_cg_image_to_png`
- `crates/capture/src/windows/thumbnail.rs:246–301::encode_bgra_to_png`

~95% identical: pick min-scale / clamp-upscale / `image::imageops::resize` / PNG encode. Only the pixel-format pre-step differs. **Fix:** extract `fn encode_rgba_to_png(rgba, src_w, src_h, max_w, max_h)` into `crates/capture/src/thumbnail.rs` (already exists as the module). Platform files keep only their format-specific prologue.

### 7. Duplicated logical→physical rect scaling (Windows)
**Locations:** `crates/capture/src/windows/wgc_backend.rs:314–342` and `thumbnail.rs:124–146` — byte-identical blocks.

**Fix:** extract `pub fn resolve_region_to_physical(target: &CaptureTarget) -> Result<Option<PhysicalRectU32>, CaptureError>` in `windows/frame_from_wgc.rs`. Both callers collapse to one line.

### 8. Story parsed twice in `launch_automation`
**Location:** `apps/desktop/src-tauri/src/commands/automation.rs:87–136`

`story_parser::parse(&story_source)` runs once to extract `meta.app` for URL validation, then again at line 118 for the executor. The comment even admits it. Not a bottleneck today but wrong on principle. **Fix:** parse once, derive both the URL gate and the executor input from the one AST.

### 9. Hand-mirrored browser-preset tables (TS + Rust)
**Locations:**
- `apps/desktop/src/features/recorder/title-hints.ts`
- `apps/desktop/src-tauri/src/title_hints.rs`
- `apps/desktop/src/features/settings/browser-presets.ts` (partial overlap)

Three hand-maintained tables of 10 presets × {title-substring, basename fragment, is-chromium-family}. Will drift.

**Fix options:**
- **(a)** Rust owns the canonical table; expose `title_hint_for(preset)` + `is_chromium_family(preset)` as IPC commands.
- **(b)** TS computes the hint and passes it to Rust in `StartRecordingArgs`; Rust never looks it up.
- **(c)** Shared JSON in `packages/shared-types/`; build-time codegen for both sides.

(b) is the lightest-touch fix. Pick one and delete the other two copies.

---

## MINOR — polish items, batch into a cleanup PR when convenient

### 10. Bitrate clamp semantics are confusing
**Location:** `crates/encoder/src/config.rs:130`

`((pixels / 1000) as u32).clamp(self.bitrate_kbps, 40_000)` uses `bitrate_kbps` as the *lower* bound. So `bitrate_kbps` isn't a bitrate — it's a floor. 4K recordings cap at 12Mbps (the floor), which is low quality for 4K. Either rename the field (`bitrate_floor_kbps`) or fix the formula so higher-resolution targets push above the floor.

### 11. `TargetThumbnail` triple-bookkeeps the object URL
**Location:** `apps/desktop/src/features/recorder/TargetThumbnail.tsx:72–92`

`useMemo` + `urlRef` + `useEffect` all track the blob URL. React's cleanup function already handles this cleanly. **Fix:** single `useEffect([data])` that creates the URL and returns a cleanup closure that revokes it.

### 12. `setCaptureTarget` no same-value guard
**Location:** `apps/desktop/src/state/recorder.ts:205`

Every call does an IPC round-trip + zustand `set`, even when the target is unchanged. **Fix:** short-circuit on `captureTargetKey(prev) === captureTargetKey(next)`.

### 13. `refreshPlaywrightAvailability` keeps polling after hit
**Location:** `apps/desktop/src/features/recorder/recording-view.tsx:398–404`

10s busy-poll runs to completion even after the pid becomes available. **Fix:** break on first `isAvailable === true`.

### 14. `slot_for_poll` and audio drain thread busy-loop
- Thumbnail `slot_for_poll` (10ms sleep × ~100/s) — see #5
- Audio drain `thread::sleep(2ms)` at `crates/capture/src/audio/stream.rs:282` — 500 wake-ups/sec. Harmless on desktop, measurable on battery.

### 15. `StartRecordingArgs` parameter sprawl
**Location:** `apps/desktop/src-tauri/src/commands/encode.rs:254–271`

`audio_device_id`, `include_cursor`, etc. added as flat fields over time. `DisplayRegion` target isn't represented; only `display_id: u64`. **Fix:** replace `display_id` with `target: CaptureTargetDto` and group per-recording flags into `RecordingOptions { include_cursor, audio, chrome_hiding }`.

### 16. Empty `try { ... } catch {}` blocks
**Location:** `apps/desktop/src/features/recorder/RegionOverlay.tsx:63, 68`

Swallowing with a "non-fatal" comment is not OK when the failure is "overlay stuck open." At minimum `console.warn`. Better: propagate and let the caller decide.

### 17. Dead code
- `crates/encoder/src/config.rs:21` `AudioFormat::S16LE` variant (comment: "not currently produced")
- `apps/desktop/src-tauri/src/commands/encode.rs:618` `fn _silence_unused_output_path`
- Several `#[allow(dead_code)]` fields without "kept for RAII" justification

Delete or document.

### 18. No shared `getAppSettings` IPC wrapper
**Location:** `apps/desktop/src/features/recorder/recording-view.tsx:132` and `apps/desktop/src/features/settings/BrowserRow.tsx:38` both `invoke<AppSettings>("get_app_settings")` inline. **Fix:** add `apps/desktop/src/ipc/app-settings.ts` with `getAppSettings()` wrapper matching the `ipc/audio.ts` / `ipc/capture.ts` pattern.

---

## NIT — optional polish

### 19. Task-id references in source
Dozens of comments reference `D-XX`, `T-06-XX`, `Plan 06-0X`, `RESEARCH Pitfall N`. These rot after milestone archival. Move to commit messages / SUMMARY.md. Keep only non-obvious WHY-comments in code.

### 20. WHAT-narrating module headers
Multiple files carry 15–40 line module-header block comments narrating what the module does. Well-named identifiers + types already do that. Condense to a 5-line doc block max. Keep load-bearing WHYs (e.g., the `cpal#970` warning in `audio/stream.rs`).

Files with verbose-narrating headers that could be trimmed: `encoder/config.rs`, `capture/audio/stream.rs`, `recorder/title-hints.ts`, `recorder/TargetThumbnail.tsx`, `commands/encode.rs`.

### 21. `uuid_like()` reimplements uuid-v4 from `SystemTime`
**Location:** `crates/capture/src/audio/fifo.rs:126`

The `uuid` crate is already in the workspace deps. One-line swap: `uuid::Uuid::new_v4().simple().to_string()`.

### 22. `RecorderState` non-sticky type-omit list duplicates action names
**Location:** `apps/desktop/src/state/recorder.ts:117–135`

`Omit<RecorderState, "setStatus" | "setSession" | ...>` enumerates every action by name. Adding an action means editing two places. **Fix:** split into `RecorderData` (fields) + `RecorderActions` (fns); `INITIAL: RecorderData`.

### 23. Magic-string sentinels in `AudioDevicePicker`
**Location:** `apps/desktop/src/features/recorder/AudioDevicePicker.tsx:51`

`"__no_audio__"`, `"__loading__"`, `"__empty__"` — three parallel magic strings used as Select values. **Fix:** discriminated union `AudioPickerChoice = { kind: "none" | "default" | "device", id?: string }`.

---

## Clean areas (explicitly verified)

- `cpal` callback is allocation-free; uses `push_slice` on `ringbuf::HeapRb::Producer` only ✓
- `HeapRb` sizing at 2-second capacity ✓
- `TargetThumbnail` disables `refetchInterval` during recording ✓
- `fifo_path.exists()` TOCTOU check is NOT present — drain thread just `open()`s ✓
- `resolve_sidecar_path` reused in `commands/automation.rs:171` ✓
- `STORYCAPTURE_CHROME_HIDING` env-gate pattern-mirrors existing `STORYCAPTURE_BROWSER_PATH` — consistent but both share the BLOCKER at #1
- `RegionRect::validate` lives once, called at IPC boundary ✓
- `EncodeConfig::with_audio` builder-style, not new `::new` param ✓
- `audio/mod.rs` layering is clean: encoder takes `AudioInput { fifo_path, … }` without knowing cpal exists ✓
- Specta DTO + `.typ::<>()` registration matches Phase 5 conventions ✓
- Security mitigations from plan threat models are wired (T-06-08 region rect validation, T-06-09 URL validation, T-06-17 title PII redaction) ✓

---

## Recommended order of attack

1. **#1 (env-var race)** — do this before first public build. Contained, ~1 day.
2. **#2 (WGC per-frame alloc)** — real perf win, measurable. ~half-day.
3. **#9 (title-hint table triplication)** — prevents drift. ~2 hours.
4. **#6 + #7 (thumbnail code dedup)** — ~2 hours, low risk.
5. Bundle #10–#18 into one "Recording polish" sweep.
6. #19–#23 whenever. No one will die if these slip.

**Approximate total effort:** 3–4 days for BLOCKER + MAJOR. Another 1–2 days for the MINOR sweep.

---

*Generated 2026-04-17 via `/simplify double check phase 6` after all 22 06-xx tasks landed.*
