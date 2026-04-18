# Phase 8: Recording engine polish — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `08-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-04-18
**Phase:** 08-recording-engine-polish-gpu-downscale-live-cursor-overlay-se
**Areas discussed:** GPU-scale stack, WGC native-surface support, Cursor toggle semantics, Cursor features in scope

---

## Gray areas offered (multiSelect)

| Option | Description | Selected |
|--------|-------------|----------|
| GPU-scale stack | Raw metal + windows-rs D3D11 (scout recommends) vs wgpu. VtWriter integration — scale inside VT to preserve zero-copy, or before backend selection. | ✓ |
| WGC native-surface support | Add `FrameData::NativeWindows` for zero-copy D3D11 texture path, or keep CPU-copy `Pooled`. | ✓ |
| Cursor toggle semantics | One atomic flag vs independent `include_styled_cursor`; OS cursor on/off when styled is on. | ✓ |
| Cursor features in scope | Static skin only vs + ripples vs full post-prod parity; CPU-only vs dual CPU+GPU compositor. | ✓ |

All four selected — every area discussed.

---

## GPU-scale stack

### Crate choice

| Option | Description | Selected |
|--------|-------------|----------|
| Raw metal + windows-rs D3D11 | Scout-recommended. Tighter hot path, no wgpu per-frame overhead. | ✓ |
| wgpu | Unified Rust API; adds Device/Queue/CommandBuffer overhead on 30–60 fps hot path. | |

**User's choice:** Raw metal + windows-rs D3D11

### VtWriter (macOS) zero-copy integration

| Option | Description | Selected |
|--------|-------------|----------|
| Scale inside VtWriter | Metal-resize CVPixelBuffer in-place before AVAssetWriter append. Preserves macOS zero-copy. | ✓ |
| Scale before backend selection | Single code path. Breaks VT zero-copy (GPU→CPU→GPU roundtrip on Apple Silicon). | |

**User's choice:** Scale inside VtWriter

### Windows WGC native-surface

| Option | Description | Selected |
|--------|-------------|----------|
| Add `FrameData::NativeWindows` (D3D11 texture) | Zero-copy from WGC to scaler. Requires new enum variant + WGC handler change. | ✓ |
| Keep CPU-copy `Pooled` | Simpler; loses GPU→GPU zero-copy on Windows. | |

**User's choice:** Add `FrameData::NativeWindows`

### Feature gating

| Option | Description | Selected |
|--------|-------------|----------|
| Cargo feature `gpu-scale` (default on) | Opt-out on xcap-only / headless CI builds. | ✓ |
| Always-on | Simpler; demands GPU SDKs on every build target. | |

**User's choice:** Cargo feature `gpu-scale` (default on)

---

## Cursor toggle semantics

### Toggle: one flag or two?

| Option | Description | Selected |
|--------|-------------|----------|
| Add `include_styled_cursor` (second flag) | Independent of Phase 6 `include_cursor`. Users get fine-grained control. | ✓ |
| Reuse existing `include_cursor` | Simpler UI; couples two separate concepts. | |

**User's choice:** Add `include_styled_cursor` (second flag)

### OS cursor when styled is on

| Option | Description | Selected |
|--------|-------------|----------|
| Turn OS cursor off at backend (replace) | Cleanest output; single cursor rendered. Requires coupling at `CaptureConfig` assembly. | ✓ |
| Keep both (overlay stack) | OS + styled; risk of double-cursor artifacts if offset by a frame. Debug-only utility. | |

**User's choice:** Turn OS cursor off at backend (replace)

---

## Cursor features in scope

### Feature depth

| Option | Description | Selected |
|--------|-------------|----------|
| Static skin following real position | MVP. Reuses `SkinBitmap` + `compose_frame`. No ripples, no smoothing. | ✓ |
| Skin + click ripples | +1–2 days; requires CGEventTap / low-level mouse hook for button events. | |
| Full post-prod parity (skin + ripples + trajectory smoothing) | Sub-frame interpolation + smoothing filter. Most work. | |

**User's choice:** Static skin following real position

### Compositing path

| Option | Description | Selected |
|--------|-------------|----------|
| CPU-only compositor MVP, GPU deferred | ~10–15% CPU at 1080p60; works on all backends. | |
| Dual CPU + GPU from day one | GPU composite fused with GPU downscale pass; CPU fallback for xcap. Doubles shader work + testing surface. | ✓ |

**User's choice:** Dual CPU + GPU from day one

**Notes:** User overrode the scout's "CPU-only MVP" recommendation and accepted the scope expansion. Phase 8 plans will include both CPU and GPU compositor impls with a byte-/SSIM-equivalence golden-image test between them.

---

## Claude's Discretion

- Exact shader code (MSL + HLSL)
- `GpuScaleError` enum shape and CPU-fallback behavior
- D3D11 immediate-context thread ownership
- Sampler location (encoder pump vs capture pipeline)
- `FrameData::NativeWindows` feature-gating on the `capture` crate

## Deferred Ideas

- Cursor click ripples (needs global input hook)
- Cursor trajectory smoothing / sub-frame interpolation
- Region-aware GPU scale (crop + scale in one pass)
- GPU cursor sprite atlas
- wgpu migration (if preview + encode share shaders)
- Linux support (out of scope for v1)

## Scope adjustment

- **SessionActor ↔ recorder wiring** was in the original Phase 8 description but shipped mid-scout in commits `10ea83f` + `87abd9c`. Phase 8 plans explicitly exclude it; CONTEXT.md flags it under Deferred Ideas with a "do not replan" note.
