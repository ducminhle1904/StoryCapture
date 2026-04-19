# Phase 12: Fix video output resolution lock — Context

**Gathered:** 2026-04-19
**Status:** Ready for planning
**Source:** Direct discussion with user (operator) on 2026-04-19

<domain>
## Phase Boundary

**In scope (Phase 12):**
- Rust encoder crate (`crates/encoder/`) — `EncodeConfig`, FFmpeg argv builder, new `filters.rs` module
- Tauri IPC contract (`apps/desktop/src-tauri/src/commands/encode.rs`, `capture.rs`, `ipc_spec.rs`)
- Auto-generated TypeScript types (`packages/shared-types/src/ipc.ts`) via `tauri-specta` / `ts-rs`
- TypeScript IPC wrapper surfaces (`apps/desktop/src/ipc/*.ts`) to the extent needed to avoid breaking compilation
- All encoder + filter tests (`crates/encoder/src/**/tests`, `crates/encoder/tests/`)
- Tech-debt fix: `bitrate_kbps` used as **target** (not floor) — resolves note in `.planning/phases/06-recording-v2-audio-region-capture-chrome-hiding-multi-browse/06-CLEANUP-BACKLOG.md:9x`

**Explicitly out of scope (deferred to Phase 13):**
- Recording-time UI surface (Resolution / FPS / Fit mode / Pad color / Quality preset knobs)
- Expanded Export modal surface (Container / Codec / Rate control / HW encoder / Preset / Keyframe / Downscale / Audio)
- Per-encoder quality preset mapping UX (Low/Med/High/Lossless curves)
- Persistence in `tauri-plugin-store` + migration of user preferences
- Any frontend React component changes beyond type-level wiring

**Therefore:** This phase produces a working letterbox + output-resolution-lock backend where **callers of the encoder hard-code `OutputResolution::P1080` + `FitMode::Letterbox` + `PadColor::Black`** so existing recording paths behave correctly and output exactly 1920×1080 regardless of capture source shape. UI surfaces stay unchanged; the enum/struct surface is wired for Phase 13 to consume.

</domain>

<decisions>
## Implementation Decisions (locked by user)

### D-12-01: Default fit mode = Letterbox
- `FitMode::Letterbox` is the default and the only mode wired in Phase 12.
- `FitMode::FillCrop` and `FitMode::Stretch` are added to the enum as reserved variants but NOT exercised by default callers; their filter-chain emitters are implemented and tested so Phase 13 can expose them via UI without additional encoder work.
- **Why:** Source of truth for Screen Studio-grade demo video — preserving UI content matters more than filling the frame. Confirmed by OBS Studio + Cap.so precedent.

### D-12-02: No upscaling when source smaller than target
- If `capture_width < output_width` OR `capture_height < output_height`, keep the image at capture size and letterbox inside the output frame.
- Implementation: `force_original_aspect_ratio=decrease` (never grows) + `pad` always fills the chosen `OutputResolution`.
- **Why:** Operator chose Option (a) in the final decision exchange. Upscaled text on a screencast looks blurry; a smaller pristine image in a larger letterbox frame is preferred.

### D-12-03: OutputResolution enum
```rust
pub enum OutputResolution {
    P720,             // 1280×720
    P1080,            // 1920×1080
    P1440,            // 2560×1440
    P2160,            // 3840×2160 (4K)
    MatchSource,      // output_w/h = capture_w/h rounded to even
    Custom { w: u32, h: u32 },  // both MUST be even and ≥ 16 on each axis
}
```
- `MatchSource` is explicitly supported per user's answer to Q5.
- `Custom` validates both axes as even + within 16..=7680 × 16..=4320.
- **Why:** ShareX-style escape hatch for power users while keeping preset ergonomics for common cases.

### D-12-04: Quality preset mapping — Claude's discretion
Operator delegated the mapping curves. Phase 12 implements these per-encoder. Each `QualityPreset` (Low/Med/High/Lossless) produces encoder-specific CLI args via a new `QualityResolver`:

