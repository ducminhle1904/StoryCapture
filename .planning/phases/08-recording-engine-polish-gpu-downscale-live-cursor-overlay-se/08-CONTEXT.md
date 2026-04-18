---
phase: 08
type: context
status: ready-for-planning
date: 2026-04-18
---

# Phase 8: Recording engine polish — GPU downscale, live cursor overlay, SessionActor recorder wiring - Context

**Gathered:** 2026-04-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Polish the recording hot path so it scales to 4K60 on modern GPUs and produces cinematic output live (not post-only):

1. **GPU-accelerated pre-encode downscale.** Move the `scale='min(1920,iw)':-2` pass off FFmpeg libswscale (CPU) onto the GPU. macOS uses Metal; Windows uses D3D11 compute; xcap fallback keeps CPU scaling.
2. **Live styled cursor overlay.** Composite the effects-crate cursor skin into captured frames in real time so recordings ship with the branded cursor out of the box — not only after post-production.

**Out of scope for Phase 8** (originally listed in the phase description but already shipped during pre-phase scouting):

- *SessionActor ↔ recorder-command wiring* — delivered in commits `10ea83f` (feat(automation): add RecorderHandle trait + wire SessionActor Stop) and `87abd9c` (feat(recording): auto-stop recording on DSL story end via RecorderHandle). The `automation::RecorderHandle` trait + `TauriRecorderHandle` impl + `launch_automation` auto-stop branch are on main. Phase 8 plans must **not** replan that work.

Also out of scope (see Deferred Ideas): region-aware GPU scale, cursor ripples, cursor trajectory smoothing, sub-frame cursor sampling.

</domain>

<decisions>
## Implementation Decisions

### GPU Downscale Stack

- **D-01:** Use raw `metal` (macOS) + `windows-rs` D3D11 (Windows). Skip `wgpu`. Rationale: scout evidence shows `wgpu` adds per-frame Device/Queue/CommandBuffer overhead on a 30–60 fps hot path; raw APIs are tighter and fit the existing platform-native capture crate pattern.
- **D-02:** Scale **inside** the `VtWriter` fast path on macOS so CVPixelBuffer stays in the GPU end-to-end (IOSurface → Metal resize → AVAssetWriter append). Do NOT place the GPU scaler before backend selection — that would break the current macOS zero-copy path.
- **D-03:** Add `FrameData::NativeWindows(D3DTextureHandle)` variant. WGC backend emits it when `gpu-scale` feature is active; scaler consumes the D3D11 texture directly (no redundant CPU copy). CPU-copy `Pooled` path remains for non-GPU builds and xcap.
- **D-04:** New workspace crate `crates/gpu_scale/` owns the trait + platform impls. Encoder adds optional dep `gpu_scale = { path = "../gpu_scale", optional = true }` behind `gpu-scale` Cargo feature.
- **D-05:** Cargo feature `gpu-scale` is **default on**. CI jobs without GPU SDKs (Linux headless, xcap-only soak) opt out with `--no-default-features`.
- **D-06:** Output of the scaler is packed BGRA (stride = width × 4) for the FFmpeg rawvideo path. On macOS VT path, scaler returns an `MTLTexture` / `CVPixelBuffer` that AVAssetWriter can append directly — no CPU readback.
- **D-07:** Performance target: 4K60 → 1920-wide downscale ≤ 3 ms/frame on M1 and RTX 3060-class GPU. Verified with criterion bench or PIX/Metal frame debugger trace — budget failures BLOCK phase completion.

### Live Styled Cursor Overlay

