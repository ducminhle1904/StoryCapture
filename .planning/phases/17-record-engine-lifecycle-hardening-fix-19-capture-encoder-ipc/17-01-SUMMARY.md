---
phase: 17
plan: 01
wave: 0
status: completed
completed_at: 2026-04-22
decisions_covered: [D-09, D-11, D-13, D-15, D-17 (contract stub)]
files_modified:
  - apps/desktop/src-tauri/src/commands/encode.rs
  - apps/desktop/src-tauri/src/ipc_spec.rs
  - crates/encoder/src/config.rs
  - packages/shared-types/src/ipc.ts
---

# Phase 17 Plan 01: Additive IPC Surface — Summary

Wave 0 lands the additive IPC contract that Waves 1-4 depend on. Zero consumers wired; all symbols compile clean and surface through regenerated TS bindings.

## What Changed

### `crates/encoder/src/config.rs`
- `EncodeConfig` gains `keyframe_interval_sec: Option<u32>` (default `None` in `EncodeConfig::new`). D-11.

### `apps/desktop/src-tauri/src/commands/encode.rs`
- `RecordingEvent` enum gains two kebab-case variants (additive, preserves `#[serde(tag="type")]`):
  - `AudioUnavailable { reason: String }` → `{"type":"audio-unavailable","reason":...}` (D-13)
  - `Heartbeat { seq: u64 }` → `{"type":"heartbeat","seq":N}` (D-15)
- `StartRecordingArgs` gains two optional fields with `#[serde(default)]`:
  - `first_frame_timeout_ms: Option<u64>` (D-09)
  - `keyframe_interval_sec: Option<u32>` (D-11, IPC surface; forwarded to `EncodeConfig` by Wave 2/3)
- New Tauri command `refresh_hw_encoders(app) -> EncoderProbeDto` — Wave 0 stub re-runs `probe_encoders` directly (probe cache added by Wave 4 D-17).

### `apps/desktop/src-tauri/src/ipc_spec.rs`
- `collect_commands!` macro gains `encode::refresh_hw_encoders`.
- `.typ::<RecordingEvent>()`, `.typ::<StartRecordingArgs>()` already registered — new variants/fields flow through automatically.

### `packages/shared-types/src/ipc.ts`
- Regenerated via `cargo run --bin specta-emit`. AUTO-GENERATED header preserved. Surfaced:
  - `refreshHwEncoders()` wrapper (line ~552) invoking `refresh_hw_encoders`.
  - `RecordingEvent` union gains `{ type: "audio-unavailable"; reason }` and `{ type: "heartbeat"; seq }` arms.
  - `StartRecordingArgs` gains `first_frame_timeout_ms?: bigint | null` and `keyframe_interval_sec?: number | null`.

## Decisions Covered

| Decision | Scope landed here | Deferred to |
|----------|-------------------|-------------|
| D-09     | `StartRecordingArgs.first_frame_timeout_ms` field | 17-04 consumes (replaces hardcoded 3s) |
| D-11     | `EncodeConfig.keyframe_interval_sec` + IPC field  | 17-04 emits `-g` argv |
| D-13     | `RecordingEvent::AudioUnavailable` variant         | 17-05 emits from audio negotiation path |
| D-15     | `RecordingEvent::Heartbeat` variant                | 17-05 spawns the 2s ticker |
| D-17     | `refresh_hw_encoders` command registered (stub)    | 17-06 wires `probe::force_reprobe()` |

## Verification

| Command | Result |
|---------|--------|
| `cargo check -p encoder -p storycapture` | exit 0 |
| `cargo test -p encoder --lib config::` | 10/10 pass |
| `pnpm --filter desktop typecheck` | exit 0 |
| `cargo run --bin specta-emit` | wrote `packages/shared-types/src/ipc.ts` |
| Acceptance greps (AudioUnavailable, Heartbeat, first_frame_timeout_ms, keyframe_interval_sec, refresh_hw_encoders) | all >=1 in both Rust and TS |
| `git diff HEAD \| grep -c "Co-Authored-By\|@ts-ignore"` | 0 |

### Out-of-scope items NOT fixed (pre-existing, per CLAUDE.md SCOPE BOUNDARY)

- `cargo clippy -p encoder --lib --no-deps -- -D warnings` surfaces 5 pre-existing style errors in `src/export/psnr.rs` + `src/filters.rs` (uninlined_format_args, manual_pattern_char_comparison). None in `config.rs`.
- `cargo clippy -p storycapture --lib --no-deps -- -D warnings` surfaces 15 pre-existing style errors; 0 in `commands/encode.rs` or `ipc_spec.rs`.
- `pnpm biome check` reports 444 errors across the workspace pre-existing (same count before and after this plan; verified via `git stash` baseline). Included file `ipc.ts` is AUTO-GENERATED with `@ts-nocheck` and has 22 baseline-identical findings.

These do not affect the changes landed in 17-01 and are tracked as general tech-debt outside this plan's scope.

## Deviations

1. **Did NOT add `#[derive(specta::Type)]` to `EncodeConfig`.** The plan action says "if missing, so the field surfaces in generated TS". `encoder` crate has no `specta` dependency; adding one would be a cross-crate dep change beyond additive scope. The acceptance requirement (`keyframe_interval_sec` present in `ipc.ts`) is met instead by adding the field to `StartRecordingArgs` (existing `specta::Type` DTO) and mirroring it on `EncodeConfig`. Wave 2/3 will forward `args.keyframe_interval_sec` into the `EncodeConfig` builder when they consume it. Result: TS surface is correct, no crate-level dep churn, contract remains additive.

## Commit

Single commit on `main`: `feat(17-01): add additive IPC surface for record-engine hardening`.
