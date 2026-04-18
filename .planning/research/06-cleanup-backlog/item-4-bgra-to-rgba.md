# Backlog #4: Eliminate per-pixel BGRA→RGBA swap loop (Windows thumbnail)

**Researched:** 2026-04-17  
**Domain:** image crate PNG encoding, BGRA/RGBA conversion  
**Confidence:** HIGH (API check verified against docs.rs source)

## Current State

`crates/capture/src/windows/thumbnail.rs:265-270` allocates a fresh `Vec<u8>` of 4×w×h bytes, then per-pixel `extend_from_slice(&[b,g,r,a] → [r,g,b,a])`. For a 1920×1080 frame: 2,073,600 iterations, ~8 MB alloc, every thumbnail call (2 s refresh cadence). Bounds-check + realloc risk on each `extend_from_slice` (mitigated by `with_capacity`, but the 4-byte push still checks length/capacity).

## Option Zero: does `PngEncoder` accept `Bgra8`? — NO (verified 2026-04)

- `ExtendedColorType::Bgra8` is a declared variant [CITED: docs.rs/image/0.25.5]. That's misleading — the *enum* has it, but the PNG encoder rejects it.
- `PngEncoder::write_image` source matches only `L8 | La8 | Rgb8 | Rgba8 | L16 | La16 | Rgb16 | Rgba16`; all other variants fall to `"The color {color_type:?} can not be represented in PNG."` [CITED: docs.rs/image/0.25.5/src/image/codecs/png.rs.html].
- Upstream issue image-rs/image#826 ("Png encoder treats BGRA as RGBA") was resolved by *rejecting* BGRA rather than handling it — and that decision stands in 0.25.x.
- The underlying `png` crate's `ColorType` has only `Grayscale | Rgb | Indexed | GrayscaleAlpha | Rgba` [CITED: docs.rs/png/latest]. No BGRA at any layer. Option Zero is still blocked.

## Option A: in-place swap, pre-sized buffer

Replace the `extend_from_slice` push loop with a pre-allocated `vec![0u8; expected]` + `chunks_exact_mut(4).zip(chunks_exact(4))` writing 4 bytes per iteration. Eliminates the per-push length/capacity check. Pure-safe Rust. **Effort: 5 min. Risk: none. Expected delta: −30–50 % CPU on the swap** (the loop body is 4 writes + no branching); allocation size unchanged.

## Option B: SIMD swap via `bytemuck` + `u32` word swap

Treat each 4-byte pixel as a `u32`, swap R↔B with a byte-rotate:
```rust
let px = u32::from_le_bytes([b, g, r, a]); // little-endian so byte0=b
// Want [r, g, b, a] as LE u32 = (a<<24)|(b<<16)|(g<<8)|r
let swapped = (px & 0xFF00FF00) | ((px & 0x00FF0000) >> 16) | ((px & 0x000000FF) << 16);
```
With `bytemuck::cast_slice_mut::<u8, u32>`, LLVM auto-vectorizes this to `vpshufb` on x86_64 (SSSE3 baseline) and `vqtbl1q_u8` on aarch64. No `std::simd` nightly dependency, no `wide` crate. **Effort: 15 min. Risk: low. Expected delta: −85–95 % swap CPU** on modern CPUs (16 px / cycle with AVX2); allocation unchanged.

## Option C: streaming swap wrapper around `PngEncoder`

Wrap an internal `impl Write` that swaps in 4-byte groups as bytes pass through, then feed BGRA directly. Doesn't work cleanly: `PngEncoder::write_image` takes `&[u8]`, not `impl Write` — the swap would have to happen *before* entering the encoder regardless. The `png` crate's `StreamWriter` *does* implement `Write`, but using it requires abandoning `image::imageops::resize` (which operates on `RgbaImage`). **Verdict: reject** — requires rewriting the shared `encode_rgba_to_png` resize tail.

## Option D: patch `image` crate upstream

Issue #826 was closed intentionally. Non-starter within this backlog item's scope.

## Recommendation

**Option B (u32 word-swap with auto-vectorization)** — best effort/benefit ratio.

```rust
fn encode_bgra_to_png(bgra: &[u8], src_w: u32, src_h: u32, max_w: u32, max_h: u32)
    -> Result<Vec<u8>, CaptureError>
{
    let expected = (src_w as usize) * (src_h as usize) * 4;
    if bgra.len() < expected {
        return Err(CaptureError::Native(format!(
            "BGRA buffer length {} < expected {} for {}×{}",
            bgra.len(), expected, src_w, src_h)));
    }
    // Pre-sized; LLVM auto-vectorizes the u32 swap to vpshufb/vqtbl1q_u8.
    let mut rgba = vec![0u8; expected];
    let src_words: &[u32] = bytemuck::cast_slice(&bgra[..expected]);
    let dst_words: &mut [u32] = bytemuck::cast_slice_mut(&mut rgba[..]);
    for (d, s) in dst_words.iter_mut().zip(src_words.iter()) {
        // BGRA little-endian u32: byte0=B, byte1=G, byte2=R, byte3=A
        // Target RGBA:             byte0=R, byte1=G, byte2=B, byte3=A
        *d = (*s & 0xFF00_FF00) | ((*s & 0x00FF_0000) >> 16) | ((*s & 0x0000_00FF) << 16);
    }
    crate::thumbnail::encode_rgba_to_png(rgba, src_w, src_h, max_w, max_h)
}
```

`bytemuck` is already a dep (`Cargo.toml:36`) — zero new deps. Allocation stays at one `Vec` (the `encode_rgba_to_png` contract requires an owned `Vec`); Option B attacks the CPU side, which is the dominant cost on large frames.

## Test Plan

1. **Existing tests pass** (`encode_bgra_noop_downscale_produces_png`, `encode_bgra_downscale_bounded`, `encode_bgra_rejects_short_buffer`) — all three in `thumbnail.rs:273-310` exercise the swap path.
2. **Add a byte-equality test**: feed a known BGRA pattern `[0x11, 0x22, 0x33, 0x44]`, verify the decoded PNG's first RGBA pixel is `[0x33, 0x22, 0x11, 0x44]`.
3. **Add a criterion bench** `windows_bgra_to_rgba_swap` in `benches/` (harness already set up for `windows_cpu_crop`) measuring 1080p + 4K swap cost. Gate at <1 ms for 1080p on reference hardware (current loop is ~6–10 ms).
4. **Drop the comment at `thumbnail.rs:245-247`** referencing the lift-blocked limitation; replace with a one-liner pointing at the word-swap rationale.

## Sources

- [docs.rs/image/0.25.5 — ExtendedColorType](https://docs.rs/image/0.25.5/image/enum.ExtendedColorType.html) — Bgra8 is a variant
- [docs.rs/image/0.25.5 — PngEncoder source](https://docs.rs/image/0.25.5/src/image/codecs/png.rs.html) — `write_image` rejects Bgra8
- [docs.rs/png — ColorType](https://docs.rs/png/latest/png/enum.ColorType.html) — underlying crate has no BGRA
- [image-rs/image#826](https://github.com/image-rs/image/issues/826) — upstream chose rejection over silent mis-encoding
- `bytemuck` 1.x — already in `crates/capture/Cargo.toml:36`
