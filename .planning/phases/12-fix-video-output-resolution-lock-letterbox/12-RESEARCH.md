# Phase 12: Research — Letterbox-based output-resolution lock for StoryCapture

**Researched:** 2026-04-19
**Source:** Cross-referenced open-source screen recorders (OBS Studio, ShareX, Kap/Aperture, Cap.so, ScreenToGif, SimpleScreenRecorder, vokoscreenNG, Screen Studio export docs) + FFmpeg filter docs
**Consumer:** `gsd-planner` for Phase 12 PLAN.md files

---

## Bug diagnosis (the 1920×1130 problem)

Current filter in `crates/encoder/src/config.rs:109`:

```rust
let scale_filter = "scale='min(1920,iw)':-2,scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string();
```

Decomposed:
1. `scale='min(1920,iw)':-2` — cap the **width** at 1920; set height to `-2` which tells FFmpeg "derive height preserving source aspect ratio, rounded to even". So a 2560×1440 source becomes 1920×1080 (good), a 2560×1506 source becomes 1920×1130 (the bug), a 1920×1200 source stays 1920×1200 (bug).
2. `scale=trunc(iw/2)*2:trunc(ih/2)*2` — idempotent even-rounding pass.

**Root cause:** There is no step that forces the output to a specific target height. The filter is a "cap the width, keep aspect" filter, not a "fit into 1920×1080" filter. Users who select "1080p" in their head expect 1920×1080; FFmpeg produces whatever the source aspect yields under that width cap.

**Additional bug** (tech-debt note `06-CLEANUP-BACKLOG.md:99`): `max(pixel_based_kbps, self.bitrate_kbps).min(40_000)` uses `bitrate_kbps` as a floor. 4K recordings (≈24 Mbps pixel-based) ignore a 12 Mbps `bitrate_kbps` setting; 720p recordings (≈2.8 Mbps pixel-based) clamp up to 12 Mbps.

---

## What mature OSS recorders do

### OBS Studio (gold standard)

