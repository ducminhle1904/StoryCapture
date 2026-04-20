---
phase: 12
plan: 04
subsystem: ipc
tags: [ipc, tauri-specta, dto, phase-12, no-ui]
requires: [12-01, 12-02, 12-03]
provides:
  - "OutputResolutionDto, FitModeDto, PadColorDto, QualityPresetDto, ScaleAlgoDto IPC enums"
  - "From<*Dto> for encoder::* bridge impls"
  - "StartRecordingArgs extended with 5 optional serde-default fields (backward compatible)"
  - "start_recording honors DTOs when Some, falls back to Phase 12 defaults when None"
  - "Regenerated packages/shared-types/src/ipc.ts with 5 new DTO type exports"
affects:
  - apps/desktop/src-tauri/src/commands/encode.rs
  - apps/desktop/src-tauri/src/ipc_spec.rs
  - packages/shared-types/src/ipc.ts
tech-stack:
  added: []
  patterns:
    - "Thin Dto -> domain type bridge with From impl, mirrors HardwareEncoderDto convention"
    - "#[serde(default)] Option<Dto> fields keep IPC surface additive"
    - "tauri-specta .typ::<T>() registration for every exported type"
key-files:
  created:
    - .planning/phases/12-fix-video-output-resolution-lock-letterbox/12-04-SUMMARY.md
  modified:
    - apps/desktop/src-tauri/src/commands/encode.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - packages/shared-types/src/ipc.ts
decisions:
  - "All 5 DTOs use #[serde(rename_all = \"kebab-case\")] matching HardwareEncoderDto convention; sum-type DTOs (PadColorDto, OutputResolutionDto) use #[serde(tag = \"kind\")] so the TS discriminated union reads `{ kind: \"...\" }`"
  - "StartRecordingArgs fields are Option<DtoT> with #[serde(default)]; absent => None => Phase 12 default, so legacy React callers continue to work untouched"
  - "start_recording builder chain replaces hard-coded Phase 12 defaults from Plan 12-03 with DTO-resolved values; the default path still lands on P1080 + Letterbox + Black + Med + Lanczos when React sends no new fields"
metrics:
  duration: "~25 minutes"
  completed: 2026-04-20
---

# Phase 12 Plan 04: IPC DTOs + TS Bindings Summary

One-liner: Expose 5 encoder knobs (OutputResolution / FitMode / PadColor / QualityPreset / ScaleAlgo) across the Tauri IPC boundary as optional, additive `StartRecordingArgs` fields so Phase 13 UI can drive them without further backend work; legacy callers keep getting Phase 12 hard-coded defaults.

## What Shipped

- `FitModeDto`, `ScaleAlgoDto`, `QualityPresetDto` — plain kebab-case string enums (Copy).
- `PadColorDto`, `OutputResolutionDto` — tagged sum types (`#[serde(tag = "kind")]`) so TS sees `{ kind: "black" }` / `{ kind: "custom"; r: u8; g: u8; b: u8 }` / `{ kind: "p1080" }` / `{ kind: "custom"; w: u32; h: u32 }`.
- `From<FitModeDto> for FitMode`, `From<ScaleAlgoDto> for ScaleAlgo`, `From<QualityPresetDto> for QualityPreset`, `From<PadColorDto> for PadColor`, `From<OutputResolutionDto> for OutputResolution` — trivial match bridges.
- `StartRecordingArgs` gains `output_resolution`, `fit_mode`, `pad_color`, `quality_preset`, `scale_algo` as `Option<DtoT>` with `#[serde(default)]`.
- `start_recording` now resolves each optional DTO via `Option::map(Into::into).unwrap_or(Phase12Default)` then threads the result into the `EncodeConfig` builder chain, replacing the hard-coded defaults introduced in Plan 12-03.
- `ipc_spec.rs` registers all 5 DTOs via `.typ::<encode::*Dto>()` right after `StartRecordingArgs`.
- `packages/shared-types/src/ipc.ts` regenerated through `cargo run --bin specta-emit`; 5 new exports visible.

## Verification

- `cargo check -p storycapture` — green (after adding the expected sidecar binary placeholders `binaries/ffmpeg-aarch64-apple-darwin`, `binaries/playwright-sidecar-aarch64-apple-darwin`, `binaries/playwright-sidecar-modules/` which are part of the pre-existing host build-script contract; these are untracked and deliberately NOT committed).
- `cargo run --bin specta-emit` — wrote `packages/shared-types/src/ipc.ts`.
- `grep OutputResolutionDto packages/shared-types/src/ipc.ts` → 1 match (line 1232).
- `grep -E "FitModeDto|PadColorDto|QualityPresetDto|ScaleAlgoDto" packages/shared-types/src/ipc.ts` → 4+ matches (lines 1179, 1233, 1280, 1321, 1348).
- `git diff --stat packages/shared-types/src/ipc.ts` → 442 insertions, 94 deletions (deletions are stale comments/types from pre-regen drift, e.g. old `StartRecordingArgs = { project_folder; display_id: bigint; ... }` which was out of sync with the Rust struct even before this plan — the regen brings the file back in line with the current source).

## Deviations from Plan

### Deferred Issues (out of scope)

**1. `pnpm --filter @storycapture/desktop exec tsc --noEmit` fails with TS5101 baseUrl deprecation warning.**
- Pre-existing failure (reproduces identically on `main` at f065801 with zero local changes).
- Root cause: `apps/desktop/tsconfig.json:22` sets `"baseUrl"` which TypeScript 7.x will remove; project needs to either add `"ignoreDeprecations": "6.0"` or migrate off `baseUrl` onto path mappings.
- Out of scope for Plan 12-04 (IPC layer only, no tsconfig ownership). Verified the regenerated `ipc.ts` itself has no TS errors — the blocker fires on a tsconfig option, before compilation reaches our new types.
- Logged in this SUMMARY (no `deferred-items.md` exists in the phase dir).

### Host build-script placeholders (infra, not code)

The Tauri host `build.rs` (`tauri-build::build()`) enforces existence of `binaries/ffmpeg-<triple>` / `binaries/playwright-sidecar-<triple>` / `binaries/playwright-sidecar-modules/` declared in `tauri.conf.json`. The worktree (and the main repo at f065801) ships only `.gitkeep` for `binaries/`. To make `cargo check -p storycapture` green I created empty placeholder files + an empty `binaries/playwright-sidecar-modules/` directory locally. **These are not committed** (they fall outside the plan's `files_modified` whitelist and CI builds the real binaries via a separate pipeline).

## Self-Check: PASSED

- Created file exists: `.planning/phases/12-fix-video-output-resolution-lock-letterbox/12-04-SUMMARY.md` → will be FOUND after this write.
- Commit exists: `cab512f` (`feat(12-04): add OutputResolution/FitMode/PadColor/QualityPreset/ScaleAlgo IPC DTOs + regen TS bindings`).
- 5 DTOs present in `apps/desktop/src-tauri/src/commands/encode.rs`.
- 5 `.typ::<encode::*Dto>()` registrations present in `apps/desktop/src-tauri/src/ipc_spec.rs`.
- 5 new exports present in `packages/shared-types/src/ipc.ts`.
