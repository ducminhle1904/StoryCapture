//! Plan 06-02 — Criterion bench for the Windows post-capture CPU crop.
//!
//! Gate: mean time <5ms per 1080p BGRA frame on reference hardware
//! (i7/Ryzen class CPU, single-threaded). If this regresses, move the
//! row copy to `rayon::par_iter` or drop to raw `windows` crate D3D11
//! GPU crop (see RESEARCH.md "Don't Hand-Roll" table).
//!
//! Windows-only: the crop helper lives under
//! `crate::windows::frame_from_wgc` which is `#![cfg(target_os = "windows")]`.
//! On macOS/Linux the bench compiles to an empty `main` so `cargo bench --no-run`
//! succeeds on every developer's host (CI matrix runs the real bench on
//! the Windows runner).

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("windows_cpu_crop bench is Windows-only — skipping on this host.");
}

#[cfg(target_os = "windows")]
use criterion::{black_box, criterion_group, criterion_main, Criterion};

#[cfg(target_os = "windows")]
fn bench_cpu_crop(c: &mut Criterion) {
    use capture::windows::frame_from_wgc::{cpu_crop_bgra, PhysicalRectU32};

    // Representative 1080p source. Use nopadding stride (width*4) so we
    // mirror the `as_nopadding_buffer` path hit in production.
    let w = 1920u32;
    let h = 1080u32;
    let stride = (w as usize) * 4;
    let mut src = vec![0u8; stride * h as usize];
    // Fill with a nontrivial pattern so the compiler doesn't elide the
    // row copy.
    for (i, b) in src.iter_mut().enumerate() {
        *b = (i & 0xff) as u8;
    }

    // Typical demo region: 1280×720 centered crop (cinematic 16:9).
    let rect = PhysicalRectU32 { x: 320, y: 180, w: 1280, h: 720 };

    c.bench_function("cpu_crop_bgra_1080p_to_720p", |b| {
        b.iter(|| {
            let out = cpu_crop_bgra(
                black_box(&src),
                black_box(w),
                black_box(h),
                black_box(stride),
                black_box(rect),
            );
            black_box(out);
        })
    });

    // Full-frame crop (worst case row copy volume).
    let full = PhysicalRectU32 { x: 0, y: 0, w, h };
    c.bench_function("cpu_crop_bgra_1080p_full", |b| {
        b.iter(|| {
            let out = cpu_crop_bgra(
                black_box(&src),
                black_box(w),
                black_box(h),
                black_box(stride),
                black_box(full),
            );
            black_box(out);
        })
    });
}

#[cfg(target_os = "windows")]
criterion_group!(benches, bench_cpu_crop);
#[cfg(target_os = "windows")]
criterion_main!(benches);
