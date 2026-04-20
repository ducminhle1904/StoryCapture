---
phase: 13
plan: 01
subsystem: ipc-export
tags: [ipc, specta, export, dto, backend]
requires: [12-04]
provides:
  - EncoderOptionsDto
  - AudioOptionsDto
  - ContainerDto
  - CodecDto
  - RateControlDto
  - X264PresetDto
  - AudioCodecDto
  - ExportOutputDto.encoder_options
affects:
  - apps/desktop/src-tauri/src/commands/export.rs
  - apps/desktop/src-tauri/src/ipc_spec.rs
  - packages/shared-types/src/ipc.ts
tech-stack:
  added: []
  patterns:
    - nested optional DTO with #[serde(default)] per Phase 12 12-04 rhythm
    - specta-emit bin invocation for TS regen
key-files:
  created: []
  modified:
    - apps/desktop/src-tauri/src/commands/export.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - packages/shared-types/src/ipc.ts
    - apps/desktop/src-tauri/src/commands/author_snapshot.rs
decisions:
  - ContainerDto uses lowercase serde rename (mp4/mov/webm) to avoid kebab-case lowering "Mp4" → "mp-4"
  - Runtime consumption of encoder_options in export_run_inner deferred to a later phase; Phase 13 ships IPC surface + validation only
metrics:
  duration: ~45 min
  completed: 2026-04-20
requirements: [ENC-13]
---

# Phase 13 Plan 01: Export IPC knobs — Summary

Extend `ExportOutputDto` with a nested optional `EncoderOptionsDto` bundle so the Phase 13 `<AdvancedOutputOptions>` modal can ship the 8 export-only knobs (container, codec, rate control, HW encoder, x264 preset, keyframe interval, downscale algo, audio params) to the backend without breaking any existing call site.

## Outcome

- `ExportOutputDto` gains one optional field (`encoder_options: Option<EncoderOptionsDto>`); every legacy call site deserializes unchanged because `#[serde(default)]` fills it with `None`.
- 7 new DTOs registered with tauri-specta and emitted into `packages/shared-types/src/ipc.ts`:
  `EncoderOptionsDto`, `AudioOptionsDto`, `ContainerDto`, `CodecDto`, `RateControlDto`, `X264PresetDto`, `AudioCodecDto`.
- `HardwareEncoderDto` and `ScaleAlgoDto` reused from Phase 12 Plan 12-04 — no redefinition.
- `export_validate_config` enforces the new invariants:
  - `keyframe_interval_sec` ∈ `1..=10`
  - `audio.bitrate_kbps` ∈ `64..=320`
  - `audio.channels` ∈ `{1, 2}`
- 6 new unit tests (3 serde roundtrip + 3 validation-failure + 2 validation-success) + original 3 tests all pass (11/11 total).

## Gate sequence (TDD)

| Gate | Commit | Purpose |
|------|--------|---------|
| RED (Task 1) | e95b762 | Failing serde roundtrip tests for absent / full / partial `encoder_options` |
| GREEN (Task 1) | 977a912 | Add EncoderOptionsDto + 6 sub-DTOs; attach optional field to ExportOutputDto |
| RED (Task 2) | a2299fc | Failing validation tests for keyframe / bitrate / channels |
| GREEN (Task 2) | 995fbfb | Wire validation in `export_validate_config`; register specta types; regenerate `ipc.ts` |

## Key decisions

