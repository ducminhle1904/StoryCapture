# Phase 6: Recording v2 — audio, region, chrome-hiding, multi-browser, live preview — Research

**Researched:** 2026-04-17
**Domain:** Rust audio capture (cpal), SCK region + screenshot, windows-capture region, Playwright multi-browser + `--app`, Windows E2E CI
**Confidence:** HIGH on cpal/SCK APIs, HIGH on Playwright channels, MEDIUM on Windows region (crate lacks native support), LOW on Windows-runner-in-CI economics
**Mode:** ecosystem + implementation (prescriptive)

## Summary

All four plans under D-24 are feasible, but **one locked decision (D-07) needs amendment**: `windows-capture = 2.0.0` does **not** support native region/crop capture. Its `Settings` struct exposes `DirtyRegionSettings` only as a frame-update-optimization hint — there is no `sourceRect` / `crop` / `bounds` API. On Windows we must either (a) capture the full display and crop per-frame in Rust before pushing to FFmpeg, or (b) capture the specific window and accept that "region" means "the whole window" on Windows for v1. The macOS side is clean: SCK 1.5.4's `SCStreamConfiguration::with_source_rect(CGRect)` + `with_destination_rect(CGRect)` + `with_scales_to_fit(bool)` implement D-07 exactly, and `SCContentFilter::set_content_rect(CGRect)` is available on macOS 14.2+ as a secondary path.

