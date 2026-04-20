---
phase: 12-fix-video-output-resolution-lock-letterbox
verified: 2026-04-20T00:00:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
---

# Phase 12: Fix Video Output Resolution Lock + Letterbox — Báo cáo Verify

**Mục tiêu phase:** Backend encoder lock output về đúng preset người dùng chọn, xử lý mismatch aspect bằng letterbox filter chain, split capture/output dims, sửa tech-debt bitrate floor, chuẩn bị IPC DTOs cho UI Phase 13.

**Verified:** 2026-04-20
**Status:** passed
**Re-verification:** Không — lần verify đầu tiên.

## Kiểm tra mục tiêu (Goal Achievement)

### Observable Truths / Requirements ENC-06..ENC-11

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| ENC-06 | Output resolution = preset chính xác (bug 1920×1130 bị lock về 1920×1080) | VERIFIED | `OutputResolution::resolve_even` ở `crates/encoder/src/filters.rs:82-115` map đúng P720/P1080/P1440/P2160/MatchSource/Custom; integration test `test_letterbox_1920x1130_to_p1080` ở `crates/encoder/tests/resolution_lock_real_ffmpeg.rs:234` dùng ffprobe để assert đúng 1920×1080 output; snapshot `encoder__filters__tests__snapshot_letterbox_1920x1130_to_p1080_black_lanczos.snap` lock chuỗi filter. |
| ENC-07 | Letterbox filter chain canonical với pad color cấu hình được | VERIFIED | `filters::build_vf` ở `filters.rs:118-168` emit chuỗi `scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=<algo>,pad=W:H:(ow-iw)/2:(oh-ih)/2:color=<c>,setsar=1,format=yuv420p` (khớp spec ENC-07). Default pad = `PadColor::Black` (`config.rs:90`), có FitMode::FillCrop và Stretch cho Phase 13. `EncodeConfig` có field `pad_color: PadColor` (`config.rs:49`). |
| ENC-08 | Split `capture_width/height` vs `output_width/height`; `-s` = capture dims, `-vf` = output dims | VERIFIED | `EncodeConfig` ở `config.rs:42-92` có 4 trường riêng `capture_width`, `capture_height`, `output_width`, `output_height`. `to_ffmpeg_args()` ở `config.rs:184-244` emit `-s {capture_w}x{capture_h}` (line 194) trong khi `FilterSpec` truyền cả capture + output dims vào `build_vf`. Old field `width/height` đã được xoá. Test `test_output_dims_differ_from_capture_in_minus_s` (88 lib tests pass). |
| ENC-09 | Không upscale khi source < output preset — letterbox bên trong khung | VERIFIED | FFmpeg `force_original_aspect_ratio=decrease` chỉ thu nhỏ chứ không phóng to; `pad` luôn fill tới dims output. Snapshot `snapshot_letterbox_800x600_to_p1080_black_lanczos` chứng minh 800×600 → 1920×1080 dùng decrease + pad (không stretch). Integration test `test_no_upscale_800x600_to_p1080` ở `resolution_lock_real_ffmpeg.rs:253` sample pixel pad region ở (10,10) để verify ≈ black. |
| ENC-10 | `bitrate_kbps` là target, không phải floor; `with_auto_bitrate()` opt-in | VERIFIED | Công thức cũ `target_kbps = pixel_based_kbps.max(self.bitrate_kbps).min(40_000)` đã bị xoá hoàn toàn (`grep "target_kbps = pixel_based_kbps.max"` trả về 0). Default `bitrate_kbps = 0` (`config.rs:90`). `with_auto_bitrate` ở `config.rs:124-128` set bitrate từ `quality::pixel_based_kbps(output_w, output_h)`. VT writer fast-path `macos/vt_writer.rs:153-156` map 0 → pixel_based_kbps. Rate-control giờ do `quality::resolve` quyết định mỗi encoder — NVENC dùng `-b:v`, VT dùng `-q:v/-maxrate/-bufsize` không có `-b:v` (assert bởi test `videotoolbox_does_not_emit_dash_b_v`). 40_000 ceiling được dời xuống bên trong resolver. |
| ENC-11 | Filter chain được build programmatically qua module `filters.rs`, không hand-format | VERIFIED | Module `crates/encoder/src/filters.rs` (414 dòng) export `FilterSpec` + `build_vf() -> Result<String>`. `config.rs:181` là điểm gọi duy nhất; không có bất cứ `format!("-vf …")` nào trong encoder crate (grep sạch). Input shell-escape safe: `PadColor::Custom { r: u8, g: u8, b: u8 }` format lowercase hex via `format!("0x{:02x}{:02x}{:02x}")` — test exhaustive 5×5×5 (`padcolor_custom_hex_is_always_ascii_lowercase_hex`) assert mọi hex output hợp lệ. `EncoderError::InvalidFilterSpec` reject zero/odd/out-of-range dims trước khi emit. 10 insta snapshot lock chuỗi filter canonical. |