| Preset   | libx264 / libopenh264 (SW) | h264_videotoolbox (macOS HW) | h264_nvenc (NVIDIA) | h264_qsv (Intel) | h264_amf (AMD) |
|---|---|---|---|---|---|
| Low      | `-crf 28 -preset veryfast -tune stillimage` | `-q:v 50 -maxrate <pixel_based*0.75>k -bufsize <…*1.5>k` | `-preset p5 -rc vbr -cq 28 -b:v <pixel_based*0.75>k -maxrate <…*1.25>k` | `-preset medium -global_quality 28 -look_ahead 0` | `-quality balanced -rc cqp -qp_i 28 -qp_p 30` |
| Med      | `-crf 23 -preset medium -tune stillimage` | `-q:v 65 -maxrate <pixel_based>k -bufsize <…*2>k` | `-preset p4 -rc vbr -cq 23 -b:v <pixel_based>k -maxrate <…*1.5>k` | `-preset medium -global_quality 23` | `-quality balanced -rc cqp -qp_i 22 -qp_p 24` |
| High     | `-crf 20 -preset slow -tune stillimage` | `-q:v 75 -maxrate <pixel_based*1.25>k -bufsize <…*2>k` | `-preset p3 -rc vbr -cq 20 -b:v <pixel_based*1.25>k -maxrate <…*1.75>k` | `-preset slow -global_quality 20` | `-quality quality -rc cqp -qp_i 20 -qp_p 22` |
| Lossless | `-crf 18 -preset slow -tune stillimage` | `-q:v 85 -maxrate <pixel_based*1.5>k -bufsize <…*2>k` | `-preset p2 -rc vbr -cq 18 -b:v <pixel_based*1.5>k -maxrate <…*2>k` | `-preset veryslow -global_quality 18` | `-quality quality -rc cqp -qp_i 18 -qp_p 20` |

- `pixel_based = (output_w * output_h * 3) / 1000` kbps (existing heuristic, retained).
- VideoToolbox uses `-q:v` + `-maxrate/-bufsize` (not `-b:v`), consistent with the newly merged encoder tweaks in `crates/encoder/src/config.rs:172-186`.
- **Default for Phase 12 callers:** `QualityPreset::Med`.
- Phase 12 **does NOT expose this to UI**; it's consumed internally by the argv builder with a hard-coded default.
- **Why:** Ship the infrastructure once so Phase 13 UI wiring is mechanical. Using `tune=stillimage` on libx264 is the standard recommendation for screencasts (low noise, lots of flat regions).

### D-12-05: Capture ≠ output dimensions in `EncodeConfig`
- Split fields: `capture_width / capture_height` (raw BGRA stdin `-s WxH`) vs `output_width / output_height` (filter chain target).
- Existing `width/height` fields are **renamed** to `capture_width/height` (breaking internal API). A `#[deprecated]` compatibility shim is NOT added — this is an internal contract, all 5 callers are under our control.
- **Why:** The FFmpeg rawvideo `-s` flag needs capture dims; the `scale + pad` filter chain needs output dims. Conflating them is the root cause of ENC-06's bug.

### D-12-06: Pad color parameter on `EncodeConfig`
- Field: `pad_color: PadColor` enum `{ Black, White, Custom { r: u8, g: u8, b: u8 } }`. Default `Black`.
- FFmpeg `pad=…:color=<hex_or_name>` consumes lowercase hex (`0xRRGGBB`) or the literal words `black`/`white`.
- **Why:** Phase 13 will map this to a UI control; wiring the field + emitter once means Phase 13 is only a UX change.

### D-12-07: Filter chain built programmatically in `filters.rs`
- New module `crates/encoder/src/filters.rs` exposes:
  ```rust
  pub struct FilterSpec {
      pub capture_w: u32, pub capture_h: u32,
      pub output_w: u32, pub output_h: u32,
      pub fit: FitMode,
      pub pad_color: PadColor,
      pub scale_algo: ScaleAlgo,   // default Lanczos; Phase 12 hard-codes Lanczos
  }
  pub fn build_vf(spec: &FilterSpec) -> String;  // validates + emits -vf string
  ```
- `to_ffmpeg_args()` in `config.rs` delegates to `build_vf()`; no string interpolation of user data.
- Unit tests: snapshot (`insta`) the emitted string per fit mode × scale algo × pad color × common (capture, output) pairs.
- **Why:** Prevents shell-escape / injection bugs; testable in isolation; Phase 13 can drive the same function from frontend-supplied specs.

### D-12-08: `bitrate_kbps` semantics — target, not floor
- Current formula: `target_kbps = pixel_based_kbps.max(self.bitrate_kbps).min(40_000)` — treats `bitrate_kbps` as a lower bound.
- Post-phase-12: `self.bitrate_kbps` is the **target**. Auto-derivation is a separate factory: `EncodeConfig::with_auto_bitrate()` computes `pixel_based_kbps` from `output_w * output_h` and sets it.
- The 40,000 kbps cap (`min(40_000)`) is **moved into the QualityResolver** per encoder, not enforced globally.
- **Why:** Fixes tech-debt documented in `06-CLEANUP-BACKLOG.md`; makes CRF/bitrate decisions explicit per encoder rather than relying on an emergent `max/min` expression.

