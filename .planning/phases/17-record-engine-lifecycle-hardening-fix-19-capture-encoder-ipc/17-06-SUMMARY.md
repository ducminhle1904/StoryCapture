---
phase: 17
plan: 06
wave: 4
status: completed
completed_at: 2026-04-22
decisions_covered: [D-16, D-17, D-18, D-19]
files_modified:
  - crates/capture/src/error.rs
  - crates/capture/src/macos/sck_backend.rs
  - crates/capture/src/windows/wgc_backend.rs
  - crates/encoder/Cargo.toml
  - crates/encoder/src/lib.rs
  - crates/encoder/src/probe.rs
  - apps/desktop/src-tauri/src/commands/encode.rs
  - apps/desktop/src/features/recorder/TargetThumbnail.test.tsx
files_added: []
commits:
  - 9742d09 feat(17-06): reject NV12 explicitly + tighten capture counter ordering to AcqRel
  - 0ebd50a feat(17-06): force_reprobe for HW encoders + refresh_hw_encoders command body
  - 8243d1a test(17-06): remove @ts-ignore from TargetThumbnail.test.tsx
  - 6a0e82c chore(17-06): scrub OnceLock/OnceCell references from probe.rs doc comment
---

# Phase 17 Plan 06: Wave 4 — POLISH — Summary

Four contract-cleanup fixes that make the record engine's public surfaces honest: NV12 fails loudly instead of being silently coerced to BGRA; the HW-encoder probe cache can be invalidated and reseeded at runtime through a new `refresh_hw_encoders` RPC; capture-thread stat counters now have AcqRel/Acquire ordering across the capture→stop boundary; and the last remaining `@ts-ignore` in the recorder frontend is gone.

## What Changed

### D-16 — NV12 reject

- `crates/capture/src/error.rs`: added `CaptureError::UnsupportedPixelFormat { format: String }` as the last variant (preserves the 17-02 `StopTimedOut` + 17-03 `WindowGone` append order).
- `crates/capture/src/macos/sck_backend.rs`: `SckBackend::start()` now rejects `PixelFormat::Nv12` at entry before any `spawn_blocking(build_filter)` call. The old `// Force BGRA until we add native NV12 handling.` branch is gone; the match arm is now `unreachable!`.
- `crates/capture/src/windows/wgc_backend.rs`: same guard at `WgcBackend::start()` entry, symmetric with SCK. The orchestrator-level fallback does not intercept this — an explicit NV12 request fails loudly on both platforms.
- Unit tests: `nv12_reject_tests::start_with_nv12_returns_unsupported_pixel_format` on both SCK (`cfg(target_os = "macos")`) and WGC (`cfg(target_os = "windows")`). The SCK test runs green on this machine today.

### D-17 — HW probe force_reprobe

- `crates/encoder/Cargo.toml`: added `parking_lot = { workspace = true }`.
- `crates/encoder/src/lib.rs`: `mod probe;` → `pub mod probe;` so the host can call `encoder::probe::force_reprobe`.
- `crates/encoder/src/probe.rs`:
  - Added `static PROBE_CACHE: LazyLock<parking_lot::RwLock<Option<EncoderProbe>>>`.
  - `pub async fn probe_cached(cmd)`: read-lock fast path; on miss, drop, write-lock, compute via `probe_encoders`, cache, return.
  - `pub async fn force_reprobe(cmd)`: always runs `probe_encoders`, write-locks, overwrites, returns.
  - `__test_set_cache` / `__test_peek_cache` test hooks (cfg(test) only).
  - Grep gate compliance: `parking_lot::RwLock` present (2 hits); zero occurrences of `OnceLock` or `OnceCell` anywhere in the file (the doc comment was scrubbed in the trailing fix commit).
- `apps/desktop/src-tauri/src/commands/encode.rs`: replaced the 17-01 stub body of `refresh_hw_encoders` with a direct `encoder::probe::force_reprobe(&cmd).await` call, mapped to `AppError::Encoder` on failure. Return type `EncoderProbeDto` unchanged — IPC contract stable.
- Unit test: `probe::tests::test_probe_force_reprobe` seeds the cache with a sentinel, calls `force_reprobe`, asserts the cache was overwritten, then asserts a follow-up `probe_cached` short-circuits (sidecar spawn count == 1). Uses a `MockCmd` that shells out to `sh -c 'printf …'` so the child's piped stdio behaves like the real sidecar.

### D-18 — AcqRel counter ordering

Surgical upgrade of `fetch_add` sites that feed values read cross-thread in `stop()`:

- `crates/capture/src/macos/sck_backend.rs`: two increments inside the SCK output handler (`delivered`, `dropped`) moved `Relaxed → AcqRel`. The two paired loads in `stop()` moved `Relaxed → Acquire`; the two post-read resets moved `Relaxed → Release`.
- `crates/capture/src/windows/wgc_backend.rs`: five increments inside `on_frame_arrived` (2× bad-frame drop paths, 1× overflowed-crop drop, `delivered` on success, `dropped` on Full) moved `Relaxed → AcqRel`. WGC `stop()` already used `Acquire` prior to this plan — confirmed unchanged.
- Unchanged (out of scope per "be surgical, don't shotgun-upgrade"):
  - `SckBackend::dropped_frames()` / `delivered_frames()` introspection getters — single-threaded best-effort reads.
  - `paused.load(Ordering::Relaxed)` in both backends — fast-path pause flag, not a cross-thread counter.
  - Counter-reset stores inside `start()` — happen before the capture handler is wired up.

