# Phase 8: Recording engine polish — GPU downscale + live styled cursor overlay - Research

**Researched:** 2026-04-18
**Domain:** Rust GPU compute (Metal + D3D11) + real-time frame compositor + FFmpeg/AVAssetWriter integration
**Confidence:** HIGH on integration surfaces (verified by code read); MEDIUM on GPU API specifics (cited from training + official docs; not runtime-verified on this machine)

## Summary

Phase 8 polishes the already-working recording hot path in two orthogonal directions:

1. **GPU pre-encode downscale** — a new `crates/gpu_scale` workspace crate owns a tiny trait `GpuScaler` with two platform impls (Metal on macOS, D3D11 compute on Windows). It returns **either** packed BGRA bytes (FFmpeg rawvideo path) **or** a wrapped native surface (`CVPixelBuffer` for the `VtWriter` fast path) so neither integration loses zero-copy.
2. **Live styled cursor overlay** — splits `effects::cursor::compose_frame` into a reusable `compose_frame_into_bgra(&mut [u8], …)` BGRA-slice blitter used by the encoder frame pump (CPU path) and replicates its pixel math in the Metal/HLSL shader (GPU path, fused with downscale so no extra pass).

The trickiest real constraints: (a) `FrameData::NativeWindows(D3DTextureHandle)` already exists in `frame.rs` but the WGC path currently **never emits it** — Phase 8 has to start emitting it behind `gpu-scale`; (b) the `VtWriter` adaptor was built with `sourcePixelBufferAttributes: None` (see `crates/encoder/src/macos/vt_writer.rs:215`), which means the scaler is free to produce a differently-shaped output `CVPixelBuffer` without renegotiating; (c) the `-vf scale=…` in `config.rs:102` needs to become conditional so we don't double-scale. No new Tauri commands, no breaking IPC — all additive fields per D-14/D-15.

**Primary recommendation:** Ship in five plans (see §12). Start with a scaffold-only `gpu_scale` crate + trait + error + feature wiring + cpu-fallback stub (08-01), then land Metal + VtWriter integration (08-02), then D3D11 + native-frame emission (08-03), then CPU cursor compositor + config wiring + UI (08-04), then fused GPU compositor + golden-image equivalence test (08-05). Each plan is independently shippable and runnable.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| GPU compute scale (Metal/D3D11) | Rust crate (`gpu_scale`) | — | Pure platform-GPU boundary; no IPC, no UI, no JS. Fits `capture/effects/encoder` monorepo pattern. |
| Feature probe + fallback selection | Rust crate (`encoder`) | `gpu_scale` init call | Mirrors existing `encoder::probe_encoders` pattern; encoder already decides FFmpeg args. |
| FrameData::NativeWindows emission | Rust crate (`capture::windows`) | — | Capture crate owns the frame type; gate behind `gpu-scale` feature exported from `capture`. |
| VtWriter substitution | Rust crate (`encoder::macos::vt_writer`) | `gpu_scale` | Writer thread already owns `CVPixelBuffer`s; scaler is a pre-append step. |
| Cursor position sampling | Rust crate (`encoder::pipeline`) | — | Must happen in the frame pump because PTS pairing is a pump-local concern (D-12). Not the capture pipeline — capture can't see encoder PTS. |
| CPU cursor compositor | Rust crate (`effects::cursor`) | `encoder::pipeline` call site | Already lives there; refactor preserves the existing offline PNG pipeline. |
| GPU cursor compositor (fused with scale) | Rust crate (`gpu_scale`) shaders | — | Single shader pass is the whole point of D-13 GPU path. |
| UI toggle (`includeStyledCursor`) | React / TS (`recording-view.tsx`) | Tauri command (`start_recording`) | Additive field on `StartRecordingArgs`; UI mirrors existing `include_cursor` toggle. |

## User Constraints (from CONTEXT.md)

### Locked Decisions

**GPU Downscale Stack:**
- **D-01** raw `metal` + `windows-rs` D3D11; skip `wgpu` (per-frame overhead)
- **D-02** scale **inside** `VtWriter` so CVPixelBuffer stays GPU end-to-end
- **D-03** add `FrameData::NativeWindows(D3DTextureHandle)` variant — WGC emits when `gpu-scale` on
- **D-04** new workspace crate `crates/gpu_scale/` behind encoder's optional `gpu-scale` feature
- **D-05** Cargo feature `gpu-scale` default ON; CI opts out with `--no-default-features`
- **D-06** scaler output = packed BGRA (FFmpeg path) OR `MTLTexture`/`CVPixelBuffer` (VT path)
- **D-07** perf: 4K60 → 1920-wide ≤ 3 ms/frame on M1 + RTX 3060 — budget failure BLOCKS phase

**Live Styled Cursor Overlay:**
- **D-08** new `include_styled_cursor: bool` on `CaptureConfig`; independent of `include_cursor`
- **D-09** semantic coupling in `start_recording`: `include_styled_cursor==true` ⇒ `include_cursor=false` (prevent double-cursor)
- **D-10** MVP = static skin only (no ripples, no smoothing, no sub-frame)
- **D-11** sample position via `CGGetMousePosition()` / `GetCursorPos()` — no new permissions
- **D-12** position stamped with frame PTS for video-time alignment
- **D-13** DUAL CPU + GPU compositor from day one — CPU path refactors `compose_frame` to `compose_frame_into_bgra`; GPU path fuses composite into the scale shader

**Shared infra:**
- **D-14** no new Tauri commands; only additive fields on `StartRecordingArgs`
- **D-15** additive `RecordingEvent` variants only (e.g., `GpuScaleFailed { reason }`)
- **D-16** test gates: build green with+without `--features gpu-scale`; per-platform unit tests; manual 4K60 walkthrough

### Claude's Discretion

- Exact shader code (MSL + HLSL)
- `GpuScaleError` enum shape + fallback-to-CPU behavior
- D3D11 immediate-context thread ownership detail (pump thread owns it)
- Whether cursor sampler lives in encoder pump or capture pipeline (research recommends: **encoder pump**, see §Architectural Responsibility Map)
- Whether `FrameData::NativeWindows` is gated by `gpu-scale` on `capture`, or always present and unused

### Deferred Ideas (OUT OF SCOPE)

- Cursor click ripples (CGEventTap / mouse hook)
- Cursor trajectory smoothing / sub-frame interpolation
- Region-aware GPU scale (crop+scale fused)
- GPU cursor sprite packing (multi-state atlas)
- wgpu migration
- Linux support
- SessionActor scope — **already shipped** in `10ea83f` + `87abd9c`; do not replan

## Phase Requirements

No numbered REQ-IDs were provided for this phase — requirements are expressed as the decision set D-01..D-16 above. Planner should map each plan's verification to specific D-IDs.

## Project Constraints (from CLAUDE.md)

- **No workarounds.** If a shader fails to compile or a COM HRESULT returns non-success, diagnose the root cause — do not fall silently to CPU **unless** that's the intentional probe-and-fallback path (D-07), in which case log `RecordingEvent::GpuScaleFailed { reason }` so the user/operator sees it.
- **No `Co-Authored-By:` trailer** in any commit message created for Phase 8. This is enforced project-wide.
- **Plan-before-breaking-change protocol.** Adding `FrameData::NativeWindows` emission is not breaking (the variant already exists); adding `include_styled_cursor` to `CaptureConfig` is additive. But the `compose_frame` → `compose_frame_into_bgra` refactor touches the public API of `effects::cursor`; if other call sites exist outside `png_sequence.rs`, planner must enter plan mode before changing signatures.
- **Project tech stack locked:** Tauri v2, Rust-only capture/encoder/effects crates, no new runtime deps without a line-itemed justification. [VERIFIED: CLAUDE.md]

## Standard Stack

### Core