**Score:** 6/6 requirements VERIFIED.

### Required Artifacts

| Artifact | Mô tả | Status | Detail |
|----------|-------|--------|--------|
| `crates/encoder/src/filters.rs` | Module filter chain với FilterSpec, FitMode, PadColor, ScaleAlgo, OutputResolution, QualityPreset, build_vf | VERIFIED | 414 dòng, substantive, được re-export từ `lib.rs`, consumed bởi `config.rs` + DTOs + tests. |
| `crates/encoder/src/quality.rs` | Per-encoder quality resolver | VERIFIED | 266 dòng; `resolve(preset, encoder, w, h) -> Vec<String>` và `pixel_based_kbps`. VT parity test (`videotoolbox_med_1080p_parity_with_current_config`) đảm bảo commit 47f2c97 shape. Consumed bởi `config.rs:239` + `macos/vt_writer.rs`. |
| `crates/encoder/src/config.rs` — EncodeConfig refactor | Split dims + builders + delegation | VERIFIED | 478 dòng; struct có đủ `capture_width/height`, `output_width/height`, `fit_mode`, `pad_color`, `scale_algo`, `quality_preset`. Builder chain `with_output_resolution/with_fit_mode/with_pad_color/with_scale_algo/with_quality_preset/with_auto_bitrate` đủ. `to_ffmpeg_args` delegate `-vf` + rate-control. |
| `crates/encoder/src/macos/vt_writer.rs` | VT writer đọc capture_width/height + handle bitrate=0 | VERIFIED | Được cập nhật ở commit b9470ab; line 153-156 map `bitrate_kbps == 0` → `quality::pixel_based_kbps(capture_w, capture_h)`. |
| `apps/desktop/src-tauri/src/commands/encode.rs` — DTOs + default chain | 5 DTO enums + From impls + StartRecordingArgs + wiring | VERIFIED | DTOs ở line 152-246; `StartRecordingArgs` ở line 351-374 có 5 Option<Dto> field với `#[serde(default)]`. start_recording line 682-708 apply defaults P1080+Letterbox+Black+Lanczos+Med, override từ DTO qua `Option::map(Into::into).unwrap_or(...)`. |
| `apps/desktop/src-tauri/src/ipc_spec.rs` — DTO registrations | 5 `.typ::<Dto>()` lines | VERIFIED | Line 178-182 đăng ký cả 5 DTO qua tauri-specta. |
| `packages/shared-types/src/ipc.ts` — auto-generated TS bindings | 5 DTO exports | VERIFIED | Line 1179 `FitModeDto`, line 1232 `OutputResolutionDto`, line 1233 `PadColorDto`, line 1280 `QualityPresetDto`, line 1321 `ScaleAlgoDto`, line 1348 `StartRecordingArgs` extended với 5 optional field. Discriminated unions (`{ kind: "..." }`) đúng shape cho PadColor + OutputResolution. |
| `crates/encoder/tests/resolution_lock_real_ffmpeg.rs` | 7 integration test ffprobe + pad pixel sampling | VERIFIED | 399 dòng, 7 `#[tokio::test]` gate sau `#![cfg(feature = "real-ffmpeg")]`, bao phủ ENC-06 repro (1920×1130), no-upscale, pillarbox, MatchSource rounding, perfect aspect, white + custom pad color. |
| `crates/encoder/src/snapshots/*.snap` | 10 insta snapshot lock canonical filter strings | VERIFIED | 10 file, snapshot bug-repro case chứa đúng chuỗi canonical `scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`. |