### D-19 — Remove @ts-ignore

- `apps/desktop/src/features/recorder/TargetThumbnail.test.tsx`: replaced two `@ts-ignore` lines above raw `globalThis.URL.createObjectURL = vi.fn(...)` / `revokeObjectURL = vi.fn(...)` assignments with `Object.defineProperty(globalThis.URL, <name>, { value: vi.fn(...), writable: true, configurable: true })`. Semantics identical (same spy wiring, same arrays for assertion), but strict TS accepts the property-descriptor form without any suppression.
- Grep gate: zero `@ts-ignore` and zero `@ts-expect-error` in the file.
- Tests: 6/6 pass; `tsc -b --noEmit` clean for the desktop app.

## Verification

Acceptance grep matrix (all required values met):

| Check                                                                                 | Required | Actual |
| ------------------------------------------------------------------------------------- | -------- | ------ |
| `grep -c "parking_lot::RwLock" crates/encoder/src/probe.rs`                           | ≥ 1      | 2      |
| `grep -c "OnceLock\|OnceCell" crates/encoder/src/probe.rs`                            | 0        | 0      |
| `grep -c "pub fn force_reprobe\|pub async fn force_reprobe" crates/encoder/src/probe.rs` | 1        | 1      |
| `grep -c "force_reprobe" apps/desktop/src-tauri/src/commands/encode.rs`               | ≥ 1      | 1      |
| `grep -c "UnsupportedPixelFormat" crates/capture/src/error.rs`                        | 1        | 1      |
| `grep -c "UnsupportedPixelFormat" crates/capture/src/macos/sck_backend.rs`            | ≥ 1      | 3      |
| `grep -c "UnsupportedPixelFormat" crates/capture/src/windows/wgc_backend.rs`          | ≥ 1      | 3      |
| `grep -c "Ordering::AcqRel" crates/capture/src/macos/sck_backend.rs`                  | ≥ 1      | 2      |
| `grep -c "Ordering::AcqRel" crates/capture/src/windows/wgc_backend.rs`                | ≥ 1      | 7      |
| `grep -c "@ts-ignore" apps/desktop/src/features/recorder/TargetThumbnail.test.tsx`    | 0        | 0      |
| `grep -c "@ts-expect-error" apps/desktop/src/features/recorder/TargetThumbnail.test.tsx` | 0     | 0      |

Automated runs:

- `cargo test -p capture --lib` → 37/37 pass (includes new `nv12_reject_tests::start_with_nv12_returns_unsupported_pixel_format`).
- `cargo test -p encoder --lib test_probe_force_reprobe` → 1/1 pass.
- `cargo test -p encoder --lib` → 97/97 pass.
- `cargo check -p capture -p encoder -p storycapture` → clean.
- `pnpm vitest run TargetThumbnail` → 6/6 pass.
- `pnpm --filter desktop typecheck` → clean.

## Deviations from Plan

None beyond an adaptation forced by the existing codebase state:

- **Plan text said** "replace OnceLock/OnceCell with parking_lot::RwLock". **Actual**: `probe.rs` on `main` never had a `OnceLock`/`OnceCell` cache to begin with (`probe_encoders` took `&dyn SidecarCommand` on every call). I added the cache + a `probe_cached` wrapper alongside the existing `probe_encoders`, kept `probe_encoders`' signature stable, and layered `force_reprobe` on top. Net effect matches the plan's intent (cache with explicit overwrite hook) without breaking the existing 9 call sites of `probe_encoders`.
- **Plan text sketched** `pub fn force_reprobe() -> ProbeResult` (zero-arg). **Actual**: `pub async fn force_reprobe(cmd: &dyn SidecarCommand) -> Result<EncoderProbe>` — the probe fundamentally needs a sidecar command to run ffmpeg. Command handler threads `AppHandle → TauriSidecar` through to `force_reprobe`. The plan's `spawn_blocking(|| ...)` suggestion would break because `probe_encoders` is async and requires the sidecar handle — async works better. Grep gate `pub fn force_reprobe` was updated to include the `async fn` form in the matrix above (matches the file content).

## Deferred Items

See `deferred-items.md` in this phase directory for the full list. New entries from 17-06:

- Pre-existing clippy errors in `crates/capture/src/target.rs` (3× `uninlined_format_args`), `crates/capture/src/macos/screenshot.rs` (unused import), `crates/capture/src/macos/sck_backend.rs` (dead_code on `build_filter_for_test_region`), `crates/capture/src/fallback/xcap_backend.rs` (type_complexity). Verified with `git stash` — all present on `main` before Wave 4.
- `apps/desktop/src/state/output-prefs.test.ts:70` — `@ts-expect-error` is legitimate (the test intentionally asserts a compile-time type violation). Out of scope for D-19 which only targeted `TargetThumbnail.test.tsx`.

## TDD Gate Compliance

Each task was RED-then-GREEN in spirit: for D-16 + D-17 the test enumerates the contract before the body compiles (`start_with_nv12_returns_unsupported_pixel_format`, `test_probe_force_reprobe`); for D-19 the test suite is pre-existing and must continue passing post-change. Commits: three `feat(...)` / `test(...)` commits covering all four decisions, plus one `chore` fix for a grep-gate violation in a doc comment.

## Self-Check: PASSED

- All four commits exist on `main`: 9742d09, 0ebd50a, 8243d1a, 6a0e82c.
- All files listed in `files_modified` exist and contain the described changes.
- Acceptance grep matrix: 11/11 required values met.
- Automated verification: all passing (see Verification section).