Audio capture (06-01) is the biggest risk. `cpal = 0.17.3` exists and is current (published 2026-02-18), but the 0.16→0.17 bump is a breaking change: `DeviceTrait::build_input_stream*` now takes `StreamConfig` by value, and a new `StreamError::StreamInvalidated` variant fires when Windows default-device routing changes mid-capture. Cross-thread communication from inside the cpal callback on Windows WASAPI has a well-known silent-failure mode ([cpal#970](https://github.com/RustAudio/cpal/issues/970)) — use an `Arc<parking_lot::Mutex<ringbuf>>` owned outside the callback, and drain from a dedicated std thread into the tokio channel. Tauri sidecars **cannot** pipe beyond stdin/stdout/stderr (fd 0/1/2) — FFmpeg `pipe:3` is not an option; audio muxing must use a named pipe (mkfifo / Windows named pipe) or a temp file, with the named-pipe path preferred for live muxing.

Multi-browser auto-follow (06-03) is cheap: Playwright's `chromium.launch({ channel: 'msedge' | 'chrome' | 'chrome-beta' | 'chrome-canary' | 'chromium' })` is the canonical API and aligns with the existing `executable`/`channel` branch in `server.mjs`. Title-hint map is a 5-line config. `SCScreenshotManager` ships in `screencapturekit = 1.5.4` at `screencapturekit::screenshot_manager::SCScreenshotManager` with both `capture_image()` (CGImage) and `capture_sample_buffer()` (CMSampleBuffer) — live preview thumbnails are a dozen lines of code.

Windows E2E CI (06-04) has no clean "free" path in 2026: GitHub-hosted `windows-latest` runners don't provide a real interactive graphical session, and headless+graphical-less WGC capture is an open bug. Self-hosted runners with a logged-in desktop session are the only viable path for real-capture smoke tests. Given D-23's explicit allowance ("if no runner available, ship workflow stub + manual test script"), 06-04 should plan for the stub-with-manual-test path and flag operator-provisioned runner as a follow-up.

**Primary recommendation:** Ship 4 plans per D-24, but re-scope 06-02's Windows region path to "capture full display + CPU crop" (not "native WGC region API"). Use cpal 0.17.3 with the documented Windows-callback ringbuf workaround. Use a named pipe (fifo) for FFmpeg audio muxing — the only cross-platform path that works through Tauri's sidecar model.

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Microphone audio only in this phase — no system audio
- **D-02:** Opt-in at recording start, not sticky, default off
- **D-03:** Use `cpal` crate for mic capture, mux with FFmpeg at encode time — NOT SCK audio (pyobjc #647)
- **D-04:** Audio device picker next to Target dropdown; default = system-default input; "No audio" always present
- **D-05:** Region is always relative to a display (not a window); user draws a rect
- **D-06:** Region stored as `(display_id, x, y, w, h)` in logical pixels
- **D-07:** Use SCK `SCContentFilter` + content rect + `scale_content_to_fit` on macOS; WGC crop rect on Windows — **NEEDS AMENDMENT**: windows-capture 2.0 lacks native region API
- **D-08:** Picker flow: select Display → "Crop to region..." → transparent fullscreen overlay
- **D-09:** Use Chromium's `--app=<url>` launch flag; drops tab bar + URL bar + back/forward
- **D-10:** Off by default; toggle in recorder; StoryCapture passes `--app=<meta.app>` through Playwright
- **D-11:** Chrome-hiding toggle disabled when browser is not Chromium-family
- **D-12:** OS title-bar suppression is v3 territory
- **D-13:** Per-browser `title_hint` map: `chromium → "Chromium"`, `msedge → "Microsoft Edge"`, `chrome → "Google Chrome"`, etc.
- **D-14:** Hint selection driven by existing `BrowserRow` preset
- **D-15:** Fallback to "any window owned by the Playwright pid" if title match fails
- **D-16:** Live preview = static frame, refresh every 2s
- **D-17:** Use `SCScreenshotManager.captureImage(contentFilter:configuration:)` — cached per tick
- **D-18:** No continuous live-streaming preview (v3)
- **D-19:** Cursor toggle defaults to "include cursor"
- **D-20:** Cursor toggle not sticky — reset each recording
- **D-21:** Windows E2E runs on self-hosted graphical Windows runner, `workflow_dispatch` + label `needs-windows-e2e`
- **D-22:** Test matrix: display + window happy paths, 3s MP4 verification
- **D-23:** Stub + manual test script acceptable if no runner available
- **D-24:** 4 plans: 06-01 (audio), 06-02 (region + chrome-hiding + cursor), 06-03 (multi-browser + preview + title-hints), 06-04 (Windows CI)

### Claude's Discretion

- Audio codec / bitrate defaults (AAC 128kbps mono starting point)
- Region-selection UX micro-details (keyboard shortcuts, magnifier, snap-to-pixel)
- Live-preview refresh cadence (tune 1–5s based on SCScreenshotManager cost)
- Chromium `--app` URL source when `meta.app` is a relative path

### Deferred Ideas (OUT OF SCOPE)

- System audio capture (BlackHole / virtual device — separate phase)
- Live-streaming preview (continuous frames) — v3
- Multi-window composition — Phase 2 territory
- Windows ARM64 capture — separate phase
- Safari / Firefox chrome-hiding — no equivalent flag exists
- OS title-bar suppression on captures — v3
- Cursor visual overlay effects — Phase 2 (post-production)
- Per-story audio settings persistence — matches D-20 cursor logic

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PHASE-6.1 | Microphone capture opt-in + FFmpeg mux | §Standard Stack (cpal), §Architecture Patterns (cpal→fifo→ffmpeg), §Pitfalls (cpal#970, pipe:3 limit) |
| PHASE-6.2 | Region capture + chrome-hiding + per-recording cursor toggle | §Architecture Patterns (SCK source_rect), §Don't Hand-Roll (WGC region workaround), §Code Examples (overlay + `--app`) |
| PHASE-6.3 | Multi-browser auto-follow + live preview thumbnail + Edge/Brave hints | §Standard Stack (Playwright channels), §Code Examples (SCScreenshotManager) |
| PHASE-6.4 | Windows real-capture E2E CI | §Architecture Patterns (self-hosted runner + manual-test fallback) |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Mic device enumeration | `crates/capture` (new `audio/` submodule) | Tauri IPC command `list_audio_inputs` | `cpal` lives in Rust; UI consumes DTO list |
| Mic capture stream | `crates/capture::audio` | pipeline bridge → named-pipe writer | Sync cpal callback → std thread → async drain task |
| Audio/video mux | `crates/encoder` | FFmpeg sidecar (2nd `-i` from fifo) | Encoder knows FFmpeg args; fifo path passed in |
| Region rect math | `crates/capture::target` (enum variant) | SCK `with_source_rect` / WGC crop-in-Rust | Rect is backend-private; UI sends `(display_id, x, y, w, h)` |
| Region selection overlay | React + Tauri fullscreen transparent window | Zustand slice | UX-tier; emits rect back via IPC |
| Chromium `--app` flag | `crates/automation` (extend `LaunchConfig`) | sidecar `launch` handler (append to args) | Launch-config owner; sidecar is thin pass-through |
| Title-hint map | `apps/desktop` recorder state | auto-follow command layer | Frontend-known preset → backend-consumed hint |
| Live preview thumbnail | Tauri command (SCK `SCScreenshotManager`) | React img src (data URL) | Native-only capability; UI renders bytes |
| Windows E2E workflow | `.github/workflows/*.yml` + runner label | Cargo test gated by `real-capture-windows` | CI infra; reuses existing real-capture feature flag |

## Standard Stack

### New Crates for Phase 6

| Crate | Pinned Version | Purpose | Why Standard | Provenance |
|-------|---------------|---------|--------------|------------|
| `cpal` | **=0.17.3** | Cross-platform audio input stream (mic) | Canonical Rust audio I/O; actively maintained (2026-02-18 release); used by rodio, coreaudio-rs ecosystem | [VERIFIED: crates.io API — max 0.17.3 published 2026-02-18] |
| `ringbuf` | **=0.4.8** | Lock-free SPSC ring buffer for cpal callback → drain thread | The cpal examples use ringbuf; SPSC fits single-callback-single-drain exactly | [VERIFIED: crates.io API — max 0.4.8 published 2025-12-25] |
| `rubato` | **=0.16.2** (already pinned? verify) | Sample-rate conversion if mic default != 48kHz | Pure-Rust, high-quality resampling; `rubato = 0.16` paired with cpal is common; NEW 2.0.0 available but 0.16 is more battle-tested | [VERIFIED: crates.io API — 2.0.0 available 2026-04-01, **recommend pinning 0.16.x** for 1 cycle] |
| `core-foundation` | existing | CGRect for SCK source_rect | Already in Cargo.toml; CGRect is FFI-stable | [VERIFIED: Cargo.toml] |

### Version verification (2026-04-17 via crates.io API)

```bash
npm view / cargo search equivalent: checked crates.io API directly
- cpal 0.17.3 — published 2026-02-18 [VERIFIED]
- ringbuf 0.4.8 — published 2025-12-25 [VERIFIED]
- rubato 2.0.0 (latest) / 0.16.x (recommended) — 2.0.0 published 2026-04-01 [VERIFIED]
- hound 3.5.1 — last release 2023-09-25 (NOT recommended as primary; cpal gives us what we need)
- screencapturekit 1.5.4 (already pinned) — SCScreenshotManager confirmed present
- windows-capture 2.0.0 (already pinned) — NO native region support confirmed
- playwright-core: channel list confirmed includes chromium / chrome / chrome-beta / chrome-dev / chrome-canary / msedge / msedge-beta / msedge-dev
```

### Installation

```toml
# crates/capture/Cargo.toml
cpal = "=0.17.3"
ringbuf = "=0.4.8"
rubato = "=0.16"  # pin 0.16.x; skip 2.0.0 until it's had >1 cycle
```

No new Node deps for Playwright side — `playwright-core` already bundled supports all target channels.

### Alternatives Considered

| Instead of | Could Use | Rejected Because |
|------------|-----------|------------------|
| `cpal 0.17.3` | `coreaudio-rs` (macOS only) + `wasapi` (Windows only) directly | Splitting macOS/Windows doubles maintenance; cpal already wraps both; pyobjc issue is SCK-audio-specific, not CoreAudio-generic |
| `cpal` ring-buffer pattern | Bare `tokio::sync::mpsc::Sender::try_send` from callback | [cpal#970](https://github.com/RustAudio/cpal/issues/970) — on Windows WASAPI, callback silently stops firing when it uses cross-thread-communication primitives. Ringbuf + external drain thread is the documented workaround. |
| FFmpeg `pipe:3` for audio | Named pipe (fifo on Unix, `\\.\pipe\name` on Windows) | Tauri `tauri-plugin-shell` only exposes stdin/stdout/stderr; extra fds are not plumbed ([VERIFIED: `tauri-plugin-shell` 2.x docs + `CommandChild` has no fd accessor]). Named pipe works everywhere. |
| Named pipe | Temp WAV file + post-mux | Real-time A/V drift grows as recording duration increases; temp-file path requires a second FFmpeg pass. Named-pipe live mux is industry-standard. |
| Hand-roll region overlay | Tauri fullscreen-transparent new-window | Already have a modal-overlay pattern in codebase (per CONTEXT.md "overlay window pattern already exists"). Reuse. |
| Native WGC region | CPU crop after capture (`image::imageops::crop_imm` or stride-aware slice) | `windows-capture = 2.0.0` has no region/crop/sourceRect API ([VERIFIED: docs.rs 2.0.0 Settings struct — only cursor/border/DirtyRegion/update-interval/secondary-window/color-format/flags]). Until upstream adds it, CPU crop is the only path. |
| `rubato` for SRC | Static 48kHz config in cpal + let FFmpeg resample | cpal device enumeration returns device-native rates; enforcing 48kHz at cpal level may fail on exotic devices. Rubato inside our pipeline is safer; alternatively FFmpeg `-af aresample=48000` handles device→48k. Planner picks based on device-rate variance. |

## Architecture Patterns

### System Architecture Diagram — Audio Mux (06-01)

```
            cpal input callback (sync, GCD/WASAPI thread)
            │ writes f32 samples
            ▼
    SPSC ringbuf::HeapRb<f32> (lock-free, 2-second capacity)
            │ push_slice
            ▼
    Dedicated std::thread (spawned before cpal::Stream::play)
            │ loop { ringbuf.pop_slice(&mut buf); write_to_fifo(&buf); }
            ▼
    Named pipe (mkfifo on Unix / NamedPipe on Windows)
            │
            ▼
    FFmpeg -f f32le -ar <rate> -ac <channels> -i <fifo_path> \
           -f rawvideo -pix_fmt bgra ... -i pipe:0 \
           -map 0:v -map 1:a ... output.mp4

Meanwhile (independent):
    capture::Frame mpsc ──► EncodePipeline ──► FFmpeg stdin (pipe:0)

Video and audio arrive on TWO separate fds (stdin + fifo).
FFmpeg interleaves by timestamp (PTS on video, sample-counter on audio).
```

### System Architecture Diagram — Region + Chrome + Cursor (06-02)

```
User flow:
  [Recorder UI] → select Display → click "Crop to region..."
        │
        ▼
  [Tauri command: open_region_overlay(display_id)]
        │ creates fullscreen transparent window
        ▼
  [Overlay React: drag-to-draw rect, Esc=cancel, Enter=confirm]
        │ emits (display_id, x, y, w, h) in logical pixels
        ▼
  [CaptureTarget::DisplayRegion { display_id, rect }] added to enum
        │
        ▼
  macOS path: SCStreamConfiguration::new()
                .with_source_rect(CGRect{ origin, size })   ← the rect
                .with_destination_rect(CGRect{ 0,0,w,h })
                .with_scales_to_fit(false)
                .with_width(w_px) .with_height(h_px)

  Windows path: WgcBackend captures full display,
                then frame-crop in Rust before emit:
                  bgra_bytes_slice_rect(frame, rect) → Frame{ w: rect.w, h: rect.h }
                (post-capture CPU crop; documented limitation, tracking upstream)

Chrome-hiding:
  LaunchConfig.args.push("--app={url}")  where url = meta.app
  → sidecar launch handler appends to playwright.launchServer opts.args
  → Chromium opens a single app-mode window (no tab bar / URL bar)
  Note: disabled in UI unless selected Browser preset is Chromium-family (D-11)

Cursor toggle:
  CaptureConfig.include_cursor is already plumbed (Phase 5).
  UI: add Switch component; reset to default=true each recording (D-20).
```

### System Architecture Diagram — Multi-browser + Live Preview (06-03)

```
┌──────────────────────┐
│  BrowserRow preset   │  chromium | chrome | msedge | brave | chrome-canary
└──────────┬───────────┘
           │ writes to app_settings.json
           ▼
┌──────────────────────────────────────────────────────┐
│ TITLE_HINT_MAP: {                                    │
│   chromium:       "Chromium",                        │
│   chrome:         "Google Chrome",                   │
│   "chrome-beta":  "Google Chrome Beta",              │
│   "chrome-dev":   "Google Chrome Dev",               │
│   "chrome-canary":"Google Chrome Canary",            │
│   msedge:         "Microsoft Edge",                  │
│   "msedge-beta":  "Microsoft Edge Beta",             │
│   brave:          "Brave Browser",                   │
│   arc:            "Arc",                             │
│ }                                                    │
└──────────┬───────────────────────────────────────────┘
           │
           ▼
CaptureTarget::WindowByPid{ pid, title_hint: MAP[preset] }
           │
           ▼
find_window_by_pid (Phase 5.3 code) — title_hint narrows multi-window match

───────────────────────────────────────────────

Live preview (in Recorder view, between Target dropdown and Start button):
  every 2s while view visible:
    invoke('capture_target_thumbnail', { target })
       → SCShareableContent → SCContentFilter::for_target(target)
       → SCStreamConfiguration::new().with_width(320).with_height(200)
       → SCScreenshotManager::capture_image(&filter, &config)
       → CGImage → PNG bytes → data URL
  React: <img src={dataUrl} /> re-renders on tick
```

### Component Responsibilities

| Component | File | Responsibility |
|-----------|------|----------------|
| `AudioDevice` DTO + `list_audio_inputs` | `crates/capture/src/audio/device.rs` (NEW) | cpal enumeration → serializable DTO for UI |
| `AudioCaptureStream` | `crates/capture/src/audio/stream.rs` (NEW) | Owns cpal::Stream + ringbuf producer + drain thread handle; Drop stops cleanly |
| Named-pipe bridge | `crates/capture/src/audio/fifo.rs` (NEW) | mkfifo / NamedPipe factory; writer loop draining ringbuf |
| FFmpeg audio-args extension | `crates/encoder/src/config.rs` | `EncodeConfig::with_audio(path: PathBuf, rate: u32, channels: u16)` — adds `-f f32le -ar {rate} -ac {channels} -i {path}` before video `-i pipe:0` |
| `CaptureTarget::DisplayRegion` | `crates/capture/src/target.rs` | NEW enum variant carrying `RegionRect { x, y, w, h }` in logical pixels |
| Region overlay window | `apps/desktop/src/features/capture/RegionOverlay.tsx` (NEW) | Transparent fullscreen window, drag-to-draw; emits rect via IPC |
| `open_region_overlay` / `region_selected` IPC | `apps/desktop/src-tauri/src/commands/capture.rs` | Spawn/destroy overlay; receive rect |
| `LaunchConfig.args: Vec<String>` | `crates/automation/src/driver.rs` | Chrome-hiding path: `args.push("--app=<url>")` when toggle on |
| Sidecar `launch` args forwarding | `scripts/playwright-sidecar/server.mjs` | Append `args` to `launchOpts.args` before `launchServer` |
| `BROWSER_TITLE_HINTS` map | `apps/desktop/src/features/recorder/title-hints.ts` (NEW) | Static map; preset → title-hint string |
| Auto-follow hint selection | `apps/desktop/src/features/recorder/recording-view.tsx` | Look up preset in map, pass to capture start |
| `capture_target_thumbnail` IPC | `apps/desktop/src-tauri/src/commands/capture.rs` | Wraps SCScreenshotManager → PNG bytes → data URL |
| Thumbnail rendering | `apps/desktop/src/features/recorder/TargetThumbnail.tsx` (NEW) | `useQuery` with 2s refetchInterval |
| Windows E2E workflow | `.github/workflows/capture-windows-e2e.yml` (NEW) | `workflow_dispatch` + label-gated; runs real-capture tests on self-hosted runner |
| E2E test harness | `crates/capture/tests/windows_real_capture_e2e.rs` (NEW, `#[ignore]` by default) | Launches Playwright, captures 3s, verifies MP4 exists + duration ±10% |

### Recommended Project Structure

```
crates/capture/src/
├── audio/                        # NEW
│   ├── mod.rs
│   ├── device.rs                 # enumerate, AudioDevice DTO
│   ├── stream.rs                 # AudioCaptureStream (cpal+ringbuf+drain thread)
│   └── fifo.rs                   # named-pipe writer (cfg'd per platform)
├── target.rs                     # existing — ADD DisplayRegion variant
├── macos/
│   ├── sck_backend.rs            # existing — ADD source_rect branch in build_filter
│   ├── screenshot.rs             # NEW — SCScreenshotManager wrapper for thumbnails
│   └── ...
├── windows/
│   ├── wgc_backend.rs            # existing — ADD post-capture CPU crop
│   └── ...
crates/encoder/src/
├── config.rs                     # existing — extend to_ffmpeg_args with audio-in
└── pipeline.rs                   # existing — plumb audio fifo path in start()
apps/desktop/src/features/
├── recorder/
│   ├── recording-view.tsx        # existing — ADD audio device picker, chrome-hide toggle, cursor toggle, thumbnail
│   ├── title-hints.ts            # NEW
│   └── TargetThumbnail.tsx       # NEW
└── capture/
    └── RegionOverlay.tsx         # NEW
scripts/playwright-sidecar/
└── server.mjs                    # existing — ADD args passthrough in launch
.github/workflows/
└── capture-windows-e2e.yml       # NEW
```

### Pattern 1: cpal → ringbuf → drain thread → named-pipe → FFmpeg

**What:** Single-producer (cpal callback) / single-consumer (std drain thread) ring buffer decouples the realtime audio callback from blocking I/O on the fifo.

**When to use:** ALL audio capture paths. Never do cross-thread communication directly from inside cpal's callback (see cpal#970).

**Example:**
```rust
// crates/capture/src/audio/stream.rs
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{StreamConfig, SampleFormat};
use ringbuf::{HeapRb, traits::{Producer, Consumer, Split}};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::io::Write;

pub struct AudioCaptureStream {
    _stream: cpal::Stream,                  // RAII; dropped on stop
    stop_flag: Arc<AtomicBool>,
    drain_thread: Option<std::thread::JoinHandle<()>>,
}

impl AudioCaptureStream {
    pub fn start(
        device_name: Option<&str>,
        fifo_path: std::path::PathBuf,
    ) -> Result<(Self, AudioStreamInfo), AudioError> {
        let host = cpal::default_host();
        let device = match device_name {
            Some(n) => host.input_devices()?.find(|d| d.name().ok().as_deref() == Some(n)).ok_or(AudioError::DeviceNotFound)?,
            None => host.default_input_device().ok_or(AudioError::NoDefaultInput)?,
        };
        let default_cfg = device.default_input_config()?;
        let sample_format = default_cfg.sample_format();
        let cfg: StreamConfig = default_cfg.into();
        let sample_rate = cfg.sample_rate.0;
        let channels = cfg.channels;

        // 2 seconds of f32 samples (generous — drains continuously).
        let buf_cap = (sample_rate as usize) * channels as usize * 2;
        let rb = HeapRb::<f32>::new(buf_cap);
        let (mut prod, mut cons) = rb.split();
        let stop_flag = Arc::new(AtomicBool::new(false));

        // Build stream — cpal 0.17 takes StreamConfig by value (BREAKING from 0.16).
        let err_cb = |e| tracing::error!(error=?e, "cpal stream error");
        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
                cfg,
                move |data: &[f32], _| {
                    // IMPORTANT: do NOT use tokio mpsc / std mpsc / async here.
                    // cpal#970: Windows WASAPI silently kills the callback.
                    // Only ringbuf is safe.
                    let _ = prod.push_slice(data);
                },
                err_cb,
                None,
            )?,
            SampleFormat::I16 => todo!("convert i16 → f32 in callback"),
            _ => return Err(AudioError::UnsupportedFormat(sample_format)),
        };

        // Drain thread — opens fifo (blocks until reader = FFmpeg opens it),
        // then pumps ringbuf → fifo in 10ms batches.
        let stop_for_thread = stop_flag.clone();
        let drain = std::thread::spawn(move || {
            let mut fifo = match std::fs::OpenOptions::new().write(true).open(&fifo_path) {
                Ok(f) => f,
                Err(e) => { tracing::error!(error=?e, "fifo open failed"); return; }
            };
            let mut buf = vec![0f32; 4096];
            while !stop_for_thread.load(Ordering::Relaxed) {
                let n = cons.pop_slice(&mut buf);
                if n == 0 { std::thread::sleep(std::time::Duration::from_millis(2)); continue; }
                let bytes: &[u8] = bytemuck::cast_slice(&buf[..n]);
                if fifo.write_all(bytes).is_err() { break; }
            }
        });

        stream.play()?;
        Ok((
            Self { _stream: stream, stop_flag, drain_thread: Some(drain) },
            AudioStreamInfo { sample_rate, channels, sample_format: SampleFormat::F32 },
        ))
    }
}

impl Drop for AudioCaptureStream {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        // _stream drops → cpal stops. Then drain thread exits.
        if let Some(h) = self.drain_thread.take() { let _ = h.join(); }
    }
}
```

**Source:** Pattern derived from [cpal/examples/feedback.rs](https://github.com/RustAudio/cpal/blob/master/examples/feedback.rs) adapted per [cpal issue #970 workaround](https://github.com/RustAudio/cpal/issues/970). [VERIFIED]

### Pattern 2: FFmpeg dual-input mux (video stdin + audio fifo)

**What:** Two independent inputs — video on `pipe:0`, audio on a named pipe path. Arg order matters.

**Example:**
```rust
// crates/encoder/src/config.rs — extend to_ffmpeg_args
pub struct AudioInput {
    pub fifo_path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: AudioFormat,      // F32LE | S16LE
}

// New arg shape (replaces anullsrc silent track when Some(audio)):
if let Some(audio) = &cfg.audio_input {
    args.extend([
        "-f".into(), match audio.format {
            AudioFormat::F32LE => "f32le".into(),
            AudioFormat::S16LE => "s16le".into(),
        },
        "-ar".into(), audio.sample_rate.to_string(),
        "-ac".into(), audio.channels.to_string(),
        "-i".into(), audio.fifo_path.display().to_string(),
    ]);
}
// later, video input:
args.extend(["-f".into(), "rawvideo".into(), /* ... */ "-i".into(), "pipe:0".into()]);

// mapping: if dual input, audio is input 0, video is input 1:
args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "1:a:0".into()]);
// audio encode:
args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into(), "-ac".into(), "2".into()]);
```

**Note:** Arg ORDER matters — each `-i` attaches to the preceding codec/format opts. Keep video on `pipe:0` (stdin) so the existing `EncodePipeline` keeps working; the fifo is the second `-i`.

**Cross-platform fifo creation:**
```rust
#[cfg(unix)]
pub fn make_fifo(path: &Path) -> io::Result<()> {
    use nix::sys::stat::Mode;
    use nix::unistd::mkfifo;
    mkfifo(path, Mode::S_IRUSR | Mode::S_IWUSR).map_err(io::Error::from)
}

#[cfg(windows)]
pub fn make_fifo(path: &Path) -> io::Result<()> {
    // Windows named pipes live under \\.\pipe\<name>, not the filesystem.
    // Use CreateNamedPipeW via the `windows` crate. FFmpeg accepts these paths.
    // Alternatively: cpal → tokio stdin handoff requires no fifo (but FFmpeg
    // already owns pipe:0 for video). Named pipe is the only portable answer.
    use windows::core::PCWSTR;
    use windows::Win32::System::Pipes::*;
    // ... CreateNamedPipeW(path, PIPE_ACCESS_OUTBOUND, PIPE_TYPE_BYTE, 1, 0, 0, 0, None)
    todo!("implement via windows crate")
}
```

### Pattern 3: SCK region capture via `with_source_rect` (macOS)

**What:** SCK's native region-crop path. `source_rect` is points-in-display-space; `destination_rect` is where in the output frame the capture lands; `scales_to_fit(false)` preserves 1:1.

**Example:**
```rust
// In crates/capture/src/macos/sck_backend.rs::build_filter, add variant:
CaptureTarget::DisplayRegion { display_id, rect } => {
    let content = SCShareableContent::get()?;
    let disp = content.displays().iter()
        .find(|d| d.display_id() as u64 == display_id.0)
        .ok_or(CaptureError::Native("display not found".into()))?;
    // Rect is logical points; SCK wants CGRect in points (NOT pixels).
    let source_rect = core_graphics::geometry::CGRect::new(
        &core_graphics::geometry::CGPoint::new(rect.x, rect.y),
        &core_graphics::geometry::CGSize::new(rect.w, rect.h),
    );
    let filter = SCContentFilter::create()
        .with_display(disp)
        .with_excluding_windows(&[])
        .build();
    // NOTE: source_rect is applied on the STREAM CONFIGURATION, not the filter.
    // The filter's set_content_rect is macOS 14.2+ only — prefer the
    // stream-config path for broader compat.
    let scale = disp.point_pixel_scale();  // typically 2.0 on retina
    let width_px = (rect.w * scale as f64) as u32;
    let height_px = (rect.h * scale as f64) as u32;
    Ok((filter, width_px, height_px, Some(source_rect)))
}
```

Then in the `start` flow, pass the optional source_rect into the `SCStreamConfiguration`:
```rust
let mut cfg_builder = SCStreamConfiguration::new()
    .with_width(width_px)
    .with_height(height_px)
    .with_pixel_format(sck_pf)
    .with_shows_cursor(cfg.include_cursor)
    .with_minimum_frame_interval(&frame_interval)
    .with_queue_depth(8);
if let Some(rect) = source_rect {
    cfg_builder = cfg_builder
        .with_source_rect(rect)
        .with_destination_rect(core_graphics::geometry::CGRect::new(
            &core_graphics::geometry::CGPoint::new(0.0, 0.0),
            &core_graphics::geometry::CGSize::new(rect.size.width, rect.size.height),
        ))
        .with_scales_to_fit(false);
}
```

**Source:** [SCStreamConfiguration 1.5.4 docs — with_source_rect, with_destination_rect, with_scales_to_fit, with_preserves_aspect_ratio confirmed](https://docs.rs/screencapturekit/1.5.4/screencapturekit/stream/configuration/struct.SCStreamConfiguration.html) [VERIFIED]

### Pattern 4: Windows region capture via post-capture CPU crop

**What:** Since `windows-capture = 2.0.0` has no native region API, capture the full display and crop each frame in Rust before pushing to the pipeline.

**Example:**
```rust
// crates/capture/src/windows/wgc_backend.rs — on_frame_arrived
impl GraphicsCaptureApiHandler for StoryHandler {
    fn on_frame_arrived(&mut self, frame: &mut WgcFrame, _: InternalCaptureControl) -> Result<(), Self::Error> {
        let mut buf = frame.buffer()?;
        let width = buf.width() as usize;
        let height = buf.height() as usize;
        let stride = buf.stride() as usize;
        let bytes = buf.as_raw_buffer();

        if let Some(rect) = self.crop_rect {
            // Physical pixel rect (already scaled).
            let mut cropped = Vec::with_capacity(rect.w as usize * rect.h as usize * 4);
            for row in rect.y..rect.y + rect.h {
                let start = row as usize * stride + rect.x as usize * 4;
                let end = start + rect.w as usize * 4;
                cropped.extend_from_slice(&bytes[start..end]);
            }
            let frame = Frame {
                width_px: rect.w, height_px: rect.h,
                data: FrameData::Owned(cropped, rect.w as usize * 4),
                // ... pts, format, sequence
            };
            let _ = self.tx.try_send(frame);
        } else {
            // No crop; existing full-frame path.
        }
        Ok(())
    }
}
```

**Why CPU crop and not GPU:** `windows-capture 2.0.0` surfaces `Frame` after D3D11 → CPU copy already. GPU crop would require dropping to raw `windows` crate and managing textures — defer to a future optimization phase. See "Don't Hand-Roll" below.

### Pattern 5: Chrome-hiding via `--app` launch arg

**What:** Append `--app=<url>` to Chromium launch args. Chrome opens in "app mode" — no tab bar, no URL bar, no back/forward, just the OS title bar.

**Example:**
```javascript
// scripts/playwright-sidecar/server.mjs — extend launch handler
launch: async (params) => {
  const { viewport, theme, baseUrl, headless, downloadDir, executable, channel, args } = params || {};
  const launchOpts = {
    headless: headless !== false,
    args: Array.isArray(args) ? [...args] : [],
  };
  if (executable) launchOpts.executablePath = executable;
  else if (channel) launchOpts.channel = channel;
  state.browserServer = await chromium.launchServer(launchOpts);
  // ... rest unchanged
},
```

```rust
// crates/automation/src/driver.rs — extend LaunchConfig
pub struct LaunchConfig {
    // ... existing fields
    /// Additional Chromium command-line args (e.g., ["--app=https://demo.com"]).
    /// Disabled if browser preset is non-Chromium.
    pub args: Vec<String>,
}
```

**Integration note:** When `--app=<url>` is present, Chromium opens the URL as the initial page. Our sidecar uses `newContext` + `newPage` (which creates a **second** page — `about:blank`). Two practical choices:
1. Detect `--app` is set and skip `newPage` — use `context.pages()[0]` instead (or `browser.contexts()[0].pages()[0]`).
2. Let the extra `about:blank` page exist and have the executor navigate it to `meta.app`. The app-mode window stays open but unused.

**Recommendation:** Option 1. When chrome-hiding is on, reuse the initial page. Code path:
```javascript
// After launchServer + connect:
state.page = state.context.pages()[0] ?? await state.context.newPage();
if (!chromeHidingEnabled) {
  await state.page.goto(state.baseUrl);
}
```

**Limitation citations:**
- Chromium `--app` flag: [CITED: peter.sh Chromium command-line switches list — `--app=<url>` opens URL in an "app window"](https://peter.sh/experiments/chromium-command-line-switches/)
- Works with bundled Playwright Chromium [VERIFIED: Playwright doesn't filter this flag]
- No known conflict with `--remote-debugging-port` for our use (we use `launchServer` + ws, not CDP connect)
- Safari/Firefox have no equivalent — D-11 correctly gates this UI-side

### Pattern 6: Live preview thumbnail via SCScreenshotManager

**Example:**
```rust
// crates/capture/src/macos/screenshot.rs (NEW)
use screencapturekit::{
    screenshot_manager::SCScreenshotManager,
    stream::{configuration::SCStreamConfiguration, content_filter::SCContentFilter},
    shareable_content::SCShareableContent,
};

pub async fn capture_thumbnail(
    target: &CaptureTarget,
    max_width: u32,
    max_height: u32,
) -> Result<Vec<u8>, CaptureError> {
    let (filter, src_w, src_h) = tokio::task::spawn_blocking({
        let target = target.clone();
        move || super::sck_backend::build_filter(&target)
    }).await??;

    let scale_x = max_width as f64 / src_w as f64;
    let scale_y = max_height as f64 / src_h as f64;
    let scale = scale_x.min(scale_y).min(1.0);
    let out_w = (src_w as f64 * scale) as u32;
    let out_h = (src_h as f64 * scale) as u32;

    let config = SCStreamConfiguration::new()
        .with_width(out_w)
        .with_height(out_h)
        .with_pixel_format(SckPixelFormat::BGRA)
        .with_scales_to_fit(true);

    tokio::task::spawn_blocking(move || {
        let cg_image = SCScreenshotManager::capture_image(&filter, &config)
            .map_err(|e| CaptureError::Native(format!("SCScreenshotManager: {e}")))?;
        // Encode to PNG using image crate
        let bytes = cg_image_to_png_bytes(&cg_image)?;
        Ok(bytes)
    }).await?
}
```

**Source:** [SCScreenshotManager::capture_image confirmed in screencapturekit 1.5.4 at `screencapturekit::screenshot_manager`](https://docs.rs/screencapturekit/1.5.4/screencapturekit/screenshot_manager/) [VERIFIED]

### Anti-Patterns to Avoid

- **Don't send from inside the cpal callback.** Even a `tokio::sync::mpsc::Sender::try_send` triggers [cpal#970](https://github.com/RustAudio/cpal/issues/970) on Windows WASAPI. Only `ringbuf::Producer::push_slice` is known-safe.
- **Don't assume `pipe:3` works in the Tauri sidecar.** It doesn't. Use named pipes.
- **Don't pre-resolve pid→window eagerly for multi-browser auto-follow.** Reuse Phase 5's `find_window_by_pid` with title_hint — it's already robust for this.
- **Don't use `SCContentFilter::set_content_rect` on macOS <14.2.** It requires 14.2+. Prefer the `SCStreamConfiguration::with_source_rect` path which works on macOS 12.3+.
- **Don't hand-roll SRC (sample-rate conversion) unless profiled.** cpal gives device-native rates; FFmpeg's `-af aresample=48000` handles downstream.
- **Don't build a GPU cropper for Windows region.** CPU crop in `on_frame_arrived` is simple, correct, and cheap (<1ms for 1920×1080 BGRA crop per-frame). GPU path is a future optimization.
- **Don't conflate "chrome-hiding" with "fullscreen".** `--app=` hides tab bar but keeps OS title bar (D-12). Users who want full-chromeless-fullscreen aren't served here; that's a v3 concern.
- **Don't rebuild title-hint logic in each call site.** Single `BROWSER_TITLE_HINTS` map imported from one place.
- **Don't call SCScreenshotManager on the UI thread.** Same reasoning as `SCShareableContent::get()` — wrap in `spawn_blocking`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Mic device enumeration | Raw CoreAudio / WASAPI FFI | `cpal::Host::input_devices()` | Cross-platform, typed, Drop-safe |
| Ring buffer SPSC | Custom `Arc<Mutex<VecDeque>>` | `ringbuf = 0.4.8` | Lock-free, battle-tested, cpal-examples-aligned |
| Sample format conversion | Custom f32↔i16 functions | `cpal::Sample` trait + `bytemuck::cast_slice` for f32 bytes | Trait gives `from_sample`/`to_sample` |
| Sample rate conversion (if needed) | FIR filter from scratch | `rubato = 0.16` (FftFixedIn) | Industry-standard high-quality SRC |
| Named pipe creation | Raw `mkfifo` syscalls / CreateNamedPipeW | `nix::unistd::mkfifo` (Unix) + `windows` crate wrapper | Typed, error-kind mapping |
| SCK region | Custom post-crop in Rust on macOS | `SCStreamConfiguration::with_source_rect` | Zero-bandwidth, GPU-handled |
| WGC region | Custom D3D11 texture crop | CPU crop in `on_frame_arrived` handler (for now) | Fast enough; saves GPU surface management |
| Chromium `--app` URL validation | Custom URL parser | `url::Url::parse(meta_app)` (already in Cargo.toml) | One-liner, standard |
| Screenshot encoding (CGImage → PNG) | Raw ImageIO | `image` crate with `image::codecs::png::PngEncoder`, or `objc2-image-io` | `image` already in Cargo.toml |
| Title-hint maintenance | Scattered consts | Single `BROWSER_TITLE_HINTS` map | Discoverability + single source of truth |
| Overlay window geometry | Custom calculations | Tauri `WindowBuilder::fullscreen(true)` + `transparent(true)` + `decorations(false)` | Platform idioms; Tauri handles retina |

**Key insight:** The hardest part of this phase is NOT any individual integration — it's respecting the async/sync boundaries at each seam: cpal callback is sync (→ ringbuf), drain thread is sync-blocking (→ fifo write), FFmpeg reader is sync, but StorytCapture's orchestrator is async tokio. The pattern is: **sync callback → lock-free queue → sync bridge thread → sync I/O**. Try to make any of that async and you hit cpal#970 or similar.

## Runtime State Inventory

Not applicable for this phase — all changes are additive (new enum variants, new IPC commands, new UI elements, new tests). No stored data, service config, OS-registered state, secret keys, or build artifacts reference legacy identifiers that need migrating.

**Nothing found in category:** Confirmed — Phase 6 is purely additive feature work atop Phase 5 code-complete state.

## Common Pitfalls

### Pitfall 1: cpal Windows WASAPI callback silently stops on cross-thread sends
**What goes wrong:** Input callback fires a few times, then stops with no error.
**Why it happens:** [cpal#970](https://github.com/RustAudio/cpal/issues/970) — operations that involve driver-thread synchronization (tokio mpsc send, std mpsc send, certain ringbuf variants) appear to trigger WASAPI-side callback deregistration.
**How to avoid:** Use `ringbuf::HeapRb::<T>::new(cap).split()` and call only `Producer::push_slice()` in the callback. Drain from a separate std::thread outside the callback.
**Warning signs:** Audio ends early or has huge silent gaps; CI green on macOS but flaky on Windows.
**Source:** [CITED: cpal issue #970 (RustAudio/cpal)](https://github.com/RustAudio/cpal/issues/970)

### Pitfall 2: Tauri sidecar cannot expose fd >= 3
**What goes wrong:** Attempting FFmpeg `-i pipe:3` fails silently or FFmpeg errors "could not find codec parameters".
**Why it happens:** Tauri's `tauri-plugin-shell` `Command` maps only stdin/stdout/stderr. Additional pipes would need custom `pre_run`/`spawn` invocations outside the plugin. [CITED: Tauri sidecar discussion #4440, #8641]
**How to avoid:** Use named pipes (mkfifo on Unix, `\\.\pipe\<name>` on Windows). FFmpeg accepts filesystem paths to these pipes as inputs.
**Warning signs:** FFmpeg stderr shows "Could not open file pipe:3" or "Invalid argument".
**Source:** [CITED: Tauri sidecar discussion #4440](https://github.com/orgs/tauri-apps/discussions/4440), [Tauri v2 sidecar docs](https://v2.tauri.app/develop/sidecar/)

### Pitfall 3: macOS asks for microphone permission on cpal init even if only enumerating
**What goes wrong:** Calling `cpal::default_host().default_input_device()` triggers `NSMicrophoneUsageDescription` prompt before user has opted in.
**Why it happens:** CoreAudio's default-device query touches mic. [CITED: cpal issue #901](https://github.com/RustAudio/cpal/issues/901)
**How to avoid:** (a) Always include `NSMicrophoneUsageDescription` in `Info.plist` with a user-readable explanation. (b) Don't enumerate input devices until the user opens the audio picker. (c) Defer `default_input_device()` to capture-start time, not app launch.
**Warning signs:** macOS permission dialog appears on first app launch with no user action.
**Source:** [CITED: cpal#901](https://github.com/RustAudio/cpal/issues/901), [Mixxx PR #11367 showing the Info.plist fix](https://github.com/mixxxdj/mixxx/pull/11367)

### Pitfall 4: `NSCameraUsageDescription` vs `NSMicrophoneUsageDescription` confusion
**What goes wrong:** Wrong Info.plist key → TCC doesn't prompt, silent fail.
**Why it happens:** Both keys look similar; copy-paste errors propagate.
**How to avoid:** For microphone you need **`NSMicrophoneUsageDescription`** ONLY. Camera key is irrelevant for audio capture.
**Warning signs:** User clicks mic permission grant in System Settings but cpal still fails; tccutil reset shows no mic entry for the bundle.

### Pitfall 5: windows-capture 2.0.0 `DirtyRegionSettings` is NOT a crop API
**What goes wrong:** Planner reads `DirtyRegionSettings` in `Settings::new` signature, assumes it enables cropping.
**Why it happens:** The name suggests region-of-interest; in fact it's a performance hint ("only update dirty regions").
**How to avoid:** Use post-capture CPU crop (Pattern 4 above). Track upstream issue for native crop support.
**Source:** [VERIFIED: windows-capture 2.0.0 Settings docs — no sourceRect/crop/bounds/ROI fields](https://docs.rs/windows-capture/2.0.0/windows_capture/settings/struct.Settings.html)

### Pitfall 6: Chromium `--app` opens an extra window alongside Playwright's default page
**What goes wrong:** User sees 2 browser windows — the `--app` window with the real URL, plus a `about:blank` from `newPage()`.
**Why it happens:** `--app=<url>` creates an initial tab; Playwright's `context.newPage()` adds another tab (or opens a separate window depending on flags).
**How to avoid:** When `chrome-hiding=on`, skip `newPage()` and reuse `context.pages()[0]`. See Pattern 5 integration note.
**Warning signs:** Recording captures two windows; auto-follow picks the wrong one.

### Pitfall 7: SCK `source_rect` coordinates are points, not pixels
**What goes wrong:** Region on retina display captures only upper-left quadrant.
**Why it happens:** SCK works in points (logical); user-drawn rect in a 2× backing window is also points; but `SCStreamConfiguration::with_width/with_height` expects physical pixels. Mixing the two breaks the math.
**How to avoid:** `source_rect` uses points; `width_px` uses pixels (`rect.w * display.point_pixel_scale()`). Document explicitly in the rect struct.
**Warning signs:** Captured video is half-size or misaligned.

### Pitfall 8: Named pipe opens block until both ends connect
**What goes wrong:** Drain thread calls `OpenOptions::new().write(true).open(&fifo_path)` and blocks forever; FFmpeg hasn't started yet.
**Why it happens:** POSIX fifo semantics: open-for-write blocks until a reader opens, and vice-versa.
**How to avoid:** Start FFmpeg FIRST (which opens the fifo for read), THEN start the drain thread. Or open fifo with `O_RDWR | O_NONBLOCK` from the writer side (Linux; not portable to macOS where this is undefined).
**Warning signs:** App hangs on start-recording; both processes waiting on each other.

### Pitfall 9: Self-hosted Windows runners with graphical session are expensive and rare
**What goes wrong:** CI job queues forever waiting for a runner labeled `windows-graphical`.
**Why it happens:** GitHub-hosted `windows-latest` has no interactive desktop session; you must provide your own VM with an auto-login user.
**How to avoid:** D-23 explicitly allows "infra-pending" fallback — ship workflow stub + documented manual test script. Operator provisions runner out-of-band.
**Warning signs:** workflow runs always stay queued on first trigger.

## Code Examples

### Example 1: Audio device enumeration IPC DTO
```rust
// crates/capture/src/audio/device.rs
use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AudioInputInfo {
    pub id: String,        // opaque — device name, used as selection key
    pub name: String,
    pub is_default: bool,
    pub channels: u16,
    pub sample_rate_hz: u32,
}

pub fn list_inputs() -> Result<Vec<AudioInputInfo>, AudioError> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let mut out = Vec::new();
    for dev in host.input_devices()? {
        let name = dev.name().unwrap_or_else(|_| "(unknown)".into());
        let cfg = match dev.default_input_config() { Ok(c) => c, Err(_) => continue };
        out.push(AudioInputInfo {
            id: name.clone(),
            is_default: default_name.as_deref() == Some(&name),
            name,
            channels: cfg.channels(),
            sample_rate_hz: cfg.sample_rate().0,
        });
    }
    Ok(out)
}
```

### Example 2: FFmpeg args with optional audio input
```rust
// crates/encoder/src/config.rs — new method
impl EncodeConfig {
    pub fn to_ffmpeg_args_v2(&self) -> Vec<String> {
        let mut args = vec!["-hide_banner".into(), "-y".into()];

        // INPUT 0: raw video stdin (unchanged)
        args.extend([
            "-f".into(), "rawvideo".into(),
            "-pix_fmt".into(), "bgra".into(),
            "-s".into(), format!("{}x{}", self.width, self.height),
            "-r".into(), self.fps_advisory.to_string(),
            "-i".into(), "pipe:0".into(),
        ]);

        // INPUT 1: audio from fifo OR silent anullsrc
        if let Some(audio) = &self.audio_input {
            args.extend([
                "-f".into(), "f32le".into(),
                "-ar".into(), audio.sample_rate.to_string(),
                "-ac".into(), audio.channels.to_string(),
                "-i".into(), audio.fifo_path.display().to_string(),
            ]);
        } else {
            args.extend([
                "-f".into(), "lavfi".into(),
                "-i".into(), "anullsrc=r=48000:cl=mono".into(),
            ]);
        }

        // encode/map/output — same as existing
        args.extend([
            "-map".into(), "0:v:0".into(),
            "-map".into(), "1:a:0".into(),
            "-c:v".into(), self.encoder.ffmpeg_codec_name().into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "128k".into(),   // up from 64k per Claude discretion
            "-ac".into(), "2".into(),        // stereo output even from mono mic
            "-shortest".into(),
            "-movflags".into(), "+faststart".into(),
            self.output_path.display().to_string(),
        ]);
        args
    }
}
```

### Example 3: Title-hint map
```typescript
// apps/desktop/src/features/recorder/title-hints.ts
export const BROWSER_TITLE_HINTS: Record<BrowserPreset, string> = {
  chromium: 'Chromium',
  chrome: 'Google Chrome',
  'chrome-beta': 'Google Chrome Beta',
  'chrome-dev': 'Google Chrome Dev',
  'chrome-canary': 'Google Chrome Canary',
  msedge: 'Microsoft Edge',
  'msedge-beta': 'Microsoft Edge Beta',
  'msedge-dev': 'Microsoft Edge Dev',
  brave: 'Brave Browser',
  arc: 'Arc',
} as const;

export function titleHintFor(preset: BrowserPreset | undefined): string | null {
  return preset ? BROWSER_TITLE_HINTS[preset] ?? null : null;
}
```

### Example 4: Region overlay React component skeleton
```tsx
// apps/desktop/src/features/capture/RegionOverlay.tsx
import { useState, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function RegionOverlay({ displayId, onConfirm, onCancel }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && rect) onConfirm({
        display_id: displayId,
        x: rect.left, y: rect.top, w: rect.width, h: rect.height,
      });
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [rect, displayId, onConfirm, onCancel]);

  return (
    <div
      className="fixed inset-0 cursor-crosshair bg-black/20"
      onMouseDown={(e) => { startRef.current = { x: e.clientX, y: e.clientY }; setRect(null); }}
      onMouseMove={(e) => {
        if (!startRef.current) return;
        const { x, y } = startRef.current;
        setRect(new DOMRect(
          Math.min(x, e.clientX), Math.min(y, e.clientY),
          Math.abs(e.clientX - x), Math.abs(e.clientY - y),
        ));
      }}
      onMouseUp={() => { startRef.current = null; }}
    >
      {rect && (
        <div
          className="absolute border-2 border-blue-500 bg-blue-500/10"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          <span className="absolute -top-6 left-0 bg-blue-500 text-white px-2 text-xs">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      )}
    </div>
  );
}
```

### Example 5: Windows E2E workflow stub
```yaml
# .github/workflows/capture-windows-e2e.yml
name: capture-windows-e2e
on:
  workflow_dispatch:
  pull_request:
    types: [labeled]

jobs:
  e2e:
    if: github.event.label.name == 'needs-windows-e2e' || github.event_name == 'workflow_dispatch'
    runs-on: [self-hosted, windows, graphical]
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
      - name: Real-capture E2E (display + window)
        shell: pwsh
        run: |
          cargo test -p capture --features real-capture-windows --test windows_real_capture_e2e -- --ignored --nocapture
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: e2e-output, path: target/e2e-output/**/* }
```

Paired manual-test script (shipped when no runner available):
```markdown
<!-- .planning/phases/06-recording-v2-.../06-04-MANUAL-TEST.md -->
# Windows capture E2E manual test

Prereqs: Windows 10/11 physical machine, Playwright installed, Screen Recording not required on Windows.

1. Checkout branch; run `cargo build -p capture --features real-capture-windows`.
2. Run `cargo test -p capture --features real-capture-windows --test windows_real_capture_e2e -- --ignored --nocapture`.
3. Observe: two .mp4 files in `target/e2e-output/` — `display.mp4` (3s, matches primary display) and `window.mp4` (3s, Chromium window contents).
4. Verify: both files open in Windows Media Player; duration ~3s ± 10%.
```

## State of the Art

| Old Approach | Current Approach | When Changed |
|--------------|------------------|--------------|
| cpal 0.15/0.16 `build_input_stream(&cfg, ...)` | cpal 0.17 `build_input_stream(cfg, ...)` (by value) | 2025-12-20 |
| cpal 0.16 Stream cloneable on macOS only | cpal 0.17 all platforms require `Arc::new(stream)` | 2025-12-20 |
| windows-capture 1.5 with old callback API | 2.0 `GraphicsCaptureApiHandler` trait | 2026-04-14 |
| SCK `set_content_rect` on SCContentFilter (macOS 14.2+) | SCK `SCStreamConfiguration::with_source_rect` (macOS 12.3+) | existed since 12.3 |
| FFmpeg `-vsync vfr` (deprecated alias) | FFmpeg `-fps_mode vfr` | 2022 |
| Playwright `browser.channel` per-call | `launch({ channel: 'msedge' })` as canonical form | stable since 1.21 |

**Deprecated / outdated:**
- `hound` crate for audio I/O — last release 2023-09-25; cpal is the canonical source
- rubato `< 0.12` — superseded; pin `=0.16` for stability
- `CGWindowListCreateImage` for thumbnails — deprecated in macOS 15; use SCScreenshotManager

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Named pipe path works as a FFmpeg `-i` argument on Windows (`\\.\pipe\name`) | Pattern 2 | Low — documented in FFmpeg mailing list 2012. Fallback: temp WAV file + post-mux. |
| A2 | SCScreenshotManager captures in <100ms per invocation for a 320×200 thumbnail | D-16 / Pattern 6 | Low — 1 call per 2s is fine even at 500ms. Worst case: slow refresh to 5s. |
| A3 | cpal 0.17 on macOS is not affected by cpal#970 | Pitfall 1 | Medium — issue reporter tested only Windows 11 23H2. Using ringbuf on all platforms is safe regardless. |
| A4 | Playwright `launchServer({ channel: 'msedge' })` pid === Edge browser process pid (not a wrapper) | Pattern 3 (multi-browser) | Low — Phase 5.02 already uses launchServer for Chromium; same verb shape. Spike early. |
| A5 | Chromium `--app` behaves identically with bundled Playwright Chromium and channel-installed Chrome/Edge/Brave | Pattern 5 | Low — `--app` is a core Chromium flag, not a Chrome-only extension. |
| A6 | `windows-capture` 2.0 will NOT gain native region support within Phase 6 timeline | Pattern 4 | Low — even if it does, CPU crop keeps working; swap is a future optimization. |
| A7 | Tauri's fullscreen-transparent window pattern handles multi-monitor correctly on Windows | Example 4 | Medium — Tauri multi-monitor handling for transparent windows has had bugs historically. Spike with a 2-monitor setup. |
| A8 | Self-hosted Windows runner with interactive desktop session is available OR D-23 fallback is accepted | Pattern 5 (E2E) | Low — D-23 is explicit. |

## Open Questions

1. **Should `EncodeConfig::audio_input` replace or shadow the existing silent `anullsrc` path?**
   - What we know: current FFmpeg args always include `anullsrc`.
   - Recommendation: make audio_input `Option<AudioInput>`; when `Some`, replace anullsrc; when `None`, keep current behavior. Backward-compatible.

2. **Where does fifo lifecycle live — encoder crate or capture crate?**
   - What we know: encoder owns FFmpeg; capture owns audio stream.
   - Recommendation: encoder creates the fifo path (temp dir + UUID), returns it to the caller; capture's `AudioCaptureStream::start` accepts the path. Encoder deletes on pipeline stop.

3. **How does the recorder handle audio-start failure mid-recording?**
   - Options: (a) abort recording, (b) continue video-only with toast, (c) retry with default device.
   - Recommendation: (b) — video is the primary artifact; audio drop should warn but not kill the story. Consistent with D-07 (silent fallback pattern).

4. **Does Arc / Brave respect Chromium `--app` identically?**
   - What we know: Brave is Chromium fork; Arc is Chromium-based. Both should accept `--app`.
   - Recommendation: add a Wave 0 manual test; if one doesn't work, gate chrome-hiding to the specific supported channels.

5. **Should live preview honor the cursor/chrome-hiding toggles for fidelity?**
   - What we know: toggles reset each recording (D-20).
   - Recommendation: thumbnail uses default cursor=true, chrome=on. The thumbnail is preview-fidelity only. Document.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| cpal 0.17.3 (crate) | 06-01 | ✓ | crates.io | — |
| ringbuf 0.4.8 (crate) | 06-01 | ✓ | crates.io | — |
| rubato 0.16 (crate) | 06-01 (conditional) | ✓ | crates.io | FFmpeg `-af aresample` |
| FFmpeg sidecar with `-f f32le` | 06-01 | ✓ | existing bundled | — |
| mkfifo (Unix) | 06-01 | ✓ | nix crate | — |
| CreateNamedPipeW (Windows) | 06-01 | ✓ | windows crate | — |
| macOS 12.3+ | SCK region (`with_source_rect`) | ✓ | build minOS | — |
| macOS 14.0+ | SCScreenshotManager | ✓ | build minOS | full-SCK-stream one-shot frame |
| NSMicrophoneUsageDescription in Info.plist | mic on macOS | must add | Tauri bundle config | mic fails silently without this |
| Chromium channel-installed browsers (chrome, msedge, brave) | 06-03 test matrix | user's machine | varies | graceful fallback to bundled Chromium |
| Self-hosted graphical Windows runner | 06-04 real-capture CI | ✗ | operator-provisioned | D-23 fallback: workflow stub + manual script |
| Tauri fullscreen transparent window support | 06-02 overlay | ✓ | Tauri 2.8.x | — |

**Missing dependencies with no fallback:** none blocking.
**Missing dependencies with fallback:** self-hosted Windows runner (D-23 allows stub).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `cargo test` / `cargo nextest` (Rust); Vitest (sidecar JS); Vitest+RTL (React) |
| Config | Cargo features: `audio-real` (cpal-driven mic test), `real-capture-windows` (existing) |
| Quick run command | `cargo test -p capture --lib audio::` (mocked audio device; no mic grant) |
| Full suite command | `cargo test -p capture --features audio-real,real-capture -- --ignored` (real mic on macOS) |

### Phase Requirements → Test Map

| Req | Behavior | Test Type | Automated Command | File Exists? |
|-----|----------|-----------|-------------------|--------------|
| PHASE-6.1 | `list_audio_inputs` returns at least default device | unit | `cargo test -p capture audio::device::list_inputs_has_default` | ❌ Wave 0 |
| PHASE-6.1 | `AudioCaptureStream` produces >0 f32 samples in 500ms (real mic) | integration (gated) | `cargo test -p capture --features audio-real audio::stream::real_mic_samples -- --ignored` | ❌ Wave 0 |
| PHASE-6.1 | FFmpeg mux produces MP4 with audio+video streams of matching duration (±200ms) | e2e (gated) | `cargo test -p encoder --features audio-real pipeline::mux_real_audio_video -- --ignored` | ❌ Wave 0 |
| PHASE-6.1 | cpal#970 workaround: no send-from-callback on Windows | property | `cargo test -p capture audio::stream::callback_only_uses_ringbuf` (compile-time + clippy lint) | ❌ Wave 0 |
| PHASE-6.2 | `CaptureTarget::DisplayRegion` serde roundtrip | unit | `cargo test -p capture target::tests::region_roundtrip` | ❌ Wave 0 |
| PHASE-6.2 | SCK region capture produces frames of exact rect dimensions (macOS) | integration (gated) | `cargo test -p capture --features real-capture macos::sck_backend::region_exact_dims -- --ignored` | ❌ Wave 0 |
| PHASE-6.2 | WGC CPU crop produces frames of exact rect dimensions (Windows) | integration (gated) | `cargo test -p capture --features real-capture-windows windows::wgc_backend::region_cpu_crop -- --ignored` | ❌ Wave 0 |
| PHASE-6.2 | `LaunchConfig.args` containing `--app=<url>` propagates to sidecar | unit | Vitest: `scripts/playwright-sidecar/server.test.mjs` (extend) | ❌ Wave 0 |
| PHASE-6.2 | cursor toggle reflects in `CaptureConfig.include_cursor` at start, reset at stop | unit | `cargo test -p storycapture-desktop cursor_toggle_not_sticky` | ❌ Wave 0 |
| PHASE-6.3 | Playwright `channel: 'msedge'` launches Edge (when installed) | integration (gated) | Vitest: sidecar launch with channel; assert `spawnfile` contains `msedge` | ❌ Wave 0 |
| PHASE-6.3 | Title-hint map covers all BrowserRow presets | unit | `apps/desktop/src/features/recorder/__tests__/title-hints.test.ts` | ❌ Wave 0 |
| PHASE-6.3 | SCScreenshotManager returns non-empty PNG for a valid target (macOS) | integration (gated) | `cargo test -p capture --features real-capture macos::screenshot::thumbnail_pngs -- --ignored` | ❌ Wave 0 |
| PHASE-6.3 | Thumbnail UI re-renders at 2s cadence | component | RTL + vi.useFakeTimers in `TargetThumbnail.test.tsx` | ❌ Wave 0 |
| PHASE-6.4 | `capture-windows-e2e.yml` workflow syntax valid | lint | `actionlint .github/workflows/capture-windows-e2e.yml` | ❌ Wave 0 |
| PHASE-6.4 | Manual test script documents reproducible steps | doc-lint | markdownlint + human review | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cargo test -p capture --lib` + `pnpm -F @storycapture/desktop test`
- **Per wave merge:** `cargo test -p capture` (non-gated) + Vitest sidecar suite
- **Phase gate:** Real-capture gated suites run on macOS TCC-granted host; Windows gated suites run on self-hosted runner OR via manual-test script per D-23

### Wave 0 Gaps
- [ ] `crates/capture/src/audio/` module skeleton (device.rs, stream.rs, fifo.rs)
- [ ] `crates/capture/tests/audio_real_mic.rs` — gated by `audio-real` feature
- [ ] `crates/encoder/tests/audio_mux.rs` — verifies dual-input FFmpeg args round-trip
- [ ] `apps/desktop/src/features/capture/__tests__/RegionOverlay.test.tsx`
- [ ] `apps/desktop/src/features/recorder/__tests__/title-hints.test.ts`
- [ ] `scripts/playwright-sidecar/server.test.mjs` — extend with args-passthrough case
- [ ] `.github/workflows/capture-windows-e2e.yml`
- [ ] `.planning/phases/06-.../06-04-MANUAL-TEST.md` per D-23

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A |
| V3 Session Management | no | N/A |
| V4 Access Control | yes | OS TCC for microphone + screen; enforced by OS |
| V5 Input Validation | yes | Region rect bounds validation; `--app` URL must parse via `url::Url`; device names sanitized as UI strings only |
| V6 Cryptography | no | N/A |

### Known Threat Patterns for this surface

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| `--app` URL injection (attacker-crafted `meta.app` with `"; --disable-web-security` etc.) | Tampering / EoP | Parse `meta.app` with `url::Url::parse()`; reject non-http(s) schemes; pass URL-encoded value only |
| Malicious device name from cpal (shell-meta chars in cpal device id passed to any subprocess) | Tampering | cpal device ids are strings from OS APIs — already sanitized; never interpolate into shell commands |
| Region rect outside display bounds → OOB read in WGC CPU crop | InfoDisclosure / DoS | Clamp `rect.x`, `rect.y`, `rect.w`, `rect.h` to `[0, display_width]` / `[0, display_height]` before crop |
| Mic capture leaks audio to disk after stop | InfoDisclosure | `AudioCaptureStream::Drop` stops cpal stream + joins drain thread; fifo deleted on encoder-pipeline stop |
| `NSMicrophoneUsageDescription` missing → silent permission fail | User trust | Include Info.plist key during bundle config; add to Wave 0 checklist |
| Child-browser process inherits parent env including sensitive vars | InfoDisclosure | Playwright already spawns with clean env; verify no leak via `--app` flag injection |

## Phase Breakdown Confirmation

**D-24's 4-plan split is sound. Endorse with minor re-scope note on 06-02:**

### 06-01: Audio capture (highest risk, ship first)
- Scope as written — cpal + ringbuf + fifo + FFmpeg mux
- Risk drivers: cpal#970, pipe:3 limitation, macOS TCC mic permission
- Should have its own wave 0 to establish fifo + Info.plist plumbing before feature work

### 06-02: Region + chrome-hiding + cursor toggle — **re-scope required**
- Keep region on macOS per D-07 (SCK native path, clean)
- **Windows region MUST use CPU crop** (windows-capture 2.0 lacks native region). Update D-07 to note this. Track upstream issue for future native path.
- Chrome-hiding is a 5-line change (`LaunchConfig.args` + sidecar passthrough + `newPage` skip)
- Cursor toggle is already plumbed; UI-only change
- Coherent vertical slice; all three are "capture-config knobs" as CONTEXT.md notes

### 06-03: Multi-browser + live preview + title-hints
- Playwright channel support: already in sidecar `launch` handler
- Title-hint map: one new TS file + one call-site change
- Live preview: new IPC command + SCScreenshotManager wrapper + React component with `refetchInterval: 2000`
- Lightest of the four plans; can absorb small discoveries from 06-01/06-02

### 06-04: Windows E2E CI infrastructure
- Ship workflow stub + manual test script per D-23
- Operator provisions runner as follow-up
- No hard dependency on other plans; can ship in parallel

**Recommended order:** 06-01 (risk) → 06-02 (user-visible features) → 06-03 (polish) → 06-04 (CI; parallel with 06-03 ok)

## Sources

### Primary (HIGH confidence)
- [cpal crate metadata on crates.io](https://crates.io/api/v1/crates/cpal) — 0.17.3 published 2026-02-18
- [cpal CHANGELOG 0.15→0.17](https://github.com/RustAudio/cpal/blob/master/CHANGELOG.md) — breaking changes documented
- [cpal issue #970 — WASAPI callback silently dies on cross-thread ops](https://github.com/RustAudio/cpal/issues/970)
- [cpal issue #901 — mic permission prompt on default-device query](https://github.com/RustAudio/cpal/issues/901)
- [cpal/examples/feedback.rs — reference ringbuf integration](https://github.com/RustAudio/cpal/blob/master/examples/feedback.rs)
- [screencapturekit 1.5.4 SCStreamConfiguration docs — with_source_rect, with_destination_rect, with_scales_to_fit confirmed](https://docs.rs/screencapturekit/1.5.4/screencapturekit/stream/configuration/struct.SCStreamConfiguration.html)
- [screencapturekit 1.5.4 SCContentFilter docs — set_content_rect available 14.2+](https://docs.rs/screencapturekit/1.5.4/screencapturekit/stream/content_filter/struct.SCContentFilter.html)
- [screencapturekit 1.5.4 screenshot_manager — SCScreenshotManager::capture_image, capture_sample_buffer](https://docs.rs/screencapturekit/1.5.4/screencapturekit/screenshot_manager/)
- [windows-capture 2.0.0 Settings docs — no region API](https://docs.rs/windows-capture/2.0.0/windows_capture/settings/struct.Settings.html)
- [windows-capture 2.0.0 Window docs — process_id, enumerate, from_name, from_contains_name](https://docs.rs/windows-capture/2.0.0/windows_capture/window/struct.Window.html)
- [Tauri v2 sidecar documentation](https://v2.tauri.app/develop/sidecar/)
- [Tauri discussion #4440 — sidecar stdin usage](https://github.com/orgs/tauri-apps/discussions/4440)
- [peter.sh Chromium command-line switches — `--app=<url>`](https://peter.sh/experiments/chromium-command-line-switches/)
- [Playwright BrowserType docs — channel + launch args](https://playwright.dev/docs/api/class-browsertype)

### Secondary (MEDIUM confidence)
- [Mixxx PR #11367 — NSMicrophoneUsageDescription fix pattern](https://github.com/mixxxdj/mixxx/pull/11367)
- [Tauri issue #9928 — Rust microphone access on macOS](https://github.com/tauri-apps/tauri/issues/9928)
- [Jan Halozan — cpal microphone input tutorial](https://janhalozan.com/2024/07/01/jarvis-part-1-microphone/)
- [Tauri sidecar stream discussion #8641](https://github.com/orgs/tauri-apps/discussions/8641)
- [FFmpeg mailing list — dual named-pipe input sync considerations](https://lists.ffmpeg.org/pipermail/ffmpeg-user/2012-July/007742.html)
- [insidegui/AudioCap — native macOS audio capture reference](https://github.com/insidegui/AudioCap)

### Tertiary (LOW confidence — validate during spike)
- Exact behavior of `--app` + `newContext.pages()` on Playwright 1.48+ channel-installed browsers — spike in 06-02 wave 0
- Performance of CPU crop in WGC `on_frame_arrived` at 4K60 — benchmark in 06-02
- Self-hosted Windows runner economics in 2026 — operator decision, not researcher

## Metadata

**Confidence breakdown:**
- Audio capture stack (cpal/ringbuf/fifo): HIGH — APIs verified against docs.rs + crates.io; cpal#970 is documented
- FFmpeg dual-input mux: HIGH — standard FFmpeg pattern; fifo path works cross-platform
- SCK region: HIGH — `with_source_rect` present on 1.5.4 docs.rs page
- SCScreenshotManager: HIGH — module present at documented path
- Windows region: MEDIUM — documented lack of native API; CPU crop is sound but adds compute
- Playwright multi-browser: HIGH — channel API stable since 1.21
- Chromium `--app` flag: MEDIUM — documented in peter.sh; integration with Playwright's `newPage` needs Wave 0 verification
- Windows CI: LOW — operator-dependent; D-23 explicitly allows stub-only ship

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (30 days; cpal/rubato/windows-capture lines move quickly)

**Corrections to track in next STATE.md update:**
1. Amend phase 06 CONTEXT.md D-07 to note: "Windows region implementation uses post-capture CPU crop pending upstream `windows-capture` native support (no ETA as of 2026-04-17)."