### D-12-09: `fps_advisory` stays a single field for now
- Phase 12 does not split `fps_target` (capture) from `fps_output` (encoder cadence). Raw BGRA stdin uses `fps_advisory` as-is.
- **Why:** Operator scope for Phase 12 is "resolution + bitrate"; FPS split is either (a) intrinsic to the current design since capture is VFR and encoder `-r` is CFR or (b) a Phase 13 concern. Flagged as a deferred idea.

### D-12-10: Default for Phase 12 callers — hard-coded 1080p + Letterbox + Black
- All existing call sites (`apps/desktop/src-tauri/src/commands/encode.rs`, `apps/desktop/src-tauri/src/commands/capture.rs` recorder path, `tools/e2e-playwright-capture/src/main.rs`) pass `OutputResolution::P1080`, `FitMode::Letterbox`, `PadColor::Black`, `QualityPreset::Med` explicitly until Phase 13 introduces user selection.
- **Why:** Phase 12 ships a correct default immediately without waiting for UI. Operator has been hitting the 1920×1130 bug at 1080p intent — this resolves it.

### D-12-11: IPC contract — breaking but additive
- `CaptureConfigDto`, `EncodeProgressDto`, `StartCaptureTargetArgs` stay structurally stable.
- New IPC types emitted: `OutputResolutionDto`, `FitModeDto`, `PadColorDto`, `QualityPresetDto`, `ScaleAlgoDto`. Added to `ipc_spec.rs::collect_commands!` so `tauri-specta` regenerates `packages/shared-types/src/ipc.ts`.
- Existing `start_recording` / `start_capture_target` command signatures gain optional fields with serde-default to hard-coded Phase 12 defaults. Existing callers compile unchanged.
- **Why:** Avoids churn on unrelated recording UI while wiring the types for Phase 13.

### D-12-12: VideoToolbox + pad filter compatibility
- `pad` filter runs on CPU before the encoder consumes the frame; VideoToolbox receives an NV12/YUV420P frame with the pad already baked in. No hardware-specific handling needed.
- Real-capture tests (`cargo test -p encoder --features real-ffmpeg`) verify the encoder accepts padded input on all three HW encoders available locally.
- **Why:** Confirmed in FFmpeg docs + OBS precedent; unlikely but verified to prevent surprises.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Encoder crate current state
- `crates/encoder/src/config.rs` — `EncodeConfig`, `AudioFormat`, `AudioInput`, `to_ffmpeg_args()`. Recently updated (commit 47f2c97, 2026-04-19) to use VideoToolbox `-q:v 65 -maxrate/-bufsize` split. **Phase 12 refactors this file significantly.**
- `crates/encoder/src/probe.rs` — `HardwareEncoder` enum + `probe_encoders()`. Phase 12 extends the codec-name helpers; does NOT change probing logic.
- `crates/encoder/src/pipeline.rs` — frame pump orchestration. Read for context on how `EncodeConfig` is consumed; MAY need minor adjustments if `fps_advisory` or field renames propagate.
- `crates/encoder/src/sidecar.rs` — FFmpeg process lifecycle. Unlikely to change.
- `crates/encoder/src/error.rs` — `EncoderError`. Phase 12 adds `InvalidOutputSpec` / `InvalidFilterSpec` variants.

### Call sites that construct `EncodeConfig`
- `apps/desktop/src-tauri/src/commands/encode.rs` (lines ~400–540 per post-pull grep)
- `apps/desktop/src-tauri/src/commands/capture.rs` (recorder start path)
- `tools/e2e-playwright-capture/src/main.rs:109` (hard-codes `fps_target: 30`)
- `crates/encoder/src/bin/*.rs` (any CLI helpers)
- Any `tests/` file under `crates/encoder/tests/` (notably `real_ffmpeg_*`)

### IPC + type generation
- `apps/desktop/src-tauri/src/ipc_spec.rs` — `collect_commands!` macro + `typ::<T>()` registration. **Every new public type for IPC MUST be registered here.**
- `packages/shared-types/src/ipc.ts` — auto-generated by `tauri-specta`; DO NOT hand-edit. Regenerated via `pnpm -w gen-ipc` or Tauri build.
- `apps/desktop/src/ipc/capture.ts`, `apps/desktop/src/ipc/encode.ts` — thin wrappers around Tauri `invoke` for React consumption.

### Tech-debt backlog entry this phase resolves
- `.planning/phases/06-recording-v2-audio-region-capture-chrome-hiding-multi-browse/06-CLEANUP-BACKLOG.md:99` — the `bitrate_kbps` as floor note.