- **Nested bundle shape** (not flat fields on `ExportOutputDto`) — recommended by 13-RESEARCH.md option (b); mirrors the UI Basic/Advanced split in CD-13-01. Keeps the "4 legacy fields" surface intact.
- **`ContainerDto` lowercase (not kebab-case)** — kebab-case lowers `Mp4` → `"mp-4"` and `WebM` → `"web-m"` which is ugly for a container-format token. Using `#[serde(rename_all = "lowercase")]` + `#[serde(rename = "webm")]` on `WebM` yields the canonical `"mp4" | "mov" | "webm"` union. Other enums (RateControl, X264Preset, AudioCodec) stay kebab-case since their identifiers don't suffer the same lowering artifact.
- **Deferred runtime consumption** — wiring `encoder_options` into `export_run_inner` / FFmpeg argv is explicitly out of Phase 13 scope per the plan. Validation is in place; runtime plumbing lands in a later phase. Marked with a single-line inline comment in `export_validate_config`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed pre-existing author_snapshot test compile errors**
- **Found during:** Task 1 GREEN verification
- **Issue:** Two `#[tokio::test]` functions in `apps/desktop/src-tauri/src/commands/author_snapshot.rs` passed `String` (JSON-serialized `SelectorOrText`) as the third argument to `author_snapshot_validate`, but the function signature takes `super::parse::SelectorOrTextDto`. This is a pre-existing compile error unrelated to Plan 13-01 but blocks the entire `cargo test --lib` binary from building, preventing Task 1's test gate.
- **Fix:** Replaced `serde_json::to_string(&story_parser::SelectorOrText::TestId("x".into())).unwrap()` with a direct `super::super::parse::SelectorOrTextDto::TestId("x".into())` construction. Minimal, no behavior change — tests still exercise the same `TestId` variant against the same host function.
- **Files modified:** `apps/desktop/src-tauri/src/commands/author_snapshot.rs` (2 call sites)
- **Commit:** 977a912 (bundled with Task 1 GREEN since fix was a prerequisite for running the Task 1 test gate)

**2. [Cosmetic refinement] ContainerDto lowercase override**
- **Found during:** Task 2 TS regen verification
- **Issue:** Default kebab-case emitted `"mp-4" | "mov" | "web-m"` which is not the canonical form frontend consumers expect for container format strings.
- **Fix:** Switched `ContainerDto` to `#[serde(rename_all = "lowercase")]` with `#[serde(rename = "webm")]` on the `WebM` variant.
- **Commit:** 995fbfb

### Out-of-scope items (deferred, not fixed)

- Pre-existing clippy warnings in `crates/storage/src/project_folder.rs` (uninlined_format_args) and several files in `apps/desktop/src-tauri/src/` (manual_pattern_char_comparison etc.). These fire under `--no-deps -D warnings` but are NOT caused by Plan 13-01 edits. My modified files (`export.rs`, `ipc_spec.rs`, `author_snapshot.rs`) produce zero clippy output.

## Verification

```
$ cargo test -p storycapture --lib commands::export::tests
test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 49 filtered out

$ grep -c "\.typ::<export::" apps/desktop/src-tauri/src/ipc_spec.rs
11

$ grep -E "EncoderOptionsDto|AudioOptionsDto|ContainerDto" packages/shared-types/src/ipc.ts | head -3
export type AudioOptionsDto = { codec?: AudioCodecDto | null; bitrate_kbps?: number | null; channels?: number | null; sample_rate_hz?: number | null }
export type ContainerDto = "mp4" | "mov" | "webm"
export type EncoderOptionsDto = { container?: ContainerDto | null; ... audio?: AudioOptionsDto | null }
```

## Known Stubs

None. Every new DTO is registered, typed, validated, and committed alongside the regenerated TS bindings. Runtime consumption deferral is documented as a scope note, not a stub.

## Threat Flags

None. This plan only extends an existing IPC DTO shape with optional nested fields; no new network surface, auth path, or trust boundary is introduced. Validation ranges (keyframe, audio bitrate, channels) are defensive — they reject malformed input before it reaches the encoder sidecar.

## Self-Check: PASSED

- Files exist:
  - FOUND: apps/desktop/src-tauri/src/commands/export.rs
  - FOUND: apps/desktop/src-tauri/src/ipc_spec.rs
  - FOUND: packages/shared-types/src/ipc.ts
  - FOUND: apps/desktop/src-tauri/src/commands/author_snapshot.rs
- Commits exist:
  - FOUND: e95b762 (test RED 1)
  - FOUND: 977a912 (feat GREEN 1)
  - FOUND: a2299fc (test RED 2)
  - FOUND: 995fbfb (feat GREEN 2)
- TDD gates present: 2× test→feat pairs in git log, order preserved.