- **D-08:** Add a second toggle `include_styled_cursor: bool` to `CaptureConfig` alongside the existing `include_cursor` (Phase 6). The two flags are independent; UI gets fine-grained control.
- **D-09:** Semantic coupling at `start_recording` config assembly: when `include_styled_cursor == true`, force the backend-level `include_cursor` to `false` (turn OS cursor off). This prevents double-cursor artifacts. Document this in the field docs on `StartRecordingArgs`.
- **D-10:** Phase 8 cursor MVP is **static skin only** — sample real cursor position per-frame, composite the existing `SkinBitmap` (from `crates/effects/src/cursor/`) at that position. No click ripples, no trajectory smoothing, no sub-frame interpolation.
- **D-11:** Cursor position sampled via `CGGetMousePosition()` (macOS) and `GetCursorPos()` (Windows) — polling in the encoder frame pump, one sample per frame. Both APIs require no new OS permissions beyond existing screen-capture grant.
- **D-12:** Each cursor sample is stamped with the paired frame's PTS so compositing aligns with video-time, not wall-clock time. Store position + PTS in a lightweight struct threaded through the pump loop parallel to `Frame`.
- **D-13:** Compositing path is **dual CPU + GPU from day one** (user override of scout's "CPU-only MVP" recommendation — accepted scope expansion):
  - CPU path: refactor `compose_frame()` in `crates/effects/src/cursor/compositor.rs` into a `compose_frame_into_bgra(bgra_buf, ...)` helper that blits onto a mutable BGRA slice. Used by xcap fallback and any backend where `gpu-scale` is disabled.
  - GPU path: fused composite pass in the same Metal / D3D11 shader that performs the downscale. Cursor skin is uploaded once per recording to a shader-accessible texture; per-frame the shader reads cursor position + PTS and blends the skin at the right spot during the resize.

### Shared Infrastructure

- **D-14:** No new Tauri commands. Both features ride existing `start_recording` / `stop_recording` surface and `StartRecordingArgs` struct. Additive fields only — no breaking IPC changes.
- **D-15:** Telemetry: extend existing `RecordingEvent` enum additively if needed (e.g., `GpuScaleFailed { reason }` fallback-to-CPU signal). Do not rename or remove existing variants (see quick task 260418-gkg `FramesDropped` precedent).
- **D-16:** Test gates:
  - `cargo build --workspace` green with and without `--features gpu-scale`.
  - `cargo test -p gpu_scale` per-platform unit tests (shader compile + small-frame scale roundtrip).
  - `cargo test -p capture -p encoder` existing tests stay green.
  - Manual macOS walkthrough: 4K60 window capture for 60 s, RAM ≤ 800 MB, no frame drops, verify styled cursor visible and OS cursor absent.
  - Manual Windows walkthrough (operator-gated, same pattern as Phase 5/6 verification checkpoints).

### Claude's Discretion

- Exact shader code (Metal Shading Language + HLSL); encoder error-enum shape for `GpuScaleError` vs fallback-to-CPU behavior; thread-ownership detail for D3D11 immediate context (scout flagged single-threaded constraint — encoder frame pump owns it).
- Whether the cursor sampler lives in the encoder pump or the capture pipeline (scout suggested encoder; planner picks based on concrete wiring).
- Whether `FrameData::NativeWindows` is gated by the same `gpu-scale` feature on `capture` crate, or is always present and just unused when the feature is off.

### Folded Todos

None — no matching todos from cross-phase search.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Current capture + encoder pipeline

- `crates/capture/src/lib.rs` — backend trait + `pick_default_backend` selection
- `crates/capture/src/frame.rs` — `FrameData` enum (`NativeMacOS`, `Pooled`, `Owned`) + `Pts`/`ClockSource`; add `NativeWindows` variant here (D-03)
- `crates/capture/src/pipeline.rs` — byte-bounded queue + forwarder/consumer; live cursor sampling will thread through this
- `crates/capture/src/queue.rs` — `QueueStats` / `ByteBoundedQueue` (referenced for drop telemetry, unchanged)
- `crates/capture/src/backend.rs` — `CaptureConfig`; add `include_styled_cursor` field (D-08)
- `crates/capture/src/macos/sck_backend.rs` — line 210 `with_shows_cursor(cfg.include_cursor)`; D-09 flips this to false when styled cursor is on
- `crates/capture/src/macos/frame_from_sample.rs` — how CMTime→PTS conversion happens
- `crates/capture/src/macos/raii.rs` — `CVPixelBufferHandle` lifecycle (IOSurface keep-alive for Metal)
- `crates/capture/src/windows/wgc_backend.rs` — line 265 `CursorCaptureSettings` toggle + D3D11 texture pool; D-03 adds native-surface emission
- `crates/capture/src/windows/frame_from_wgc.rs` — lines 49–199 current CPU-copy path to `FrameData::Pooled`
- `crates/capture/src/windows/pool.rs` — `D3DTextureHandle` (COM refcount)
- `crates/encoder/src/pipeline.rs` — frame pump (lines 138–216); GPU scaler hooks here (D-06); cursor composite happens here on CPU path
- `crates/encoder/src/pipeline.rs::VtWriter` — macOS zero-copy path (lines 250–327); D-02 keeps it zero-copy
- `crates/encoder/src/config.rs` — line 101 FFmpeg `-vf scale=...` args; once GPU scale ships, the `-vf scale` is removed from args for GPU-enabled paths (runtime conditional)
- `crates/encoder/src/probe.rs` — runtime encoder feature detection pattern (precedent for GPU feature detection)

### Cursor rendering (offline → live)

- `crates/effects/src/cursor/compositor.rs` — `compose_frame()` function; refactor into `compose_frame_into_bgra()` per D-13
- `crates/effects/src/cursor/mod.rs` — public API exports; expose new BGRA compositor fn
- `crates/effects/src/cursor/trajectory.rs` — `sample_trajectory()` / `CursorSample` (offline path, NOT reused live; kept for post-prod)
- `crates/effects/src/cursor/png_sequence.rs` — offline rendering pipeline (context only; not modified)

### Tauri host wiring

- `apps/desktop/src-tauri/src/commands/encode.rs` — `StartRecordingArgs` (line 228), `start_recording` (line 289), session registry. `include_styled_cursor` field added here per D-08.
- `apps/desktop/src/ipc/capture.ts` / TS types — additive `includeStyledCursor?: boolean`
- `apps/desktop/src/features/recorder/recording-view.tsx` — UI toggle surface (existing cursor toggle is the pattern to follow)

### Prior-phase decisions (still in force)

- `.planning/phases/06-recording-v2-audio-region-capture-chrome-hiding-multi-browse/06-CONTEXT.md` — Phase 6 cursor toggle decisions (include_cursor semantics, UI placement)
- `.planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/05-CONTEXT.md` — window-target lifecycle; relevant for frame geometry / pid bridging
- `CLAUDE.md` — committed stack (no wgpu mandate despite "WebGPU/WebGL2 preview engine" line — that's the preview renderer, unrelated to this encode pass); no workarounds rule; no Co-Authored-By rule

### Related recent work (for pattern reuse, not modification)

- Commit `10ea83f` + `87abd9c` — `automation::RecorderHandle` trait wiring pattern (how pure automation crate exposes capability consumed by Tauri-side impl)
- Quick task `260418-gkg` summary at `.planning/quick/260418-gkg-recording-engine-quick-fixes-drop-chromi/260418-gkg-SUMMARY.md` — stdin RAII guard, `FramesDropped` additive-event pattern

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `SkinBitmap` + `compose_frame()` in `crates/effects/src/cursor/` — pure-function compositor, adaptable to BGRA-slice variant (D-13 CPU path).
- `CVPixelBufferHandle` / `D3DTextureHandle` RAII wrappers in `crates/capture/src/{macos,windows}/raii.rs` — GPU scaler reuses these instead of inventing new lifetime wrappers.
- `ByteBoundedQueue` + drop-newest telemetry (just shipped in 260418-gkg) — reused as-is, no changes.
- `FfmpegSidecar` / `EncodePipeline` frame-pump in `crates/encoder/src/pipeline.rs` — GPU scaler hooks after `bgra_bytes_of_frame()` call site.
- `StdinGuard` RAII pattern (830e6d0) — apply the same pattern to any GPU resource that must release deterministically on pump unwind.

### Established Patterns

- Trait + platform-specific impl modules under `cfg(target_os = ...)` — precedent in `crates/capture/src/{macos,windows}/*`; gpu_scale follows this structure.
- Runtime feature probing with graceful fallback — precedent in `encoder::probe_encoders()` (HW encoder selection). GPU scale should probe-and-fallback to CPU libswscale on init failure.
- Additive event variants — precedent: `RecordingEvent::FramesDropped` (1fe6fe8). No renames, no removals.
- Cargo features for per-platform gating — precedent: `real-capture` / `real-capture-windows` in `capture` crate.
- `tracing` spans on the encoder frame pump — extend with `gpu_scale_ms` / `cursor_composite_ms` fields.

### Integration Points

- Encoder pump intake (post-`bgra_bytes_of_frame`) — GPU scale + CPU cursor composite land here.
- WGC handler (`on_frame_arrived` in `wgc_backend.rs`) — D-03 adds native-surface emission when feature is active.
- `StartRecordingArgs` deserialization — additive `include_styled_cursor` field flows through to `CaptureConfig`.
- FFmpeg args builder (`config.rs`) — runtime conditional: remove `-vf scale=...` when GPU scale is active for the selected backend (downscale already happened upstream).

</code_context>

<specifics>
## Specific Ideas

- Scaler output shape matters: FFmpeg path wants packed BGRA bytes; VtWriter path wants a `CVPixelBuffer` backed by Metal. The trait should express both via an enum output type to avoid forcing readback on the VT fast path.
- The dual CPU+GPU compositor means two compositor implementations that must produce visually identical output. Plan includes a golden-image fixture test: fixed frame + fixed cursor position → CPU and GPU paths must produce byte-equal (or SSIM ≥ 0.999) BGRA.
- Cursor cadence is one sample per frame; sub-frame interpolation is explicitly deferred. If live recordings feel janky at high cursor velocities, that's a Phase 9 item.
- D3D11 context threading (scout flagged): pump thread owns the immediate context. If a profile reveals contention, consider switching to a deferred context + command list pattern — but not in Phase 8.

</specifics>

<deferred>
## Deferred Ideas

- **Cursor click ripples** — requires CGEventTap (macOS) / low-level mouse hook (Windows) for button events. +1–2 days. Future phase.
- **Cursor trajectory smoothing / sub-frame interpolation** — match post-prod parity. Needed only if per-frame sampling visibly lags. Future phase.
- **Region-aware GPU scale** — combined with Phase 6 region capture, crop + scale in one shader pass. Defer until Phase 6 region capture ships a stable geometry contract.
- **GPU cursor sprite packing** — uploading cursor skin as a shader-accessible texture once per recording is in scope; packing multiple cursor states (hover/click/idle) into an atlas is not.
- **wgpu migration** — if the preview engine and the encode scaler ever need to share shaders, reconsider. For Phase 8: raw platform APIs.
- **Linux support** — out of scope for v1 (CLAUDE.md constraint); no GPU scale path planned.
- **SessionActor scope** — **already shipped** in commits `10ea83f` + `87abd9c`. Phase 8 plans must not replan or re-implement.

</deferred>

---

*Phase: 08-recording-engine-polish-gpu-downscale-live-cursor-overlay-se*
*Context gathered: 2026-04-18*