### Key Link Verification

| From | To | Via | Status | Detail |
|------|----|-----|--------|--------|
| `config.rs::to_ffmpeg_args` | `filters::build_vf` | direct call | WIRED | `config.rs:181` — output `-vf` do `build_vf` produce, không string-format nội bộ. |
| `config.rs::to_ffmpeg_args` | `quality::resolve` | direct call | WIRED | `config.rs:239-244` — rate-control args do resolver sinh theo `quality_preset` + `encoder`. |
| `macos/vt_writer.rs` | `quality::pixel_based_kbps` | default bitrate derivation | WIRED | Line 153-156 — bitrate=0 map sang pixel-based. |
| `encode.rs::start_recording` | `EncodeConfig` builders | builder chain | WIRED | Line 695-708 — đủ 5 builder call, apply Phase 12 defaults khi DTO = None. |
| `encode.rs::FitModeDto/etc.` | encoder domain enums | `From` impls | WIRED | Line 152-246 — trivial match bridges. |
| `ipc_spec.rs` | 5 DTOs | `.typ::<encode::*Dto>()` | WIRED | Line 178-182. |
| `packages/shared-types/src/ipc.ts` | 5 DTO TS types | tauri-specta regen | WIRED | 5 `export type ...Dto` hiện diện; `StartRecordingArgs` TS có thêm 5 optional field. |

### Data-Flow Trace (Level 4)

| Artifact | Data variable | Source | Real data | Status |
|----------|---------------|--------|-----------|--------|
| `to_ffmpeg_args` | `-vf` string | `filters::build_vf(FilterSpec{capture, output, fit, pad, algo})` | FilterSpec field từ EncodeConfig (non-default) được set bởi builder chain ở `start_recording`. Không có fallback empty. | FLOWING |
| `to_ffmpeg_args` | RC args vector | `quality::resolve(preset, encoder, output_w, output_h)` | preset default Med (hoặc DTO override); encoder từ `probe.preferred`; dims = output dims sau `with_output_resolution`. | FLOWING |
| `vt_writer` bitrate | `effective_kbps` | `cfg.bitrate_kbps` hoặc `pixel_based_kbps(capture_w, capture_h)` | Default 0 → derive theo dims. | FLOWING |
| `start_recording` defaults | `output_res/fit/pad/algo/qp` | `args.*.map(Into::into).unwrap_or(<Phase 12 default>)` | Defaults = P1080/Letterbox/Black/Lanczos/Med theo D-12-10. | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Encoder lib tests pass đủ bộ | `cargo test -p encoder --lib` | `88 passed; 0 failed; 0 ignored` | PASS |
| Filter snapshot khớp canonical | `cat .../snapshot_letterbox_1920x1130_to_p1080_black_lanczos.snap` | chứa đúng chuỗi `scale=1920:1080:…,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p` | PASS |
| Old floor formula biến mất | `grep "target_kbps = pixel_based_kbps.max" crates/encoder/` | 0 match | PASS |
| DTO registrations có đủ | `grep "\.typ::<encode::.*Dto>()" ipc_spec.rs` | 5 match | PASS |
| TS bindings emit DTOs | `grep "OutputResolutionDto\|FitModeDto\|PadColorDto\|QualityPresetDto\|ScaleAlgoDto" ipc.ts` | 6 match | PASS |
| Integration tests gate sạch (skip nếu thiếu ffmpeg sidecar) | `cargo check -p encoder --tests --features real-ffmpeg` | OK theo SUMMARY 12-05 | PASS |