### Project-wide contracts
- `CLAUDE.md` — agent rules: **no workarounds, no co-authored-by, Vietnamese replies, concise comments, plan before big changes**
- `docs/CONVENTIONS.md` — Rust/TS/testing conventions
- `docs/ARCHITECTURE.md` — trait boundaries (`CaptureBackend`, `BrowserDriver`) — Phase 12 does NOT change these
- `docs/DOMAIN.md` — DSL + pipeline (not directly relevant but listed for completeness)

### Phase 13 forward-reference
- `.planning/phases/13-video-output-customization-knobs-recording-export-ui/` — exists (empty); Phase 13 will consume the enums + `FilterSpec` Phase 12 produces. Plans in Phase 12 MUST NOT leak UI assumptions into encoder/IPC code.

</canonical_refs>

<specifics>
## Specific Ideas

### FFmpeg filter chain (canonical form for Letterbox mode)

```
scale=<W>:<H>:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=<algo>,pad=<W>:<H>:(ow-iw)/2:(oh-ih)/2:color=<color>,setsar=1,format=yuv420p
```

- `<algo>` = `lanczos` (default) / `bicubic` / `bilinear` / `area`. Phase 12 hard-codes `lanczos` at construction time; enum wired for Phase 13.
- `<color>` = `black` / `white` / hex `0xRRGGBB` (lowercase).
- `force_divisible_by=2` guarantees even dims for `yuv420p` + HW encoders.
- `setsar=1` forces square pixels so players don't misinterpret aspect.
- `format=yuv420p` is kept for parity with existing `-pix_fmt yuv420p` — the filter-level `format` filter ensures the pipeline output is already in the right pixel format before the encoder, avoiding implicit conversions.

### FFmpeg filter chain (Fill+Crop mode, wired but unused in Phase 12)

```
scale=<W>:<H>:force_original_aspect_ratio=increase:flags=<algo>,crop=<W>:<H>,setsar=1,format=yuv420p
```

### FFmpeg filter chain (Stretch mode, wired but unused in Phase 12, with logged warning)

```
scale=<W>:<H>:flags=<algo>,setsar=1,format=yuv420p
```

### ffprobe verification pattern
Phase 12 adds a test that runs `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 <out.mp4>` and asserts the output matches the configured `OutputResolution` exactly.

### Test matrix (integration, gated by `--features real-ffmpeg`)
| Capture (W×H) | Output preset | Expected output | Expected letterbox |
|---|---|---|---|
| 1920×1130 | P1080 (1920×1080) | 1920×1080 | 25px top + 25px bottom (≈) |
| 1920×1050 | P1080 | 1920×1080 | 15px top + 15px bottom |
| 800×600 | P1080 | 1920×1080 | 800×600 source at center, pad all 4 sides |
| 3840×2160 | P1080 | 1920×1080 | no pad (perfect aspect match) |
| 2560×1440 | P2160 | 3840×2160 | pillarbox (no upscale) — source stays 2560×1440 centered |
| 1920×1080 | MatchSource | 1920×1080 | no pad |
| 1923×1082 | MatchSource | 1922×1080 (rounded to even) | no pad |

### Snapshot tests (`insta`, unit)
- One snapshot per `(FitMode, ScaleAlgo, PadColor, capture_dims, output_dims)` tuple covering the cells above plus the unused modes.

</specifics>

<deferred>
## Deferred Ideas (Phase 13 or later)

- **UI controls** for all new knobs — Phase 13
- **Persistence** of user selections (`tauri-plugin-store` schema + migration) — Phase 13
- **Per-project override** of the defaults (stored per `.story` project) — Phase 13 or later
- **FPS decoupling**: split `fps_target` (capture) from `fps_output` (encoder CFR cadence). Flagged here but out of Phase 12 scope (D-12-09).
- **GPU-based compositor** (wgpu, Cap.so pattern) — a future v2 replacement for the FFmpeg filter path. Documented for the record; not in Phase 12 or 13.
- **Blur-source pad** (instead of solid color) — requires a second filter graph with `boxblur` + `overlay`. Phase 13 UI will expose "Blur" as a `PadColor` variant, implementation deferred.
- **HEVC / VP9 / AV1 codec switching** — current pipeline is H.264-only. Out of Phase 12/13.
- **Container switching** (MP4 / MKV / WebM / MOV) — Phase 13 export modal.
- **Custom x264 opts passthrough** (ShareX-style escape hatch) — deferred beyond Phase 13.

</deferred>

---

*Phase: 12-fix-video-output-resolution-lock-letterbox*
*Context gathered: 2026-04-19 via in-session discussion (not /gsd-discuss-phase)*
*Operator decisions locked in Q1–Q5 exchange on 2026-04-19 after deep-research agent report*