| Crate | Version | Purpose | Why standard |
|-------|---------|---------|--------------|
| `objc2` | 0.6.x (match `encoder`'s existing pin) | Base objc2 used by `objc2-metal` | Already in encoder's macOS deps graph; don't add a 3rd version [VERIFIED: `crates/encoder/Cargo.toml`] |
| `objc2-metal` | 0.3.x | Safe Metal bindings (MTLDevice, MTLCommandQueue, MTLCommandBuffer, MTLComputePipelineState, MTLTexture) | Published sibling of the `objc2-av-foundation` / `objc2-core-video` crates already in encoder — stays inside a consistent version family [VERIFIED: `cargo search objc2-metal` → 0.3.2] |
| `objc2-metal-performance-shaders` | 0.3.x | `MPSImageBilinearScale` / `MPSImageLanczosScale` — Apple-blessed high-quality downscaler | MPS is a shipped OS framework (macOS 10.13+); Apple-tuned; avoids hand-writing a compute kernel for the common case [VERIFIED: `cargo search objc2-metal-performance-shaders` → 0.3.2] [CITED: https://developer.apple.com/documentation/metalperformanceshaders/mpsimagebilinearscale] |
| `objc2-core-video` | 0.3.x | `CVMetalTextureCache` / `CVPixelBufferCreateWithIOSurface` — IOSurface ↔ `MTLTexture` bridge | Already in encoder Cargo.toml [VERIFIED: `crates/encoder/Cargo.toml`] |
| `objc2-io-surface` | 1.x (optional) | Direct IOSurface if not going through CVPixelBuffer | Only needed if we ever bypass CV; default path uses CV so this is discretionary [CITED: https://docs.rs/objc2-io-surface] |
| `windows` (windows-rs) | 0.58 (match `capture`) | `ID3D11Device`, `ID3D11DeviceContext`, `ID3D11Texture2D`, `ID3D11ComputeShader`, `D3DCompiler` | Already in `capture` crate deps — stay on the same pin [VERIFIED: `crates/capture/Cargo.toml`] |

**Required windows-rs features (add to `gpu_scale` and confirm `capture`):**
- `Win32_Graphics_Direct3D11`
- `Win32_Graphics_Direct3D` (for `D3D_FEATURE_LEVEL`)
- `Win32_Graphics_Direct3D_Fxc` (D3DCompile — runtime shader compile)
- `Win32_Graphics_Dxgi`
- `Win32_Graphics_Dxgi_Common`
- `Win32_Foundation`

### Supporting

| Crate | Version | Purpose | When to use |
|-------|---------|---------|-------------|
| `thiserror` | 2.x (workspace) | Structured `GpuScaleError` | Same pattern as `EncoderError`, `CaptureError` [VERIFIED: `Cargo.toml:31`] |
| `tracing` | 0.1 (workspace) | `gpu_scale_ms` span on per-frame dispatch | Existing frame-pump spans extend naturally [VERIFIED: encoder pump logs] |
| `parking_lot` | 0.12 (workspace) | If we need a `Mutex` around a D3D11 immediate context | Only if pump-thread ownership isn't enforced structurally (D-01 discretion) |
| `bytemuck` | 1 | Shader constant-buffer packing (push constants style) | Already in `capture` Cargo.toml; reuse same version [VERIFIED: `crates/capture/Cargo.toml`] |
| `criterion` | 0.5 | `gpu_scale` bench for the D-07 3ms budget | Already used in `capture` for cpu_crop bench [VERIFIED: `crates/capture/Cargo.toml`] |

### Alternatives considered

| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| `objc2-metal` | raw `metal = "0.33"` (Apple's unofficial community crate) | `metal` has wider sample code but uses `cocoa-foundation` (old objc1 family); would conflict with encoder's objc2 0.6 graph — avoid [ASSUMED based on crate graphs] |
| `objc2-metal-performance-shaders` (MPS) | Custom `.metal` kernel for bilinear downscale | MPS is ~5 LoC and Apple-optimized; custom kernel is ~30 LoC of MSL + resource bindings. **Recommend MPS for the default path**; keep a custom kernel behind a cfg for the *fused* scale+cursor pass (can't use MPS there — MPS is pure resize). [CITED: https://developer.apple.com/documentation/metalperformanceshaders] |
| Offline-compiled `.cso` (D3D) | Runtime `D3DCompile` via fxc | Runtime compile adds ~5-20ms once per session at init. Offline compile needs a build-script. **Recommend runtime compile for Phase 8**; the init cost is amortized across the whole recording. [ASSUMED from D3D11 docs] |
| `windows-capture` D3D11 device | Create our own `D3D11CreateDevice` | WGC surfaces the underlying `ID3D11Device` via its internal pool; re-using it is zero-copy. But `windows-capture` 2.0.0 may not expose it publicly. **Check at plan time** — if not public, we create our own device (`D3D11_CREATE_DEVICE_BGRA_SUPPORT` flag required). Cross-device texture sharing via `IDXGIKeyedMutex` is a fallback but slower. [ASSUMED — confirm by inspection at 08-03 plan time] |

**Installation:**

```toml
# crates/gpu_scale/Cargo.toml
[package]
name = "gpu_scale"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[dependencies]
thiserror = { workspace = true }
tracing = { workspace = true }
bytemuck = "1"

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-foundation = { version = "0.3", features = ["NSString", "NSDictionary", "NSError", "NSObject", "NSValue"] }
objc2-metal = { version = "0.3", features = ["MTLDevice", "MTLCommandQueue", "MTLCommandBuffer", "MTLTexture", "MTLComputePipeline", "MTLLibrary"] }
objc2-metal-performance-shaders = { version = "0.3", features = ["MPSImageScale"] }
objc2-core-video = { version = "0.3", features = ["CVBuffer", "CVImageBuffer", "CVPixelBuffer", "CVMetalTextureCache"] }

[target.'cfg(target_os = "windows")'.dependencies]
windows = { version = "0.58", features = [
    "Win32_Graphics_Direct3D",
    "Win32_Graphics_Direct3D11",
    "Win32_Graphics_Direct3D_Fxc",
    "Win32_Graphics_Dxgi",
    "Win32_Graphics_Dxgi_Common",
    "Win32_Foundation",
] }

[features]
default = []
# Adds the fused scale+cursor compute path. Default is scale-only (MPS on mac,
# simple HLSL compute on win).
cursor-compose = []

[dev-dependencies]
criterion = "0.5"

[[bench]]
name = "scale_bgra"
harness = false
```

```toml
# crates/encoder/Cargo.toml (addition)
[dependencies]
gpu_scale = { path = "../gpu_scale", optional = true }

[features]
default = ["gpu-scale"]
gpu-scale = ["dep:gpu_scale"]
```

```toml
# Cargo.toml workspace members (addition at line 4)
members = [
  # ...
  "crates/gpu_scale",
  # ...
]
```

**Version verification:** `objc2-metal` 0.3.2 and `objc2-metal-performance-shaders` 0.3.2 confirmed on crates.io as of 2026-04-18 via `cargo search` [VERIFIED]. `windows-rs` 0.58 already pinned in `capture` [VERIFIED].

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────────────┐
│ SCK (macOS)     │     │ WGC (Windows)    │     │ xcap (fallback)        │
│ CVPixelBuffer   │     │ ID3D11Texture2D  │     │ Vec<u8> BGRA           │
└────────┬────────┘     └────────┬─────────┘     └──────────┬─────────────┘
         │                       │                          │
         │ FrameData::           │ FrameData::              │ FrameData::
         │ NativeMacOS           │ NativeWindows (NEW,      │ Owned / Pooled
         │                       │ D-03, feature-gated)     │
         ▼                       ▼                          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ capture::pipeline::CapturePipeline → mpsc::Sender<Frame>                │
└──────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ encoder::pipeline::EncodePipeline (frame pump)                           │
│                                                                          │
│  ┌─────────────────────────┐    ┌─────────────────────────────────────┐ │
│  │ CURSOR SAMPLER (D-11)   │    │ PATH CLASSIFIER (first frame peek)  │ │
│  │ CGGetMousePosition /    │    └──┬──────────────────────────────────┘ │
│  │ GetCursorPos            │       │                                    │
│  │ stamped w/ frame.pts    │       ├─ NativeMacOS → VT fast path        │
│  └────────────┬────────────┘       │                                    │
│               │                    ├─ NativeWindows → FFmpeg + gpu_scale│
│               │                    │                                    │
│               │                    └─ Owned/Pooled → FFmpeg + cpu scale │
│               │                                                         │
│               ▼                                                         │
│  ┌────────────────────────────────────────────────────────────────────┐│
│  │ Per-frame: classify frame → call one of:                           ││
│  │  (a) gpu_scale::scale_to_bgra(native) → packed BGRA Vec<u8>        ││
│  │      → compose_frame_into_bgra (or fused in-shader if GPU path)    ││
│  │      → stdin.write_all                                             ││
│  │  (b) gpu_scale::scale_to_cvpb(CVPB) → CVPixelBuffer                ││
│  │      → compose on the Metal side (fused) or overlay pre-append     ││
│  │      → AVAssetWriterInputPixelBufferAdaptor.append                 ││
│  │  (c) cpu scale libswscale inside ffmpeg + compose_frame_into_bgra  ││
│  │      (xcap fallback / gpu_scale probe failed)                      ││
│  └────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
              ┌────────────────┐    ┌─────────────────────┐
              │ FFmpeg sidecar │    │ AVAssetWriter       │
              │ (rawvideo stdin│    │ (macOS zero-copy)   │
              │  yuv420p x264) │    │                     │
              └────────────────┘    └─────────────────────┘
                                 │
                                 ▼
                              .mp4 on disk
```

### Pattern 1: Pure-crate trait + platform impl (mirrors capture/effects)

**What:** Trait declared in `lib.rs`; `#[cfg(target_os)]` modules under `src/` each provide an impl.
**When to use:** Any cross-platform GPU API boundary.

```rust
// crates/gpu_scale/src/lib.rs — sketch
use thiserror::Error;

/// What the scaler expects as input. Matches FrameData variants one-for-one.
pub enum ScaleInput<'a> {
    /// macOS: pointer to a CVPixelBufferRef (owned by caller; scaler retains
    /// through CVMetalTextureCache lifetime).
    #[cfg(target_os = "macos")]
    CvPixelBuffer(*mut std::ffi::c_void),
    /// Windows: pointer to an ID3D11Texture2D (owned by caller via
    /// D3DTextureHandle; scaler uses for the duration of dispatch).
    #[cfg(target_os = "windows")]
    D3d11Texture(*mut std::ffi::c_void),
    /// Cross-platform fallback: already-decoded BGRA bytes.
    Bgra { bytes: &'a [u8], width: u32, height: u32, stride: usize },
}

/// What the scaler produces. Selected by caller via method, not enum — so
/// the VtWriter path can ask for CvPixelBuffer output and the FFmpeg path
/// can ask for packed BGRA without forcing the other branch to compile.
pub struct ScaledBgra {
    pub bytes: Vec<u8>,     // packed, stride == width * 4
    pub width: u32,
    pub height: u32,
}

#[cfg(target_os = "macos")]
pub struct ScaledCvPixelBuffer {
    /// Retained CVPixelBufferRef. Ownership transfers to caller.
    pub raw: *mut std::ffi::c_void,
    pub width: u32,
    pub height: u32,
}

/// Optional cursor overlay parameters. When `Some`, the scaler fuses a
/// composite pass on the GPU path. CPU fallback ignores and leaves the
/// caller to call `effects::cursor::compose_frame_into_bgra` post-scale.
pub struct CursorOverlay<'a> {
    pub skin_bgra: &'a [u8],    // pre-uploaded or uploaded lazily
    pub skin_width: u32,
    pub skin_height: u32,
    pub pos_x: f32,             // output-pixel coords
    pub pos_y: f32,
}

#[derive(Debug, Error)]
pub enum GpuScaleError {
    #[error("device init failed: {0}")] DeviceInit(String),
    #[error("shader compile failed: {0}")] ShaderCompile(String),
    #[error("texture create failed: {0}")] TextureCreate(String),
    #[error("dispatch failed: {0}")] Dispatch(String),
    #[error("readback failed: {0}")] Readback(String),
    #[error("input variant not supported by this impl: {0}")] Unsupported(&'static str),
}

pub trait GpuScaler: Send {
    /// Scale to packed BGRA (FFmpeg rawvideo path). `cursor` fuses overlay
    /// when `Some`; caller must not double-composite on CPU afterward.
    fn scale_to_bgra(
        &mut self,
        input: ScaleInput<'_>,
        target_width: u32,
        cursor: Option<CursorOverlay<'_>>,
    ) -> Result<ScaledBgra, GpuScaleError>;

    /// macOS-only: scale to a fresh CVPixelBuffer for VtWriter append.
    #[cfg(target_os = "macos")]
    fn scale_to_cvpixelbuffer(
        &mut self,
        input: ScaleInput<'_>,
        target_width: u32,
        cursor: Option<CursorOverlay<'_>>,
    ) -> Result<ScaledCvPixelBuffer, GpuScaleError>;
}

/// Probe + construct. Returns `Ok(None)` when GPU is unavailable — caller
/// falls back to FFmpeg libswscale (existing behavior). Returns `Err` only
/// on truly surprising failures (device exists but shader compile blew up).
pub fn probe_and_build(target_width: u32) -> Result<Option<Box<dyn GpuScaler>>, GpuScaleError>;
```

File count: **5** (`lib.rs`, `macos.rs`, `windows.rs`, `scale_bgra.hlsl` (include_str!'d), `composite.metal` (include_str!'d)). Plus `benches/scale_bgra.rs` and `tests/scale_roundtrip.rs`.

### Pattern 2: Encoder-pump integration (CPU path = existing; GPU path = new)

**What:** After `bgra_bytes_of_frame(&frame)` or before that branch, classify by `FrameData` variant and route.

```rust
// Pseudocode for crates/encoder/src/pipeline.rs frame pump — lines 152-216
while let Some(frame) = frames.recv().await {
    // 1) Sample cursor position (D-11) — runs on pump thread.
    let cursor_pos = sample_os_cursor(); // (f32, f32) in display coords
    let cursor_stamp = CursorStamp { pos: cursor_pos, pts: frame.pts }; // D-12

    // 2) Route by frame type + scaler availability.
    let emit_bytes: Cow<[u8]> = match (&frame.data, &mut gpu_scaler) {
        #[cfg(target_os = "windows")]
        (FrameData::NativeWindows(tex), Some(gs)) => {
            // GPU path: scale + fused cursor composite in one dispatch.
            let overlay = cursor_overlay_for(&cursor_stamp, &skin_uploaded);
            let scaled = gs.scale_to_bgra(
                ScaleInput::D3d11Texture(tex.as_ptr()),
                target_w,
                Some(overlay),
            )?;
            Cow::Owned(scaled.bytes)
        }
        _ => {
            // CPU path: existing bgra_bytes_of_frame + compose_frame_into_bgra.
            let (bytes, stride) = bgra_bytes_of_frame(&frame)?;
            let mut buf = bytes.into_owned();
            compose_frame_into_bgra(
                &mut buf,
                frame.width_px, frame.height_px, stride,
                cursor_stamp.pos, &skin_cpu,
            )?;
            Cow::Owned(buf)
        }
    };
    stdin.as_mut().write_all(&emit_bytes).await?;
}
```

### Pattern 3: VtWriter integration (D-02 — keep zero-copy)

**Where:** `crates/encoder/src/macos/vt_writer.rs:265` (the `Cmd::Append` branch).

The existing append block calls `adaptor.appendPixelBuffer_withPresentationTime(pb, cm_pts)` on the input `CVPixelBufferHandle`. Phase 8 substitutes this with:

```rust
// INSIDE Cmd::Append handler, BEFORE isReadyForMoreMediaData check
let pb_to_append: CVPixelBufferHandle = match gpu_scaler.as_mut() {
    Some(gs) => {
        let overlay = cursor_overlay_for(pts_ns, &skin_uploaded_mtl);
        let scaled = gs.scale_to_cvpixelbuffer(
            ScaleInput::CvPixelBuffer(buffer.as_ptr()),
            target_w,
            Some(overlay),
        ).map_err(|e| EncoderError::Io(format!("gpu_scale: {e}")))?;
        // Wrap the fresh CVPixelBuffer in a handle; ownership transfers.
        unsafe { CVPixelBufferHandle::retain(scaled.raw) }
            .expect("scaler returned null CVPixelBuffer")
        // (`retain` adds one — scaler's `raw` already has +1; we must
        // Release once to balance — adjust by passing a "from_raw_no_retain"
        // constructor. Worth a small addition to raii.rs in plan 08-02.)
    }
    None => buffer, // unchanged behavior
};
```

**Critical: `sourcePixelBufferAttributes: None` in `vt_writer.rs:215`** means AVAssetWriter will accept whatever BGRA CVPixelBuffer we hand it and internally convert to H.264's native format. So the scaler returning a different-dimension CVPixelBuffer is ALREADY supported [VERIFIED: `crates/encoder/src/macos/vt_writer.rs:211-217`]. We do not need to renegotiate `sourcePixelBufferAttributes`. This is a significant simplification.

**Task decomposition:** Fuse the VtWriter integration into plan **08-02** (same as Metal impl) — they share the macOS dispatch code path and same testing surface.

### Anti-patterns to avoid

- **Creating an MTLDevice per frame.** Holding one per recording session, in the writer thread. [CITED: https://developer.apple.com/documentation/metal/mtldevice]
- **CPU readback on the VT path.** D-02 explicitly forbids; verify tests assert no `CVPixelBufferLockBaseAddress` call in the VT+gpu_scale path.
- **Forgetting `D3D11_CREATE_DEVICE_BGRA_SUPPORT`.** Without this flag, creating UAV/SRV on BGRA textures silently fails. [CITED: https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-d3d11createdevice]
- **Running D3D11 immediate context from multiple threads** without an external mutex — D3D11 immediate context is explicitly single-threaded. Use deferred contexts for multithreading (out of scope for Phase 8). [CITED: https://learn.microsoft.com/en-us/windows/win32/direct3d11/overviews-direct3d-11-render-multi-thread-intro]

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| Bilinear image downscale on GPU (macOS) | Custom MSL kernel w/ gather+weights | `MPSImageBilinearScale` / `MPSImageLanczosScale` | Apple-tuned, OS-versioned. Only hand-roll when fused with cursor composite (which MPS can't do). [CITED: https://developer.apple.com/documentation/metalperformanceshaders/mpsimagebilinearscale] |
| CVPixelBuffer ↔ MTLTexture bridging | Manual IOSurface + `newTextureWithDescriptor:iosurface:` | `CVMetalTextureCache` + `CVMetalTextureCacheCreateTextureFromImage` | Handles retain/release, format validation, pool lifetime. [CITED: https://developer.apple.com/documentation/corevideo/cvmetaltexturecache] |
| Alpha-over blending | Inline `over()` in effects crate — keep it! | Existing code in `compositor.rs:109-129` | Already written; extract for BGRA-slice variant per D-13. |
| D3D11 texture readback | ad-hoc Map/Unmap with guessed pitch | D3D11 `ID3D11DeviceContext::Map` with `D3D11_MAPPED_SUBRESOURCE` + proper `RowPitch` handling | Pitch may be > `width*4` — must handle per-row copy (same pattern as `cpu_crop_bgra` at `frame_from_wgc.rs:48`). |
| HLSL offline compilation pipeline | custom fxc invocation in build.rs | `D3DCompile` at init time | Avoids build-machine SDK dep; cost is amortized. Plan MUST accept the ~5-20ms init blip. [ASSUMED from D3D docs] |
| Runtime mouse cursor sampling | Hand-written NSEvent / SendMessage | `CGGetMousePosition()` (macOS) / `GetCursorPos()` (Windows) | Both require NO new OS permissions beyond existing Screen Recording/Accessibility grants [VERIFIED: D-11]. |

**Key insight:** The GPU scale path is only partly a hand-rolled-shader problem. The default (scale-only) path leans on Apple's MPS on macOS; the Windows path DOES need a small HLSL compute shader (no built-in MPS equivalent in D3D11). The *fused scale+cursor* path must be hand-written on both platforms because neither framework has a composite-while-scaling primitive.

## Runtime State Inventory

This is NOT a rename/refactor phase — no runtime state migration. All changes are additive. The `compose_frame` → `compose_frame_into_bgra` refactor keeps the old function name re-exported as a thin wrapper for the offline PNG pipeline (see §Refactor strategy below).

**Stored data:** None — no DB schema changes.
**Live service config:** None.
**OS-registered state:** None.
**Secrets/env vars:** None.
**Build artifacts:** New `target/.../gpu_scale.rlib` — clean via `cargo clean` if needed.

## Common Pitfalls

### Pitfall 1: Color space drift (BGRA ↔ RGBA, sRGB ↔ linear)
**What goes wrong:** MTLPixelFormat has `.bgra8Unorm` and `.bgra8Unorm_srgb`. If the shader samples an `_srgb` texture and writes to a non-sRGB one, colors shift ~8% toward highlights.
**Why it happens:** MPS / Metal default is to match input/output format; if we create the output texture with `_srgb` and the input without, the hardware does an unexpected gamma conversion.
**How to avoid:** Both input and output MTLTextures use **plain `.bgra8Unorm`** (no `_srgb`). CVPixelBuffer format is `kCVPixelFormatType_32BGRA` (already set in SCK config — verified at `sck_backend.rs:201`).
**Warning signs:** Golden-image equivalence test (§9) fails with delta in mid-tones only.

### Pitfall 2: D3D11 immediate context threading
**What goes wrong:** Encoder pump thread calls scaler; WGC handler thread *also* has a reference to the same `ID3D11Device` if we borrowed one. D3D11 immediate context is single-threaded — concurrent access produces undefined behavior (driver crashes, silent wrong output).
**Why it happens:** It's tempting to create the scaler's D3D device by reusing WGC's. But the WGC callback runs on its own thread.
**How to avoid:** **gpu_scale creates its OWN `ID3D11Device`.** The WGC texture arrives via `FrameData::NativeWindows` as a COM-retained pointer — we copy/share it into our device via `ID3D11Device::OpenSharedResource` (requires WGC to create textures with `D3D11_RESOURCE_MISC_SHARED` flag — verify at plan time). If `windows-capture` 2.0.0 doesn't set that flag, fallback: CPU-copy from the WGC texture (defeats zero-copy for that frame).
**Warning signs:** Random freezes in Windows E2E; PIX debugger shows two device contexts touching the same texture.

### Pitfall 3: IOSurface lifetime across async frame pump
**What goes wrong:** `CVMetalTextureCacheCreateTextureFromImage` returns a `CVMetalTexture` that references an IOSurface owned by the CVPixelBuffer. If the CVPixelBuffer is released before the Metal command buffer finishes, the IOSurface may be freed — GPU reads garbage.
**Why it happens:** The scaler returns synchronously; the caller then drops the input `CVPixelBufferHandle`. But `command_buffer.commit()` is asynchronous; GPU may not have run the dispatch yet.
**How to avoid:** `command_buffer.waitUntilCompleted()` before returning — OR attach a completion handler that retains the input `CVPixelBuffer` until GPU is done. **Recommend `waitUntilCompleted` for Phase 8 simplicity** — the 3ms dispatch is well within that budget. [CITED: https://developer.apple.com/documentation/metal/mtlcommandbuffer/1442997-waituntilcompleted]
**Warning signs:** Rare frame corruption at high frame rates; valgrind-style use-after-free in CI.

### Pitfall 4: MPS availability / version requirements
**What goes wrong:** MPS is available since macOS 10.13 (2017). The project targets macOS 12+ per Tauri v2 minimums, so it IS available — but `MPSImageBilinearScale` availability varies. `MPSImageScale` (base class) — 10.13+. Newer variants 10.15+. [CITED: https://developer.apple.com/documentation/metalperformanceshaders/mpsimagebilinearscale]
**How to avoid:** Use `MPSImageBilinearScale` (broadest support); do NOT require `MPSImageLanczosScale` (10.15+) or `MPSImageEDSR` (12+). Log MPS init failure and fall back to CPU (probe behavior in §11).
**Warning signs:** macOS 10.13/10.14 user reports "GPU scale unavailable" — acceptable; the CPU fallback picks up.

### Pitfall 5: Shader compilation at runtime vs build time
**What goes wrong:** `D3DCompile` (runtime HLSL compile) requires `d3dcompiler_47.dll` — bundled with Windows 10/11 but not on older systems.
**How to avoid:** We target Windows 10+ per project constraints; the DLL is guaranteed. Fine for Phase 8. If we ever target Win7/8, precompile to `.cso` via build.rs.
**Warning signs:** `D3DCompile` returns `E_NOTIMPL` on user machines — report and fallback.

### Pitfall 6: CI without GPU SDKs
**What goes wrong:** Linux headless CI builds the workspace — will fail to compile `gpu_scale` because Linux has no SCK/WGC/Metal/D3D11.
**How to avoid:** `gpu_scale` is feature-gated in `encoder` via `--features gpu-scale`. CI job with `--no-default-features` skips it entirely. The `gpu_scale` crate itself is cross-platform-compilable (its platform modules are `#[cfg(target_os = ...)]` so the Linux build compiles the trait and error enum but none of the impl code). Verify with `cargo build -p gpu_scale --target x86_64-unknown-linux-gnu` in a PR check — it should succeed and produce a crate with `probe_and_build` returning `Ok(None)`.
**Warning signs:** Linux CI breaks on merge of 08-01; means the Cargo feature gating isn't correct.

### Pitfall 7: Phase 5/6 operator-gated verifications still outstanding
**Context:** Phases 5 and 6 have manual walkthrough checkpoints pending operator execution on real macOS/Windows hosts [VERIFIED: `.planning/STATE.md`]. Phase 8's own manual walkthroughs (D-16 "4K60 window capture for 60s, RAM ≤ 800MB") will **stack** on top of the existing backlog. Phase 8 planner must:
  1. Explicitly list these as "pending" in each plan's VERIFICATION block.
  2. NOT block Phase 8 code-complete on them — they follow the same operator-gated pattern as Phase 5/6.
  3. Flag in phase SUMMARY that Phase 8 adds ≥2 more operator checkpoints to the queue.

## Code Examples

### Example 1: MPSImageBilinearScale usage (macOS — canonical path)

```rust
// crates/gpu_scale/src/macos.rs (sketch; not tested)
use objc2::rc::Retained;
use objc2_metal::{MTLDevice, MTLCreateSystemDefaultDevice, MTLCommandQueue};
use objc2_metal_performance_shaders::MPSImageBilinearScale;
// Source: https://developer.apple.com/documentation/metalperformanceshaders/mpsimagebilinearscale

pub struct MetalScaler {
    device: Retained<dyn MTLDevice>,
    queue: Retained<dyn MTLCommandQueue>,
    mps_scale: Retained<MPSImageBilinearScale>,
    cv_cache: CVMetalTextureCache, // wrapped in Drop-safe type
}

impl MetalScaler {
    pub fn new() -> Result<Self, GpuScaleError> {
        let device = unsafe { MTLCreateSystemDefaultDevice() }
            .ok_or_else(|| GpuScaleError::DeviceInit("no default Metal device".into()))?;
        let queue = device.newCommandQueue()
            .ok_or_else(|| GpuScaleError::DeviceInit("newCommandQueue returned nil".into()))?;
        let mps_scale = unsafe { MPSImageBilinearScale::initWithDevice(&device) };
        let cv_cache = create_cv_metal_texture_cache(&device)?;
        Ok(Self { device, queue, mps_scale, cv_cache })
    }

    fn dispatch(&mut self, input_tex: &dyn MTLTexture, output_tex: &dyn MTLTexture)
        -> Result<(), GpuScaleError>
    {
        let cmd_buf = self.queue.commandBuffer().unwrap();
        unsafe {
            self.mps_scale.encodeToCommandBuffer_sourceTexture_destinationTexture(
                &cmd_buf, input_tex, output_tex,
            );
        }
        cmd_buf.commit();
        cmd_buf.waitUntilCompleted(); // Pitfall 3 mitigation
        Ok(())
    }
}
```

### Example 2: HLSL bilinear downscale compute shader (Windows)

```hlsl
// crates/gpu_scale/src/scale_bgra.hlsl
// include_str!'d from Rust; compiled via D3DCompile at runtime.

Texture2D<float4>   src : register(t0);
SamplerState        samp : register(s0);
RWTexture2D<float4> dst : register(u0);

cbuffer Constants : register(b0) {
    uint2  src_size;
    uint2  dst_size;
    float2 cursor_pos_dst; // in dst pixels; negative = no cursor
    uint2  cursor_size;
}

[numthreads(8, 8, 1)]
void main(uint3 dtid : SV_DispatchThreadID) {
    if (dtid.x >= dst_size.x || dtid.y >= dst_size.y) return;

    float2 uv = (float2(dtid.xy) + 0.5) / float2(dst_size);
    float4 color = src.SampleLevel(samp, uv, 0);

    // Fused cursor composite (D-13 GPU path). Skip when cursor_pos.x < 0.
    // Skin is uploaded to t1; enabled via `cursor-compose` feature branch
    // in the actual shader variant. Stub here; real one at plan time.

    dst[dtid.xy] = color;
}
```

### Example 3: CPU BGRA cursor blit (D-13 CPU path refactor)

**Existing:** `compose_frame(canvas_w, canvas_h, sample, skin, ripples)` returns a new `RgbaImage`. Signature at `crates/effects/src/cursor/compositor.rs:19`.

**Phase 8 refactor:**

```rust
// crates/effects/src/cursor/compositor.rs (new fn — add without removing old)
pub fn compose_frame_into_bgra(
    bgra_buf: &mut [u8],
    buf_width: u32,
    buf_height: u32,
    buf_stride: usize,
    cursor_pos: (f32, f32),
    skin: &SkinBitmap,
) -> Result<(), CompositorError> {
    let (cx, cy) = cursor_pos;
    let sx = cx.round() as i32;
    let sy = cy.round() as i32;
    let sw = skin.pixels.width() as i32;
    let sh = skin.pixels.height() as i32;
    for src_y in 0..sh {
        let dy = sy + src_y;
        if dy < 0 || dy as u32 >= buf_height { continue; }
        for src_x in 0..sw {
            let dx = sx + src_x;
            if dx < 0 || dx as u32 >= buf_width { continue; }
            let sp = *skin.pixels.get_pixel(src_x as u32, src_y as u32);
            let [sr, sg, sb, sa] = sp.0;
            if sa == 0 { continue; }
            // BGRA layout at destination.
            let doff = (dy as usize) * buf_stride + (dx as usize) * 4;
            let (db, dg, dr, da) = (bgra_buf[doff], bgra_buf[doff+1], bgra_buf[doff+2], bgra_buf[doff+3]);
            // straight "over" blend, swapping RGB→BGR for skin→buf.
            let sa_f = sa as f32 / 255.0;
            let da_f = da as f32 / 255.0;
            let out_a = sa_f + da_f * (1.0 - sa_f);
            let blend = |src, dst| -> u8 {
                ((src as f32 * sa_f + dst as f32 * da_f * (1.0 - sa_f)) / out_a.max(1e-6))
                    .round().clamp(0.0, 255.0) as u8
            };
            bgra_buf[doff]   = blend(sb, db); // B
            bgra_buf[doff+1] = blend(sg, dg); // G
            bgra_buf[doff+2] = blend(sr, dr); // R
            bgra_buf[doff+3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum CompositorError {
    #[error("buffer too small: expected ≥ {expected}, got {actual}")]
    BufferTooSmall { expected: usize, actual: usize },
}
```

**Keep `compose_frame` as-is** — it's used by `effects::cursor::png_sequence` for the offline PNG-sequence render and by the existing Phase 2 offline compositor path. No public-API break.

### Example 4: Cursor sampler (pump thread)

```rust
// crates/encoder/src/pipeline.rs — new helper
#[cfg(target_os = "macos")]
fn sample_os_cursor() -> (f32, f32) {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    // CGGetMousePosition is technically CGEventSourceStateID::HIDSystemState
    // combined with CGEvent::new / location. core-graphics 0.24 exposes this
    // as CGEvent::location for an event created with
    // CGEvent::new(CGEventSource::new(HIDSystemState)).
    let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok();
    if let Some(src) = src {
        if let Ok(evt) = CGEvent::new(src) {
            let p = evt.location();
            return (p.x as f32, p.y as f32);
        }
    }
    (0.0, 0.0)
}

#[cfg(target_os = "windows")]
fn sample_os_cursor() -> (f32, f32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT { x: 0, y: 0 };
    unsafe { let _ = GetCursorPos(&mut p); }
    (p.x as f32, p.y as f32)
}
```

**Where the sample happens in the pump:** `crates/encoder/src/pipeline.rs:155` — immediately BEFORE `bgra_bytes_of_frame(&frame)`. The frame has already been popped from the mpsc; sampling here binds the position to that frame's `pts` (D-12).

## State of the Art

| Old approach | Current approach | When changed | Impact |
|--------------|------------------|--------------|--------|
| FFmpeg libswscale on CPU | Metal/D3D11 compute pre-encode | Phase 8 | 3ms/frame budget at 4K60, frees CPU for capture + cursor sampling |
| Post-only cursor overlay (effects PNG sequence, offline) | Live cursor composite during record | Phase 8 | User sees branded cursor in raw recording, not just polished export |
| `compose_frame` → `RgbaImage` → write to disk | `compose_frame_into_bgra(&mut [u8])` | Phase 8 D-13 | Zero-alloc in hot path; same pixel math preserved for offline use |

**Deprecated/outdated (none for Phase 8):** We are NOT deprecating `compose_frame`, `compose_frame_png_sequence`, or any existing Phase 2 functionality. All refactors are additive per D-14/D-15.

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | `windows-capture` 2.0.0 doesn't expose its internal `ID3D11Device` as a public API, so we create our own. | Alternatives considered | If we CAN reuse WGC's device, we save ~50ms init + avoid cross-device texture sharing. Minor perf win. Verify at plan 08-03 time. [ASSUMED] |
| A2 | `CGEvent::new(HIDSystemState).location()` equals `CGGetMousePosition()` output. | Code Example 4 | If it's subtly different (e.g., different DPI scaling), cursor position will be off by retina factor on some displays. Verify with a manual smoke test. [ASSUMED] |
| A3 | WGC-produced `ID3D11Texture2D` textures have `D3D11_RESOURCE_MISC_SHARED` or can be opened via `OpenSharedResource`. | Pitfall 2 | If not, we'd need to CPU-copy before scaling — breaks zero-copy promise for that path. Verify by inspecting `windows-capture` 2.0.0 source before locking 08-03 plan. [ASSUMED] |
| A4 | `AVAssetWriterInputPixelBufferAdaptor` built with `sourcePixelBufferAttributes: None` will accept an arbitrary-dimension CVPixelBuffer without reconfiguration. | Pattern 3 | If AVAssetWriter enforces the dimensions declared in `AVVideoWidthKey`/`AVVideoHeightKey` (vt_writer.rs:158-159), we'll need to update those declarations to match the SCALED output. Most likely: we DO need to set them to target dims — planner should assume yes and update `EncodeConfig`'s `width`/`height` to post-scale values before constructing VtWriter. [ASSUMED — the AV docs are ambiguous; VERIFY with a small test at 08-02 start] |
| A5 | `D3DCompile` + `d3dcompiler_47.dll` available on all supported Windows 10/11 systems. | Pitfall 5 | True for Win10 1809+ and all Win11. Project minimum not explicitly documented; infer Win10 21H2 based on Tauri v2 requirements. [ASSUMED] |
| A6 | MPS `MPSImageBilinearScale` is available on macOS 12+ (project's minimum per Tauri v2). | Pitfall 4 | True per Apple docs; cited. [CITED] |
| A7 | The encoder pump thread is a tokio worker, NOT a dedicated OS thread; D3D11 immediate context's single-thread-affinity constraint is honored so long as we don't move the scaler between tokio workers. | Pitfall 2 | Tokio `spawn` can move a task between workers unless we use `spawn_blocking` or a `LocalSet`. **Recommend: move the D3D11 scaler dispatch to `tokio::task::spawn_blocking` on Windows** — the 3ms budget tolerates the thread-hop cost. [ASSUMED based on tokio model] |
| A8 | The cursor position at the instant of `sample_os_cursor()` correlates to the frame PTS within one vsync interval. | D-12 | At 60fps the OS cursor position lags the frame timestamp by up to ~16ms. For the MVP this is acceptable (D-10 defers smoothing); if perceptible jitter appears, Phase 9 does interpolation. [ASSUMED] |

## Open Questions

1. **Does `windows-capture` 2.0.0 create textures with `D3D11_RESOURCE_MISC_SHARED`?**
   - What we know: crate source available on GitHub (NiiightmareXD/windows-capture); likely NO by default.
   - What's unclear: whether `Settings` exposes a way to turn it on, or whether we need a fork/PR.
   - Recommendation: Plan 08-03's first task is "verify WGC shared-texture feasibility"; if blocked, emit `FrameData::NativeWindows` only when the texture turns out to be shareable — otherwise keep `Pooled` and scale on CPU-copy.

2. **Should `FrameData::NativeWindows` be gated by `gpu-scale` on the `capture` crate?**
   - What we know: The variant already exists in `frame.rs:86` unconditionally; only `NEVER emitted` today.
   - What's unclear: Whether adding a `capture/gpu-scale` feature is cleaner than just having the variant always present and emitted-or-not.
   - Recommendation: **Keep variant always present, gate emission** behind a runtime flag set by the encoder probe. Simpler Cargo graph; no new feature on `capture`. D-05 says `gpu-scale` is the encoder's feature, not capture's.

3. **What's the SSIM tolerance for the golden-image equivalence test (D-13)?**
   - What we know: CPU and GPU bilinear should produce identical-up-to-rounding output for nearest integer cursor positions.
   - What's unclear: Sub-pixel cursor positions, MPS's exact filter coefficients.
   - Recommendation: **Target byte-equal with ±1 tolerance per channel** (not SSIM). SSIM 0.999 is very permissive; ±1 per channel catches real drift. If MPS produces larger deltas due to gamma correction, relax to SSIM ≥ 0.999 AS A FALLBACK THRESHOLD, NOT the primary.

4. **Does the VT fast path's `AVVideoWidthKey` / `AVVideoHeightKey` need to change when we scale pre-append?**
   - What we know: These are declared at writer-init time at `vt_writer.rs:158-159` using `cfg.width`/`cfg.height`.
   - What's unclear: Whether AVAssetWriter is strict about these matching the appended buffer dims.
   - Recommendation: Plan 08-02 must include: **pre-writer-init, if gpu_scale is active, update `cfg.width` and `cfg.height` to post-scale values.** Add a test that confirms the writer accepts buffers matching the declared (post-scale) dims.

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Metal | macOS GPU scale | ✓ (macOS 12+) | OS-provided | CPU libswscale |
| MPS (MetalPerformanceShaders) | macOS bilinear downscale | ✓ (10.13+) | OS-provided | Custom MSL kernel |
| D3D11 | Windows GPU scale | ✓ (Win10+) | OS-provided | CPU libswscale |
| D3DCompiler | HLSL runtime compile | ✓ (Win10 1809+) | `d3dcompiler_47.dll` OS-provided | Fail gpu_scale init; CPU fallback |
| CoreGraphics (CGEvent) | macOS cursor sampling | ✓ | OS-provided | — |
| User32 (GetCursorPos) | Windows cursor sampling | ✓ | OS-provided | — |
| objc2-metal on crates.io | Build dep | ✓ | 0.3.2 (verified) | — |
| objc2-metal-performance-shaders on crates.io | Build dep | ✓ | 0.3.2 (verified) | — |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None at runtime; at dev time we require macOS for Metal-impl work and Windows for D3D11-impl work. CI matrix already covers both (per Phase 5/6 CI workflows).

## Validation Architecture

(Nyquist validation is not explicitly disabled in `.planning/config.json` — include per orchestrator convention.)

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `cargo test` + `cargo-nextest` (existing); `criterion` for benches |
| Config file | per-crate `Cargo.toml`; no separate test config |
| Quick run | `cargo test -p gpu_scale` |
| Full suite | `cargo test --workspace --features gpu-scale` and `cargo test --workspace --no-default-features` |

### Phase Requirements → Test Map

| D-ID | Behavior | Test type | Automated command | File exists? |
|------|----------|-----------|-------------------|-------------|
| D-01, D-04 | `gpu_scale` crate compiles standalone | unit/build | `cargo build -p gpu_scale` | ❌ Wave 0 |
| D-03 | `FrameData::NativeWindows` emission path | unit | `cargo test -p capture --features real-capture-windows` | partial (feature exists) |
| D-05 | Build green with+without `gpu-scale` | CI | `cargo build --workspace && cargo build --workspace --no-default-features` | CI workflow exists; add matrix entry |
| D-06 | Scaler returns packed BGRA OR CVPixelBuffer | unit | `cargo test -p gpu_scale -- scale_bgra_roundtrip / scale_cvpb_roundtrip` | ❌ Wave 0 |
| D-07 | 4K60 ≤ 3ms/frame (M1 + RTX 3060) | criterion bench + manual | `cargo bench -p gpu_scale -- scale_4k_to_1920` | ❌ Wave 0 |
| D-08, D-09 | `include_styled_cursor` field + forces `include_cursor=false` | unit | `cargo test -p capture -- capture_config_styled_cursor_forces_include_false` | ❌ Wave 0 |
| D-10 | Static-skin MVP — cursor visible at sampled position | unit | `cargo test -p effects -- compose_frame_into_bgra_blits_skin` | ❌ Wave 0 |
| D-11, D-12 | Cursor sampler + PTS stamp | unit | `cargo test -p encoder -- cursor_stamp_pairs_with_frame_pts` | ❌ Wave 0 |
| D-13 | CPU and GPU compositor produce ≥ byte-equal ±1 output | integration | `cargo test -p gpu_scale -- cursor_cpu_gpu_equivalence` (requires GPU) | ❌ Wave 0 |
| D-15 | New `RecordingEvent::GpuScaleFailed` variant preserves existing variants | unit | `cargo test -p encoder -- recording_event_existing_variants_preserved` | ❌ Wave 0 |
| D-16 manual | 4K60 60s walkthrough, RAM ≤ 800 MB | manual | operator checklist in 08-VERIFICATION.md | ❌ per-phase |

### Sampling Rate
- **Per task commit:** `cargo test -p gpu_scale -p encoder -p capture -p effects`
- **Per wave merge:** `cargo test --workspace --features gpu-scale && cargo test --workspace --no-default-features`
- **Phase gate:** full suite green + criterion bench within D-07 budget + operator manual walkthroughs complete (may be auto-approved per project's `workflow.auto_advance` per Phase 5/6 precedent)

### Wave 0 gaps
- [ ] `crates/gpu_scale/Cargo.toml` — new crate
- [ ] `crates/gpu_scale/src/lib.rs` — trait + error + probe_and_build
- [ ] `crates/gpu_scale/src/macos.rs` — MetalScaler impl
- [ ] `crates/gpu_scale/src/windows.rs` — D3D11Scaler impl
- [ ] `crates/gpu_scale/src/scale_bgra.hlsl` — compute shader
- [ ] `crates/gpu_scale/src/composite.metal` — fused-path kernel
- [ ] `crates/gpu_scale/tests/cpu_gpu_equivalence.rs` — golden-image harness
- [ ] `crates/gpu_scale/benches/scale_bgra.rs` — criterion bench for D-07
- [ ] `crates/effects/src/cursor/compositor.rs` — new `compose_frame_into_bgra` fn
- [ ] `crates/encoder/src/pipeline.rs` — integrate cursor sampler + scaler routing
- [ ] `crates/encoder/src/macos/vt_writer.rs` — scaler hook before `appendPixelBuffer_withPresentationTime`
- [ ] `crates/encoder/src/config.rs` — runtime-conditional `-vf scale` removal
- [ ] `crates/capture/src/backend.rs` — new `include_styled_cursor: bool` field on `CaptureConfig`
- [ ] `crates/capture/src/windows/wgc_backend.rs` — emit `FrameData::NativeWindows` when feature-active
- [ ] `apps/desktop/src-tauri/src/commands/encode.rs` — `include_styled_cursor: Option<bool>` on `StartRecordingArgs`; D-09 coupling in config assembly
- [ ] `apps/desktop/src/ipc/capture.ts` / types — additive `includeStyledCursor?`
- [ ] `apps/desktop/src/features/recorder/recording-view.tsx` — UI toggle

*(Framework install: N/A — all deps already in workspace.)*

## Security Domain

Phase 8 does NOT touch authentication, authorization, crypto, secret storage, or network boundaries. The one security-adjacent consideration:

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes (minor) | Cursor position from `CGGetMousePosition` / `GetCursorPos` is OS-trusted; shader constants derived from it are clamped to dst texture bounds inside HLSL/MSL |
| V6 Cryptography | no | — |
| Others | no | — |

**Threat pattern:** None — all frame data is in-process, no new IPC surfaces (D-14).

---

## Answers to specific focus questions

### 1. `gpu_scale` crate structure

- **Files:** 5 source files (lib.rs, macos.rs, windows.rs, scale_bgra.hlsl, composite.metal) + 1 test + 1 bench = **7 files total**.
- **Cargo.toml:** shown in §Standard Stack. Two `cfg(target_os)`-gated target tables; one `gpu-scale`-on-encoder feature; one `cursor-compose` feature on gpu_scale itself that toggles the fused shader variant.
- **Trait:** shown in §Pattern 1 above. Two methods (`scale_to_bgra`, `scale_to_cvpixelbuffer`), three input variants, optional cursor overlay.
- **Error enum:** six variants (`DeviceInit`, `ShaderCompile`, `TextureCreate`, `Dispatch`, `Readback`, `Unsupported`); maps Metal `NSError`, D3D11 `HRESULT`, and MPS errors into `String` payloads. **CPU fallback behavior:** `probe_and_build` returns `Ok(None)` on any `DeviceInit`/`ShaderCompile` failure (treated as "GPU unavailable, not an error"); caller emits `RecordingEvent::GpuScaleFailed { reason }` (new variant, D-15) and proceeds on the CPU path.

### 2. Metal impl details (macOS)

**Minimum API calls:**
1. `MTLCreateSystemDefaultDevice()` — once per scaler instance
2. `device.newCommandQueue()` — once per scaler
3. `MPSImageBilinearScale::initWithDevice(&device)` — once per scaler
4. `CVMetalTextureCacheCreate` — once; stores the cache
5. Per frame (input CVPixelBuffer path):
   - `CVMetalTextureCacheCreateTextureFromImage` → CVMetalTexture wrapping input
   - `CVMetalTextureGetTexture` → `MTLTexture`
   - Allocate output MTLTexture OR allocate output CVPixelBuffer via `CVPixelBufferCreate(...)` + wrap via CVMetalTextureCache
   - `queue.commandBuffer()` → `MTLCommandBuffer`
   - `mps_scale.encodeToCommandBuffer_sourceTexture_destinationTexture(cmdbuf, src, dst)`
   - (If cursor overlay): second kernel dispatch for composite — OR fuse in a single custom MSL kernel in the `cursor-compose` feature variant
   - `cmdbuf.commit()` + `cmdbuf.waitUntilCompleted()` (Pitfall 3)
6. For BGRA output: `CVPixelBufferLockBaseAddress` + memcpy to `Vec<u8>`
7. For CVPixelBuffer output: return the CVPixelBuffer pointer (already +1 retained)

**MPS vs custom kernel:** MPS for scale-only (default path); custom MSL compute for the fused scale+cursor path. The custom kernel is ~40 LoC of MSL — sampler-based bilinear read from src, alpha-blend cursor skin sampled from a second texture when dst coords fall within the cursor rect.

### 3. D3D11 impl details (Windows)

**Minimum API calls:**
1. `D3D11CreateDevice` with `D3D_DRIVER_TYPE_HARDWARE` + `D3D11_CREATE_DEVICE_BGRA_SUPPORT` — once
2. Get `ID3D11DeviceContext` (immediate) — once
3. `D3DCompile` on `include_str!("scale_bgra.hlsl")` — once at init (~5-20ms one-shot)
4. `device.CreateComputeShader(bytecode)` — once
5. Per frame:
   - Input texture: either `OpenSharedResource` (if WGC texture is shared) OR `CreateTexture2D` + `CopySubresourceRegion` from WGC texture (fallback)
   - `device.CreateShaderResourceView` on input
   - `device.CreateTexture2D` for output (BGRA, `D3D11_BIND_UNORDERED_ACCESS`)
   - `device.CreateUnorderedAccessView` on output
   - `device.CreateBuffer` for constants (cbuffer) — once; `UpdateSubresource` per frame
   - `context.CSSetShader`, `CSSetShaderResources`, `CSSetUnorderedAccessViews`, `CSSetConstantBuffers`, `CSSetSamplers`
   - `context.Dispatch((dst_w + 7) / 8, (dst_h + 7) / 8, 1)`
   - For BGRA readback: `context.CopyResource(staging, output)` + `context.Map(staging)` + per-row copy (handle `RowPitch` possibly > `width*4`) + `context.Unmap`

**HLSL source:** `include_str!("scale_bgra.hlsl")` + `D3DCompile` at init. No precompile step; no build-script complexity.

**Thread-safety:** The pump thread owns the immediate context. Planner MUST express this in plan 08-03 task definitions: "D3D11Scaler is created on, lives on, and is called exclusively from the encoder frame-pump thread. Use `tokio::task::spawn_blocking` to run dispatch if the pump is a tokio future" (see Assumption A7).

### 4. VtWriter integration (D-02)

Detailed in §Pattern 3 above. Key insights:

- **Substitution point:** `crates/encoder/src/macos/vt_writer.rs:265-290` — BEFORE `isReadyForMoreMediaData` check. Scaler consumes the input `CVPixelBufferHandle`, produces a new CVPixelBuffer, replaces `buffer` with the scaled one.
- **Scaler returns a NEW CVPixelBuffer** — do NOT resize in place (source is read-only-pool from SCK).
- **AVAssetWriter reconciliation:** `sourcePixelBufferAttributes: None` at vt_writer.rs:215 means no format negotiation needed. BUT `AVVideoWidthKey`/`AVVideoHeightKey` (vt_writer.rs:158-159) DO need to equal the scaled output dims — see Open Question 4.
- **Fuse this task with the Metal impl task** (plan 08-02) because they share the macOS dispatch surface and test harness. Splitting into separate plans creates a dependency wait for no benefit.

### 5. `FrameData::NativeWindows` (D-03)

- **Already declared** in `frame.rs:86-87` as `NativeWindows(crate::windows::raii::D3DTextureHandle)` — variant exists but never emitted [VERIFIED: `frame.rs:86-87`, `frame_from_wgc.rs` search].
- **`D3DTextureHandle`** currently is just a `*mut c_void` + COM Release-on-drop [VERIFIED: `windows/raii.rs:7-35`]. **Not enough for the scaler**: the scaler needs width/height/stride to create an SRV. Two options:
  - (a) Add width/height/format fields to `D3DTextureHandle` (cleaner).
  - (b) Pass width/height via the outer `Frame` struct (already present: `frame.width_px`, `frame.height_px`).
  - **Recommend (b)** — keep `D3DTextureHandle` minimal; scaler reads dims from `Frame.width_px`/`height_px`. The D3D11 SRV query API can also read dims from the texture itself via `GetDesc`.
- **Where CPU copy happens today:** `crates/capture/src/windows/frame_from_wgc.rs:166-207` — `buffer.as_nopadding_buffer(&mut bgra)` copies from the WGC staging texture into pool-backed `Vec<u8>`. The diff to emit `NativeWindows`:
  - Call `frame.as_raw_texture()` (if `windows-capture` 2.0.0 exposes it — VERIFY at plan time; if not, we need a crate fork or PR).
  - Wrap raw pointer in `D3DTextureHandle::from_raw(ptr)` with appropriate AddRef.
  - Return `FrameData::NativeWindows(handle)` instead of `FrameData::Pooled(...)`.
  - Gate on a runtime flag (not a Cargo feature on `capture`) so the encoder can still use the CPU path when `gpu_scale` probed as unavailable.
- **`capture` crate feature:** **No.** Always-present variant; runtime-gated emission (Open Question 2).

### 6. `CaptureConfig` + `start_recording` wiring

**Exact edits:**

- `crates/capture/src/backend.rs` — **after line 25** (between `include_cursor` and `fps_target`):
  ```rust
  pub include_cursor: bool,
  /// D-08 / D-10: composite effects-crate styled cursor into frames live.
  /// When true, D-09 semantic coupling forces backend `include_cursor` to
  /// false to prevent a double-cursor artifact.
  pub include_styled_cursor: bool,
  pub fps_target: u32,
  ```
  Also update `CaptureConfig::new_for_target` default (line 42) to set `include_styled_cursor: false`.

- `apps/desktop/src-tauri/src/commands/encode.rs:240` — append a field:
  ```rust
  #[serde(default)]
  pub include_cursor: Option<bool>,
  /// D-08. Optional; default false. When true, D-09 forces include_cursor=false.
  #[serde(default)]
  pub include_styled_cursor: Option<bool>,
  ```

- `apps/desktop/src-tauri/src/commands/encode.rs:364-370` (CaptureConfig assembly) — replace:
  ```rust
  let styled = args.include_styled_cursor.unwrap_or(false);
  let cap_cfg = CaptureConfig {
      target: capture_target,
      // D-09: styled cursor forces OS cursor off.
      include_cursor: if styled { false } else { args.include_cursor.unwrap_or(true) },
      include_styled_cursor: styled,
      fps_target: args.fps,
      pixel_format: PixelFormat::Bgra,
      queue_cap_bytes: ByteBoundedQueue::DEFAULT_CAP_BYTES,
  };
  ```

### 7. CPU BGRA compositor (D-13 CPU path)

Signature shown in §Code Examples. Key delta from `compose_frame`:

- `compose_frame` allocates a fresh `RgbaImage` (ImageBuffer) and returns it.
- `compose_frame_into_bgra` takes `&mut [u8]` and blits in place.
- Existing `over()` fn at `compositor.rs:109` handles RGBA→RGBA; the new fn needs to swap R↔B since destination is BGRA.
- Keep `compose_frame` unchanged; add `compose_frame_into_bgra` as a sibling.

Cursor sample is taken in the encoder pump (§Code Example 4), **immediately after** `frames.recv().await` returns — line 152 of `pipeline.rs`. Concretely: add a `let cursor_pos = sample_os_cursor();` at line 153, right before `width_px = frame.width_px`.

### 8. GPU compositor (D-13 GPU path)

- **Skin upload once per recording:** At scaler init (or first frame), upload `SkinBitmap.pixels` to a persistent `MTLTexture` (macOS) / `ID3D11Texture2D` (Windows). On macOS: use `texture.replace(region:mipmapLevel:withBytes:bytesPerRow:)`. On Windows: `CreateTexture2D` with `D3D11_SUBRESOURCE_DATA`.
- **Per-frame:** pass cursor `(x, y)` as a `cbuffer` (HLSL) / constant buffer (Metal). Also skin dims (fixed per recording but cheap to re-bind).
- **Shader logic (MSL/HLSL pseudocode):**
  ```
  For each output pixel (dx, dy):
    uv = (dx + 0.5, dy + 0.5) / dst_size
    base = src.Sample(uv)
    rel_x = dx - cursor_pos.x
    rel_y = dy - cursor_pos.y
    if rel_x >= 0 && rel_x < skin_w && rel_y >= 0 && rel_y < skin_h:
      skin = skin_tex[rel_x, rel_y]  // BGRA
      out = alpha_blend(skin, base)   // straight "over"
    else:
      out = base
    dst[dx, dy] = out
  ```
- **Binding layout (D3D11/HLSL):** `t0` = input BGRA; `t1` = skin BGRA; `s0` = bilinear sampler; `u0` = output UAV; `b0` = cbuffer (cursor pos + sizes). (Metal uses argument buffers — same concept, different syntax.)

### 9. Golden-image equivalence test (D-13 constraint)

- **Test fixture:** deterministic synthetic 640×480 BGRA frame (checkerboard + gradient so bilinear sampling has signal) + fixed `SkinBitmap` (one of the 5 bundled from Phase 2, e.g., `skins::load_skin("Default")`) + fixed cursor pos at (200.0, 150.0) integer → scale target 320 wide.
- **Run both paths:**
  - CPU: `compose_frame_into_bgra` on the source, then a known CPU bilinear downscale (e.g., a simple reference bilinear impl in the test harness — NOT libswscale, because we're testing our CPU compositor vs GPU compositor).
  - GPU: `gpu_scale.scale_to_bgra(src, 320, Some(cursor))` with fused path.
- **Assertion:** byte-equal with ±1 per channel (primary); SSIM ≥ 0.999 as fallback (documented reason: gamma rounding in GPU differs by one LSB).
- **Location:** `crates/gpu_scale/tests/cpu_gpu_equivalence.rs` — integration test, `#[cfg(target_os = "macos")]` or `windows` (both tested separately on CI matrix). Skip on Linux.
- **SSIM crate:** none is standard-issue; roll a simple ~30-LoC SSIM in the test harness (or, if time is tight in 08-05, skip SSIM and use pure byte-equal with tolerance — cleaner).

### 10. Runtime conditional for FFmpeg `-vf scale`

- **Where:** `crates/encoder/src/config.rs:101-102`:
  ```rust
  let scale_filter =
      "scale='min(1920,iw)':-2,scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string();
  ```
  Add a new `EncodeConfig` field: `pub upstream_scale_applied: bool`. Default false.
- **Runtime toggle:** At encoder-pump entry (or VtWriter setup), after the scaler is built via `probe_and_build`, set `cfg.upstream_scale_applied = gpu_scaler.is_some() && frame_supports_native_path`.
- **Args builder:** Replace line 162 `scale_filter` with:
  ```rust
  let vf = if self.upstream_scale_applied {
      // Upstream already produced target-width even-dim BGRA. Skip scale.
      // Still need even-dim guard in case upstream emitted odd dims.
      "scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string()
  } else {
      scale_filter
  };
  ```
- **Decision flow:** encoder pump owns `probe_and_build` (as a step before the pump loop); stores `gpu_scaler: Option<Box<dyn GpuScaler>>` on pump state; passes boolean through to `EncodeConfig` before sidecar spawn.

### 11. Feature probe + fallback (D-07)

- **Where:** `crates/encoder/src/pipeline.rs::EncodePipeline::start` — just after `probe_encoders` is called (in the Tauri command, not the crate itself), probe gpu_scale.
- **Struct/flag name:** Add `gpu_scaler: Option<Box<dyn gpu_scale::GpuScaler>>` to the encoder pump's local state. Not on `EncodeConfig` (too lifetime-annoying for Send/Sync); pass via pump-local `mut` binding.
- **Probe call:**
  ```rust
  #[cfg(feature = "gpu-scale")]
  let mut gpu_scaler = match gpu_scale::probe_and_build(target_width) {
      Ok(Some(s)) => Some(s),
      Ok(None) => {
          tracing::info!(target: "storycapture::encoder",
              "gpu_scale unavailable; falling back to CPU libswscale");
          None
      }
      Err(e) => {
          tracing::warn!(target: "storycapture::encoder",
              "gpu_scale probe failed: {e}; falling back to CPU");
          // Emit telemetry (D-15).
          // (telemetry sender not directly available here; queue via the
          // existing progress_tx or add a new RecordingEvent channel — see plan 08-01)
          None
      }
  };
  ```
- **Fallback behavior (D-07 perf failure path):** The 3ms budget is enforced by the **criterion bench** at CI time, NOT at runtime. At runtime, the scaler dispatches whatever it's given; there's no runtime budget-miss fallback. If the bench fails, Phase 8 does not ship.

### 12. Plan decomposition

Recommended split (5 plans — each independently buildable, pattern mirrors Phase 2's plan granularity):

#### **08-01 — `gpu_scale` crate scaffold + trait + feature gate + CPU-path regression**
- Create `crates/gpu_scale/Cargo.toml`, `src/lib.rs` (trait + error + stub `probe_and_build` returning `Ok(None)` on every platform for now).
- Add workspace membership.
- Add optional `gpu_scale` dep to `encoder/Cargo.toml` behind feature `gpu-scale` (default on).
- Add `upstream_scale_applied: bool` to `EncodeConfig`; make `config.rs` runtime-conditional (wired but always false at this stage).
- Add `RecordingEvent::GpuScaleFailed { reason: String }` variant.
- Test: build green with and without `--features gpu-scale`; `probe_and_build` returns `Ok(None)` everywhere; encoder path unchanged.
- **Risks:** None material — pure scaffolding.

#### **08-02 — Metal impl + MPS downscale + VtWriter integration**
- `gpu_scale/src/macos.rs` — `MetalScaler` using MPS for scale-only path.
- Wire into `vt_writer.rs` append loop (substitute CVPixelBuffer pre-append).
- Update `EncodeConfig.width`/`height` to post-scale values when scaler is active.
- Tests: roundtrip unit test on an MPS-scaled CVPixelBuffer; assert output dims; assert no `CVPixelBufferLockBaseAddress` in the VT path.
- Criterion bench: 4K60 → 1920 on M-series; fail gate if > 3ms median.
- **Risks:** Open Question 4 (AVVideoWidthKey mismatch). Open Question 2 (variant gating). Pitfall 1 (sRGB drift).

#### **08-03 — D3D11 impl + HLSL compute + FrameData::NativeWindows emission + CPU-readback path**
- `gpu_scale/src/windows.rs` — `D3D11Scaler`, runtime `D3DCompile` on `scale_bgra.hlsl`.
- `crates/capture/src/windows/frame_from_wgc.rs` — emit `FrameData::NativeWindows` when runtime flag set AND WGC texture is shareable (verify Assumption A3 first).
- Wire into encoder pump for `FrameData::NativeWindows` branch.
- Add `encoder/pipeline.rs` FrameData::NativeWindows handling (was previously an error return at `pipeline.rs:49`).
- Tests: unit test on a synthesized D3D11 texture (test uses its own device); criterion bench on 4K60.
- **Risks:** A1, A3, A7 (WGC device sharing, MISC_SHARED flag, tokio thread affinity). Pitfall 2 (immediate-context threading).

#### **08-04 — Live cursor CPU compositor + CaptureConfig wiring + UI toggle**
- `crates/effects/src/cursor/compositor.rs` — add `compose_frame_into_bgra`; export in `mod.rs`.
- `crates/capture/src/backend.rs` — add `include_styled_cursor` field.
- `apps/desktop/src-tauri/src/commands/encode.rs` — `StartRecordingArgs.include_styled_cursor`; D-09 coupling in `cap_cfg` assembly.
- `apps/desktop/src/ipc/capture.ts` types regen + `recording-view.tsx` UI toggle.
- `crates/encoder/src/pipeline.rs` — cursor sampler (§4 above) + CPU compositor call per frame when `include_styled_cursor` is true AND no GPU scaler is active for this frame type.
- Tests: compositor blits at correct coords, skin uploaded once, D-09 flip works, UI regression snapshot.
- **Risks:** A2 (CGEvent API compat), A8 (cursor lag acceptable for MVP).

#### **08-05 — Fused GPU composite (Metal+HLSL) + golden-image equivalence test + criterion gate**
- Add `cursor-compose` feature on `gpu_scale`.
- `gpu_scale/src/composite.metal` — custom MSL compute kernel combining scale+overlay.
- `gpu_scale/src/scale_bgra.hlsl` — extend to branch on `cursor_pos.x >= 0`.
- Upload skin texture once per recording in both backends.
- `crates/gpu_scale/tests/cpu_gpu_equivalence.rs` — golden-image test (§9).
- Manual walkthrough: 4K60 60s recording with styled cursor, operator-verify cursor appears and OS cursor absent; RAM ≤ 800 MB.
- **Risks:** Pitfall 1 (color space drift making goldens fail); Open Question 3 (SSIM tolerance calibration). **This plan is the D-13 completion gate and likely the slowest.**

### 13. Open risks the planner must call out explicitly

1. **D3D11 immediate context threading** (Pitfall 2, Assumption A7) — codify in plan 08-03 that the scaler is owned by exactly one thread for its whole lifetime.
2. **IOSurface lifetime** (Pitfall 3) — mandate `waitUntilCompleted` in plan 08-02.
3. **MPS availability / version** (Pitfall 4) — pin to `MPSImageBilinearScale`; document 10.13+ minimum; confirm against Tauri v2 minimum.
4. **Color-space drift (BGRA vs RGBA vs sRGB vs linear)** (Pitfall 1) — all textures plain `.bgra8Unorm` / `DXGI_FORMAT_B8G8R8A8_UNORM` (NOT `_SRGB`).
5. **Runtime shader compilation** (Pitfall 5) — rely on `d3dcompiler_47.dll`; document Win10 1809+ minimum; no offline `.cso`.
6. **CI without GPU SDKs** (Pitfall 6) — every plan's CI matrix must include a `--no-default-features` build on Linux.
7. **WGC shared-resource flag** (Assumption A3) — plan 08-03 opens with a 1-day spike to verify `windows-capture` 2.0.0 exposes shareable textures. If not, fallback to CPU-copy zero-fallback and note a follow-up.
8. **AVAssetWriter dimension negotiation** (Open Question 4, Assumption A4) — plan 08-02 tests this assumption before writing any user-facing code.
9. **Phase 5/6 operator-gated verifications stacking up** — Phase 8 adds ≥2 more; VERIFICATION.md must list them; do NOT block Phase 8 code-complete on them.
10. **CLAUDE.md "no workarounds" enforced** — the CPU-fallback behavior is not a workaround; it's the designed probe-and-fallback protocol (D-07). But silently swallowing shader-compile failures IS a workaround — always emit `RecordingEvent::GpuScaleFailed` with reason.

## Sources

### Primary (HIGH confidence — verified via direct code read)
- `crates/capture/src/frame.rs` — FrameData enum declarations (lines 81-97)
- `crates/capture/src/backend.rs` — CaptureConfig shape (lines 21-32)
- `crates/capture/src/windows/wgc_backend.rs` — cursor toggle site (line 265)
- `crates/capture/src/windows/frame_from_wgc.rs` — CPU copy path (lines 166-207)
- `crates/capture/src/windows/raii.rs` — D3DTextureHandle (full file)
- `crates/capture/src/windows/pool.rs` — PooledBuf pattern
- `crates/capture/src/macos/raii.rs` — CVPixelBufferHandle (full file)
- `crates/capture/src/macos/sck_backend.rs:210` — with_shows_cursor(cfg.include_cursor)
- `crates/encoder/src/pipeline.rs` — frame pump + VtWriter dispatch (lines 138-327)
- `crates/encoder/src/macos/vt_writer.rs` — AVAssetWriter setup (lines 134-217, 265-290)
- `crates/encoder/src/config.rs:101-102` — scale filter construction
- `crates/encoder/src/probe.rs` — runtime probe pattern precedent
- `crates/effects/src/cursor/compositor.rs` — compose_frame fn (lines 19-44), over() (109-129)
- `crates/effects/src/cursor/mod.rs` — public exports
- `apps/desktop/src-tauri/src/commands/encode.rs` — StartRecordingArgs (228-241), start_recording assembly (289-379)
- `Cargo.toml` — workspace members
- `crates/capture/Cargo.toml`, `crates/encoder/Cargo.toml` — dep pins
- `.planning/STATE.md` — phase status, open verifications
- `.planning/phases/08-.../08-CONTEXT.md` — full locked-decision set

### Secondary (MEDIUM confidence — verified against crates.io)
- `objc2-metal` 0.3.2 — `cargo search` 2026-04-18
- `objc2-metal-performance-shaders` 0.3.2 — `cargo search` 2026-04-18

### Tertiary (CITED — docs not re-verified in this session)
- https://developer.apple.com/documentation/metalperformanceshaders/mpsimagebilinearscale
- https://developer.apple.com/documentation/corevideo/cvmetaltexturecache
- https://developer.apple.com/documentation/metal/mtlcommandbuffer/1442997-waituntilcompleted
- https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-d3d11createdevice
- https://learn.microsoft.com/en-us/windows/win32/direct3d11/overviews-direct3d-11-render-multi-thread-intro
- https://docs.rs/objc2-io-surface

### Not re-verified in this session
- `windows-capture` 2.0.0 API surface for shared textures (A1, A3) — planner must verify at plan 08-03 start.
- `CGEvent::new(HIDSystemState).location()` vs `CGGetMousePosition()` exact equivalence (A2).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all crate versions verified via `cargo search` or existing Cargo.toml pins in the repo.
- Integration points: HIGH — every code line cited was read directly from the repo.
- GPU API specifics (MSL/HLSL exact signatures, MPS constructor parameters): MEDIUM — cited from Apple/Microsoft docs in training data; not runtime-verified on this machine.
- WGC shared-texture access (A1/A3): LOW — explicitly flagged as a 1-day spike at start of plan 08-03.
- AVAssetWriter dimension negotiation (A4): LOW — flagged as test-first in plan 08-02.

**Research date:** 2026-04-18
**Valid until:** 2026-05-18 (30 days; stable platform APIs, no fast-moving ecosystem)