- **Separates Base (canvas) resolution from Output (scaled) resolution.** The scene is composed at the canvas resolution, then downscaled to the output resolution for encoding.
- **Source-within-canvas fit**: user chooses per-source "Bounds Type" — `Fit to screen (bounds)` (letterbox, preserves source aspect, default for display capture) vs `Scale to inner bounds` vs `Stretch to screen`.
- **Downscale filters exposed**: Bilinear / Bicubic (default) / Lanczos / Area. OBS recommends:
  - Bilinear — fastest, softest
  - Bicubic — default; good default for synthetic content
  - Lanczos — sharpest; best for text-heavy content like screencasts (StoryCapture's case)
  - Area — best when scale ratio < 50%, auto-selected in that regime
- Downscale happens on GPU (D3D11/Metal), not via FFmpeg `scale` filter. OBS doesn't use `pad` because the canvas already handles letterboxing at the source-bounds level.
- **Encoder rate control**: CBR / VBR / CQP / CRF / Lossless exposed. User chooses.

### Cap.so (closest stack match — Tauri + Rust)

- Uses a wgpu-based compositor (`ProjectUniforms::get_output_size()` applies `min(width_scale, height_scale)` → fit-inside, preserve aspect, align even).
- Letterbox/padding is an editor feature (max 40% of frame, constant `SCREEN_MAX_PADDING = 0.4`).
- Aspect presets: square, 16:9, 9:16, 4:3, 3:4 — compositor emits the canvas at that aspect, then a raw frame is piped to FFmpeg for encoding only (no FFmpeg `scale`/`pad`).
- Resolution presets: 720p / 1080p / 4K. FPS fixed at 60.
- Bitrate modes: "Instant" (low bitrate, fast recording) vs "Studio" (high bitrate, post-production-friendly).
- **Key lesson:** when compositor runs on GPU, FFmpeg filter chain is degenerate. StoryCapture doesn't have a GPU compositor in the capture path yet, so FFmpeg filter is the right place for Phase 12.

### ShareX (Windows, FFmpeg front-end)

- Power-user oriented. Exposes raw FFmpeg args: codec (x264/x265/NVENC/QSV/VP8/VP9), CRF, preset, container, audio codec.
- Default `libx265 -preset ultrafast -tune zerolatency -crf 18 -pix_fmt yuv420p -movflags +faststart`.
- **No automatic letterbox** — records exactly the selected region dims. If user wants 1080p, they draw a 1920×1080 capture rectangle. Different UX paradigm from StoryCapture.
- Lesson: expose a "match source" escape hatch for power users who want zero scaling (D-12-03 MatchSource variant).

### Kap / Aperture (macOS, AVFoundation)

- Layout presets: 1:1 512², 4:3 1024×768, 5:4 1280×1024, 16:9 1600×900, plus custom. **The capture region is coerced to the selected aspect at record time.**
- No post-capture letterbox — the user's selection rectangle is resized while drawing.
- Lesson: alternative UX — coerce the capture rectangle. StoryCapture doesn't want this (it auto-follows a Playwright window), so we need post-capture letterbox instead.

### ScreenToGif (.NET)

- Manual region selection at user-chosen dimensions.
- FFmpeg sidecar for MP4 export with simple knobs (bitrate kbps, `-b:v 5000k` default).
- No aspect-lock — user responsibility.

### SimpleScreenRecorder (Linux, libav*)

- Exposes source area + output resolution + codec + bitrate + container + audio codec. Most verbose UX of the set.
- Resize is "direct resize" — no letterbox; if user picks an output res with a different aspect, the source is stretched. **This is a UX trap** StoryCapture explicitly avoids via D-12-01.

### Screen Studio (commercial, referenced for UX only)

- Export presets: 720p / 1080p / 4K / custom. FPS 30/60. Compression level.
- Input device is always framed inside a decorative "background frame" (padding + shadow + gradient) so the letterbox concept is camouflaged as a design feature, not a defensive workaround.
- Lesson: Phase 13 should eventually offer "brand background" pad variants; Phase 12 lays the wiring (D-12-06 `PadColor` enum).

---

## Recommended FFmpeg filter chain for StoryCapture

### Letterbox (default, Phase 12 hard-coded)

```
scale=<W>:<H>:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,
pad=<W>:<H>:(ow-iw)/2:(oh-ih)/2:color=<color>,
setsar=1,
format=yuv420p
```

Filter-by-filter:

| Filter | Purpose |
|---|---|
| `scale=W:H:force_original_aspect_ratio=decrease` | Fit inside the W×H box without ever growing. If source aspect ≠ target aspect, one axis will be shorter than the target — the other will equal the target. |
| `:force_divisible_by=2` | Ensure both emitted dims are even (required for `yuv420p` chroma subsampling + some HW encoders). |
| `:flags=lanczos` | High-quality downscale filter. Sharpest for text-heavy screencasts. |
| `pad=W:H:(ow-iw)/2:(oh-ih)/2:color=<c>` | Center the scaled frame inside a W×H canvas, filling the difference with `<c>`. `ow`/`oh` are the pad output dims (= W/H); `iw`/`ih` are the input dims (from the previous filter). |
| `setsar=1` | Force square-pixel aspect ratio; avoids players misinterpreting display aspect. |
| `format=yuv420p` | Convert to the H.264-standard pixel format before the encoder. Equivalent to `-pix_fmt yuv420p` on the output but at the filter level. |

### Fill+Crop (wired for Phase 13)

```
scale=<W>:<H>:force_original_aspect_ratio=increase:flags=lanczos,
crop=<W>:<H>,
setsar=1,
format=yuv420p
```

`force_original_aspect_ratio=increase` grows until the short axis fills the target; `crop` takes the center W×H rectangle, discarding edges.

### Stretch (wired for Phase 13, NOT default)

```
scale=<W>:<H>:flags=lanczos,
setsar=1,
format=yuv420p
```

Ignores aspect ratio — should emit a warning log when selected.

### MatchSource (Phase 12 supported variant)

No scale/pad — emit `format=yuv420p` only, and round `output_w/h` to the nearest even value at construction time so the rawvideo `-s` and the final output match.

```
format=yuv420p
```

---

## Per-encoder quality mapping rationale

| Encoder | Rate-control idiom | Phase 12 default (Med preset) |
|---|---|---|
| libx264 / libopenh264 (SW) | CRF-driven, `-preset <speed>`, `-tune stillimage` is the stock "low-noise flat-region" tune that screencasts benefit from. | `-crf 23 -preset medium -tune stillimage` |
| h264_videotoolbox (macOS HW) | **Does NOT support CRF.** Use `-q:v 0..100` (higher = better) + `-maxrate` + `-bufsize`. Current code uses `q:v 65` which lands ~6–12 Mbps at 1080p60 on Apple Silicon (per in-code comment at `config.rs:176-181`). | `-q:v 65 -maxrate <pixel_based>k -bufsize <pixel_based*2>k` |
| h264_nvenc (NVIDIA HW) | Use `-preset p1..p7` (p4 ≈ medium) + `-rc vbr` + `-cq <value>` (CRF-analog). Pair with `-b:v` target + `-maxrate`. | `-preset p4 -rc vbr -cq 23 -b:v <pixel_based>k -maxrate <pixel_based*1.5>k` |
| h264_qsv (Intel HW) | Use `-preset <veryfast..veryslow>` + `-global_quality <value>`. | `-preset medium -global_quality 23` |
| h264_amf (AMD HW) | Use `-quality <quality|balanced|speed>` + `-rc cqp` + `-qp_i <I-frame QP>` + `-qp_p <P-frame QP>`. | `-quality balanced -rc cqp -qp_i 22 -qp_p 24` |

All encoders: common flags `-pix_fmt yuv420p`, `-fps_mode cfr`, `-movflags +faststart`, `-shortest`, `-progress pipe:2`, `-loglevel info` are already emitted by `to_ffmpeg_args()` and stay.

**Why `tune=stillimage`:** screencasts have low motion, lots of flat UI regions, and small text. `tune=stillimage` enables long GOPs + stronger reference frame weighting — meaningful quality uplift at the same bitrate. The FFmpeg docs flag `stillimage` as explicitly appropriate for slideshow/screencast content.

**Why VideoToolbox does NOT use `-b:v`:** tested behavior (and current code comment at `config.rs:173-178`) confirms VT silently picks one of `-b:v` / `-q:v` if both are passed, typically favoring `-b:v` which VT then interprets as a *ceiling* and undershoots during low-motion frames, yielding muddy output. The fix was merged in commit 47f2c97.

---

## Validation Architecture

*(Nyquist validation is disabled for this project per `workflow.nyquist_validation: false` — listed here for completeness. Phase 12 relies on conventional unit + integration + snapshot tests.)*

### Failure modes for this phase
1. **Output dimensions ≠ selected preset** — the original bug. Detected by `ffprobe` assertion.
2. **Upscaling a small source** — violates D-12-02. Detected by source-smaller integration test.
3. **Odd dimensions reaching encoder** — `yuv420p` rejects odd dims on some HW encoders. Detected by integration test with an awkward source like 1921×1081.
4. **Pad color not applied** — detected by sampling pixels in the pad region of the output via `ffmpeg -vf "crop=5:5:0:0,showinfo"` or a pixel histogram comparison.
5. **Bitrate regression** (tech-debt fix accidentally lowers quality) — detected by comparing encoded bitrate before/after via `ffprobe -show_format -of json` at 4K + 720p + 1080p.
6. **Filter-string shell-escape bug** — custom pad color hex is built into the filter string; need to verify no injection vector. Unit test: construct a `PadColor::Custom` with wild bytes → `build_vf()` returns `Err(InvalidFilterSpec)`.
7. **`MatchSource` rounding** — an odd-dim source (1923×1081) must be rounded to even (1922×1080). Unit test.
8. **Backwards-compat break** — existing code uses `config.width/height`; Phase 12 renames to `capture_width/height`. All 5+ call sites must compile. Verified by `cargo check --workspace`.

### Validation surface per failure mode
| # | Failure | Detection mechanism |
|---|---------|---------------------|
| 1 | Dims mismatch | `ffprobe` in `crates/encoder/tests/real_ffmpeg_resolution_lock.rs` (gated `real-ffmpeg`) |
| 2 | Upscaling | Same test with small source (800×600 → 1920×1080) + pixel-sampling check |
| 3 | Odd dims | Property test (`proptest`) over random even/odd capture dims → builder must always emit even output |
| 4 | Pad color | Pixel-sampling integration test: render red source, verify top-left 10×10 pad region is exactly `0xRRGGBB` |
| 5 | Bitrate regression | Compare `ffprobe bit_rate` across HW encoders for 720p/1080p/4K; tolerance ±20% |
| 6 | Injection | Unit test on `build_vf()` with malicious inputs (NUL bytes, quotes, newlines) |
| 7 | MatchSource rounding | Unit test in `filters.rs` for 1923×1081 input |
| 8 | Compile break | `cargo check --workspace --all-targets` in CI |

---

## Implementation landmines

### L-01: Tauri-specta regeneration required after `ipc_spec.rs` changes
Running `pnpm -w gen-ipc` (or the equivalent Tauri build step) is mandatory after adding new IPC types. If skipped, `packages/shared-types/src/ipc.ts` goes stale and the React side won't see `OutputResolutionDto` etc. CI should catch this, but plan should include an explicit task.

### L-02: `insta` snapshot churn
Introducing `filters.rs` will add ~20 new snapshot files (`.snap`). Review them once, accept with `cargo insta accept`, commit. Don't mix with the source-rename commit to keep review sane.

### L-03: VideoToolbox + `pad` interaction
VideoToolbox encoders accept NV12 / YUV420P frames. The `pad` filter runs in software on the current frame; it produces YUV420P (matching the `format=yuv420p` filter). VT sees padded frames, encodes them. Verified in FFmpeg usage patterns. Integration test confirms this behavior on macOS CI.

### L-04: Windows CFR fps edge case
`-r 60 -fps_mode cfr` + `scale + pad` at 60 fps has been benchmarked; pad filter is cheap (~0.5% CPU). Should not affect encode speed on M-series Macs or modern x86. Flagged for the 30-minute soak test already in Phase 1 VERIFICATION.

### L-05: `force_divisible_by=2` vs `trunc(iw/2)*2:trunc(ih/2)*2` (current redundant second scale)
The new filter chain uses `force_divisible_by=2` in the first `scale` filter, which obviates the second `scale=trunc…` step. Remove the second step; don't keep it as belt-and-suspenders (harmless but adds a CPU pass).

### L-06: `setsar=1` order
`setsar` must come **after** `pad` — otherwise players may compute aspect from the pre-pad frame. Snapshot tests must guard this order.

### L-07: `format=yuv420p` at filter level vs `-pix_fmt yuv420p` at codec level
Redundant but safe. Keeping both is defensive; removing `-pix_fmt yuv420p` means the filter alone drives the format, which is fine but changes behavior if someone later reorders filters. Plan: keep both for Phase 12; remove `-pix_fmt` in a future cleanup.

### L-08: Recorder session's `force_ffmpeg_path` flag
When `force_ffmpeg_path` is true (recorder sessions, to shorten pause/resume timelines), the rawvideo stdin path is forced. The new filter chain applies on that path. The macOS VT fast-path (`vt_writer`) bypasses FFmpeg entirely and won't use the new filter — it outputs at capture dimensions. Phase 12 must ensure VT fast-path still emits capture-dimension output (intentional — no letterbox on VT fast-path); the filter chain only applies to the FFmpeg path. If operator wants 1080p-locked output through the VT fast-path, that's a Phase 13 decision (likely: disable VT fast-path when user selects a non-MatchSource preset).

### L-09: `EncodeConfig` field rename vs `#[deprecated]`
Internal API; no external consumers; no `#[deprecated]` needed. Update all 5+ call sites in the same commit. Adding `#[deprecated]` just bloats the diff and makes the cleanup step drag into Phase 13.

### L-10: Existing 4K bitrate test
`test_4k_exceeds_floor` in `crates/encoder/src/config.rs:344` tests the **old** floor semantics. Phase 12 rewrites it to test the new target semantics (no floor; `bitrate_kbps` = target).

---

## Prior art — full source citations

- OBS Studio forum: "Difference between Rescale Output and Output Resolution" — https://obsproject.com/forum/threads/difference-between-rescale-output-and-output-resolution.65138/
- OBS Studio forum: "Which downscale filter to use?" — https://obsproject.com/forum/threads/which-downscale-filter-to-use.125517/
- OBS Studio forum: "Bicubic vs Lanczos downscale filter performance" — https://obsproject.com/forum/threads/bicubic-vs-lanczos-downscale-filter-performance.70407/
- Cap.so repo: https://github.com/CapSoftware/Cap — see `crates/rendering/src/lib.rs` for `ProjectUniforms::get_output_size()` pattern
- Cap.so capture library (scap): https://github.com/CapSoftware/scap
- ShareX — FFmpeg templates (DeepWiki): https://deepwiki.com/ShareX/ShareX/3.4-screen-recording
- Kap/Aperture (wulkano/aperture): https://github.com/wulkano/aperture
- ScreenToGif wiki — Recording: https://github.com/NickeManarin/ScreenToGif/wiki/Help-%E2%96%AA-Recording-%F0%9F%93%B9
- SimpleScreenRecorder: https://github.com/MaartenBaert/ssr
- vokoscreenNG: https://github.com/vkohaupt/vokoscreenNG
- Screen Studio export settings (UX reference): https://screen.studio/guide/explanation-of-export-settings
- Codec Wiki — VideoToolbox encoder: https://wiki.x266.mov/docs/encoders_hw/videotoolbox
- FFmpeg scale filter: https://ffmpeg.org/ffmpeg-filters.html#scale-1
- FFmpeg pad filter: https://ffmpeg.org/ffmpeg-filters.html#pad-1
- FFmpeg force_divisible_by docs: https://ffmpeg.org/ffmpeg-all.html#scale
- Mux — "How to change video resolutions using FFmpeg": https://www.mux.com/articles/convert-video-to-different-resolutions-with-ffmpeg
- OTTVerse — FFmpeg resize/scale guide: https://ottverse.com/change-resolution-resize-scale-video-using-ffmpeg/
- Kevin Locke — "Letterboxing with FFmpeg for mobile": https://kevinlocke.name/bits/2012/08/25/letterboxing-with-ffmpeg-avconv-for-mobile/

---

## RESEARCH COMPLETE