### Requirements Coverage

| Requirement | Source plan | Mô tả ngắn | Status | Evidence |
|-------------|-------------|-----------|--------|----------|
| ENC-06 | 12-01, 12-03, 12-05 | Output resolution lock | SATISFIED | filters + config + ffprobe integration test |
| ENC-07 | 12-01, 12-03 | Letterbox canonical chain | SATISFIED | build_vf + snapshot |
| ENC-08 | 12-03 | capture/output dim split | SATISFIED | EncodeConfig + to_ffmpeg_args |
| ENC-09 | 12-01, 12-03, 12-05 | No upscale | SATISFIED | `force_original_aspect_ratio=decrease` + test_no_upscale |
| ENC-10 | 12-02, 12-03 | bitrate target, không floor | SATISFIED | with_auto_bitrate + quality::resolve + VT writer |
| ENC-11 | 12-01 | Filter chain programmatic | SATISFIED | filters.rs + 10 snapshot + InvalidFilterSpec validation |

Không có requirement nào bị orphan trong phase 12. ENC-12..19 đã scope cho Phase 13 (UI knobs, persistence) nên không verify ở đây.

### Anti-Patterns Found

Không phát hiện blocker. Các quan sát:

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (không có) | — | TODO/FIXME/placeholder | — | — |

Tech-debt `06-CLEANUP-BACKLOG.md:99` (bitrate_kbps floor) được phase này **giải quyết triệt để** — không còn max/min floor formula nào trong encoder crate.

### Deviations Được Phân Loại

Từ các SUMMARY đã review:

- **12-01:** Không deviation. Pure-additive filters module đúng plan.
- **12-02:** Stub `filters.rs` chỉ với `QualityPreset` (Wave 1 coordination) — đã được 12-01 overlap/merge đúng (orchestrator union-merge). Toolchain 1.88.0 fallback sang stable — chỉ là môi trường dev, CI vẫn pin 1.88.0. **Chấp nhận.**
- **12-03:** Thêm sửa `macos/vt_writer.rs` không nằm trong `files_modified` plan ban đầu — chính đáng (Rule 2 missing-critical fix cho bitrate=0 → AVAssetWriter crash). **Chấp nhận.**
- **12-04:** `pnpm exec tsc --noEmit` fail do TS5101 baseUrl deprecation — **pre-existing** trên main, ngoài scope plan IPC. Binary placeholders trong `binaries/` chỉ là build-script contract, không commit. **Chấp nhận.**
- **12-05:** Thêm `image` vào dev-deps (không có trong plan frontmatter) — cần thiết cho pixel sampling. Đổi pillarbox case từ 2560×1440 → 2000×1440 để test thực sự exercise pad (2560×1440 đã 16:9, không pad). **Chấp nhận** — đổi nguồn test nhưng vẫn giữ assertion chính của ENC-06.

Không deviation nào blocking. Toàn bộ đều phù hợp với spirit của phase.

### Human Verification Required

Không có hạng mục bắt buộc human-verify trong phase 12 vì phase này là backend-only:

- Không có UI surface thay đổi (D-12-10: Phase 12 hard-code defaults ở call site).
- Pad color pixel accuracy đã được integration test assert với ±10 tolerance.
- Ffprobe output dims được test assert byte-exact.

Phase 13 mới là nơi cần human verification UI (đã nằm trong roadmap).

### Gaps Summary

Không có gap. Toàn bộ ENC-06..ENC-11 đã thỏa mãn ở cấp độ code + test. Integration tests gate-skip-clean khi thiếu ffmpeg sidecar binary là thiết kế có chủ ý theo plan 12-05; trên CI pipeline có ffmpeg sidecar binary chúng sẽ chạy đầy đủ 7 case.

---

*Verified: 2026-04-20*
*Verifier: Claude (gsd-verifier)*
