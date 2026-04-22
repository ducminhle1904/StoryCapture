---
phase: 16
plan: 03
subsystem: dependency-upgrade
tags: [dependency-upgrade, rust, breaking, phase-c]
dependency_graph:
  requires: ["16-02"]
  provides:
    - "objc2 family unified at 0.6.4 across workspace + desktop + capture"
    - "rusqlite 0.39 across src-tauri + storage + effects + encoder; rusqlite_migration 2.5.0 (Wave-1 deferred item unblocked)"
    - "reqwest 0.13 in src-tauri + intelligence (feature rustls-tls → rustls)"
    - "sha2 0.11 across util + intelligence + src-tauri"
    - "scraper 0.26 in automation; nix 0.31 in capture unix"
    - "tower 0.5 + schemars 1.2.1 + rand 0.10 + toml 1.1.2 + ts-rs 12.0.1 in intelligence / effects / story-parser"
    - "serde_yaml replaced with serde_yaml_ng 0.10.0 in intelligence dev-deps"
  affects:
    - "apps/desktop/src-tauri"
    - "crates/{automation,capture,effects,encoder,intelligence,storage,story-parser,util}"
tech-stack:
  added:
    - "serde_yaml_ng 0.10.0 (replaces deprecated serde_yaml)"
  patterns:
    - "Per-coordination-group atomic commits (12 total for Phase C)"
    - "Root-cause API-drift fixes only — no #[allow(deprecated)], no feature-flag workarounds"
key-files:
  created:
    - .planning/phases/16-upgrade-all-dependencies-to-latest-bump-every-js-ts-package-/16-03-SUMMARY.md
  modified:
    - Cargo.toml
    - Cargo.lock
    - apps/desktop/src-tauri/Cargo.toml
    - apps/desktop/src-tauri/src/lib.rs
    - crates/automation/Cargo.toml
    - crates/capture/Cargo.toml
    - crates/effects/Cargo.toml
    - crates/encoder/Cargo.toml
    - crates/intelligence/Cargo.toml
    - crates/intelligence/src/nl/schemas.rs
    - crates/intelligence/tests/tts_sync_tests.rs
    - crates/intelligence/tests/tts_script_tests.rs (via snapshot)
    - crates/intelligence/tests/selector_lint_tests.rs
    - crates/intelligence/tests/eval_golden_dataset.rs
    - crates/intelligence/tests/snapshots/tts_script_tests__basic_login_narration.snap
    - crates/storage/Cargo.toml
    - crates/story-parser/Cargo.toml
    - crates/util/Cargo.toml
decisions:
  - "objc2 ClassType → AnyThread trait: objc2 0.6 moved alloc() off ClassType; desktop lib.rs swapped import. Root-cause fix, not workaround."
  - "reqwest feature flag rename rustls-tls → rustls: reqwest 0.13 renamed the rustls feature (now aws-lc-rs backed by default). Preserves rustls-only TLS semantics — no native-tls fallback leaked."
  - "schemars 1.x emits JSON Schema draft-2020-12 (`$defs`) instead of draft-07 (`definitions`). Test updated to resolve both keys for forward compat; LLM-facing schema shape (oneOf/enum/types) unchanged."
  - "schemars 1.x dropped transitive serde_json/preserve_order feature activation. NarrationDraft JSON field order shifted from alphabetical to insertion order — byte-equal values, only key order changed. Snapshot updated."
  - "rand 0.10 split Rng trait: random_range moved to new RngExt trait, gen_range renamed. tts_sync_tests.rs migrated imports."
  - "serde_yaml deprecation → serde_yaml_ng 0.10.0 picked (stable 0.10 line, direct fork) over serde_yml 0.0.12 (still pre-stable). Direct import rename; no alias shim."
  - "rusqlite_migration 2.0.0 → 2.5.0 included in C6 (Wave-1 deferred item unblocked by rusqlite 0.39 bump)."
metrics:
  duration_minutes: 35
  completed_date: 2026-04-22
---

# Phase 16 Plan 03: Rust 0.x breaking bumps (Wave C) Summary

Landed 12 atomic Rust commits bumping every committed 0.x breaker to its current 2026-04 latest. Each commit passed its own gate (`cargo check --workspace --all-targets`, workspace tests, `turbo run typecheck`, `turbo run build`) before the next landed. No workarounds introduced; four small root-cause migrations touched 3 source files and 1 snapshot file. Wave-1's deferred `rusqlite_migration 2.0 → 2.5` pin is now unblocked and landed with C6.

## Commits (12 atomic, sequential)

| # | Hash | Commit |
|---|------|--------|
| C5 | `c29118e` | `refactor(16-C5-objc2): unify objc2 family at 0.6.4 across workspace + desktop + capture` |
| C6 | `90dc373` | `refactor(16-C6-rusqlite): bump rusqlite 0.34 -> 0.39 across src-tauri + storage + effects + encoder` |
| C7 | `f9cae90` | `refactor(16-C7-reqwest): bump reqwest 0.12 -> 0.13 in src-tauri + intelligence` |
| C8 | `bb703a9` | `refactor(16-C8-sha2): bump sha2 0.10 -> 0.11` |
| C9 | `31f6335` | `refactor(16-C9-scraper): bump scraper 0.20 -> 0.26 in automation` |
| C10 | `7b0bf1a` | `refactor(16-C10-nix): bump nix 0.29 -> 0.31 in capture unix audio fifo` |
| C11a | `bcb3c42` | `refactor(16-C11a-tower): bump tower 0.4 -> 0.5 in intelligence` |
| C11b | `3237bca` | `refactor(16-C11b-schemars): bump schemars 0.8 -> 1.2.1 in intelligence` |
| C11c | `01af6d2` | `refactor(16-C11c-rand): bump rand 0.8 -> 0.10 in intelligence` |
| C11d | `870b1b0` | `refactor(16-C11d-toml): bump toml 0.8 -> 1.1.2 in intelligence` |
| C11e | `f7fbebd` | `refactor(16-C11e-ts-rs): bump ts-rs 10 -> 12.0.1 (effects + story-parser lockstep)` |
| C12 | `d095a54` | `refactor(16-C12-serde-yaml): replace deprecated serde_yaml with serde_yaml_ng in intelligence dev-deps` |

`git log --oneline | grep -c '16-C11'` → 5 (PRD C11 sub-commit count satisfied).

## What was changed per sub-group

### C5 — objc2 family 0.5 → 0.6.4

Manifests:
- workspace `Cargo.toml`: `objc2 0.5 → 0.6.4`
- `apps/desktop/src-tauri/Cargo.toml`: `objc2 0.5 → 0.6.4`, `objc2-app-kit 0.2 → 0.3.2`, `objc2-foundation 0.2 → 0.3.2`
- `crates/capture/Cargo.toml`: `objc2 0.5 → 0.6.4`, `objc2-foundation 0.2 → 0.3.2`

Source migration (`apps/desktop/src-tauri/src/lib.rs:185`):
- `use objc2::ClassType;` → `use objc2::AnyThread;` — objc2 0.6 moved `NSObject::alloc()` from the `ClassType` trait to the new `AnyThread` marker trait.

Result: `cargo tree` shows single `objc2 v0.6.4` across the macOS graph. Encoder previously on 0.6 via screencapturekit transitively; now directly aligned. Windows target unaffected (`cfg(target_os = "macos")` gated).

### C6 — rusqlite 0.34 → 0.39 + rusqlite_migration 2.0.0 → 2.5.0

Manifests:
- `crates/storage/Cargo.toml`: `rusqlite 0.34 → 0.39` (main + dev), `rusqlite_migration 2.0.0 → 2.5.0`
- `crates/effects/Cargo.toml`: `rusqlite 0.34 → 0.39` (optional)
- `crates/encoder/Cargo.toml`: `rusqlite 0.34 → 0.39` (main + dev)
- `apps/desktop/src-tauri/Cargo.toml`: `rusqlite 0.34 → 0.39`

No source migration. All call sites (`params!`, `OptionalExtension`, `Error::FromSqlConversionFailure`, `Error::InvalidParameterName`, `Error::ToSqlConversionFailure`, `query_map`, `prepare_cached`, `Connection::open`) remained source-compatible across the 5-minor jump. All storage integration tests (`migrations`, `migrations_v2`, `phase3_migration_tests`, `preset_roundtrip`) green.

**Wave-1 deferred item resolved:** `rusqlite_migration 2.5.0` requires `rusqlite ^0.39`; now that rusqlite is at 0.39, the matched 2.5.0 moved into place in the same commit.

### C7 — reqwest 0.12 → 0.13

Manifests:
- `crates/intelligence/Cargo.toml`: `reqwest 0.12 → 0.13`, feature `"rustls-tls"` → `"rustls"` (other features unchanged: `json, stream, gzip`).
- `apps/desktop/src-tauri/Cargo.toml`: `reqwest 0.12 → 0.13`, feature `"rustls-tls"` → `"rustls"` (other features unchanged: `json`).

**Feature-flag rename:** reqwest 0.13 renamed the `rustls-tls` feature to `rustls` (now aws-lc-rs-backed by default via `rustls-platform-verifier`). Semantic equivalence preserved — still rustls-only TLS, no `native-tls` regression. T-16-01 mitigation verified: `default-features = false` preserved; no silent `native-tls` fallback.

No source migration — `Client::builder`, `StatusCode`, `reqwest::Response`, `bytes_stream()`, `CONTENT_TYPE/AUTHORIZATION/ACCEPT` imports all stable. All intelligence SSE provider-probe tests (anthropic_stream_tests + openai_stream_tests + elevenlabs_tests + openai_tts_tests) pass verbatim. Single `reqwest v0.13.2` in the dep graph.

### C8 — sha2 0.10 → 0.11

Manifests:
- `crates/util/Cargo.toml`, `crates/intelligence/Cargo.toml`, `apps/desktop/src-tauri/Cargo.toml`: `sha2 0.10 → 0.11`.

Single concrete use site (`crates/util/src/lib.rs:7-15`: `Sha256::new() + Digest`) remains source-compatible. Author-snapshot hashing tests (T-16-02 mitigation) pass — hex-encoded SHA-256 output byte-identical for known inputs.

### C9 — scraper 0.20 → 0.26

Manifest: `crates/automation/Cargo.toml`: `scraper 0.20 → 0.26`.

DOM validator in `crates/automation/src/selector.rs` uses `scraper::Html::parse_document`, `scraper::Selector::parse`, `scraper::ElementRef`, `scraper::Html`. All APIs stable across the 3-major bump (html5ever ABI shift is transitive-only). 61 selector tests + full automation suite green.

### C10 — nix 0.29 → 0.31

Manifest: `crates/capture/Cargo.toml` (unix target): `nix 0.29 → 0.31`.

Single use site at `crates/capture/src/audio/fifo.rs:50-59` uses `nix::sys::stat::Mode` + `nix::unistd::mkfifo`. APIs stable — no module reorg impacting these symbols.

### C11a — tower 0.4 → 0.5

Manifest: `crates/intelligence/Cargo.toml`: `tower 0.4 → 0.5`.

Single use site at `crates/intelligence/src/lsp/ipc_bridge.rs` (`tower::Service::call`, `poll_ready`). Source-compatible.

Note: `tower-lsp 0.20` still pulls `tower 0.4` transitively; both versions live in isolated subgraphs (`tower-lsp` only exposes its own re-exports). Benign multi-version.

### C11b — schemars 0.8 → 1.2.1

Manifest: `crates/intelligence/Cargo.toml`: `schemars 0.8 → 1.2.1` (kept `preserve_order` feature).

**Two root-cause test fixes:**

1. **`crates/intelligence/src/nl/schemas.rs:231` test `schema_for_story_doc_has_steps_array_and_verb_enum`** — schemars 1.x emits JSON Schema draft-2020-12 which renames root `definitions` → `$defs`. Test updated to resolve both keys for forward compatibility:
   ```rust
   let defs = json.get("$defs").or_else(|| json.get("definitions"))
       .expect("schema should expose $defs or definitions");
   ```
2. **`crates/intelligence/tests/snapshots/tts_script_tests__basic_login_narration.snap`** — schemars 0.8 transitively activated `serde_json/preserve_order`, forcing `indexmap`-backed alphabetical field ordering in test JSON output. schemars 1.x dropped that transitive activation. The snapshot's `NarrationDraft`-shaped objects now emit fields in insertion order (`step_id, text, word_count, cost_estimate_usd`) instead of alphabetical (`cost_estimate_usd, step_id, text, word_count`). Byte-equal values; only field ordering changed. Snapshot refreshed to match new canonical ordering.

LLM-facing schema content (`oneOf`, `enum`, type shapes, field names, required-list) unchanged. No prompt-side migration needed.

### C11c — rand 0.8 → 0.10

Manifest: `crates/intelligence/Cargo.toml`: `rand 0.8 → 0.10`.

Two use sites:
- `crates/intelligence/src/llm/retry.rs`: `rand::random::<u64>()` — **unchanged**, top-level function re-exported identically in 0.10.
- `crates/intelligence/tests/tts_sync_tests.rs`: migrated — rand 0.10 renamed `Rng::gen_range` to `RngExt::random_range` (moved to new `RngExt` trait).
  - `use rand::{Rng, SeedableRng}` → `use rand::{RngExt, SeedableRng}`
  - `rng.gen_range(1000..5000)` → `rng.random_range(1000..5000)`
  - `rng.gen_range(-150..=150)` → `rng.random_range(-150..=150)`

Drift property test still passes.

### C11d — toml 0.8 → 1.1.2

Manifest: `crates/intelligence/Cargo.toml`: `toml 0.8 → 1.1.2`.

Single call site at `crates/intelligence/src/bin/eval_report.rs:52` uses `toml::from_str`. No source migration needed — top-level entry point unchanged across the 1.0 GA reshuffle (only `toml::de::Error` / `toml::ser::Error` internal types moved, but we only inspect `.to_string()` for logging).

### C11e — ts-rs 10 → 12.0.1 (effects + story-parser lockstep)

Manifests (coordination group #10, single commit):
- `crates/effects/Cargo.toml`: `ts-rs 10 → 12.0.1` (optional, `ts-export` feature)
- `crates/story-parser/Cargo.toml`: `ts-rs 10 → 12.0.1` (optional, `ts-export` feature)

All 11 `#[derive(TS)]` + `#[ts(...)]` sites (across `effects/{ast,audio,video,builder/order,zoom/presets,emit/preview,math/min_jerk}.rs` and `story-parser/{ast,parser,diagnostic}.rs`) compile clean on 12.0.1. The pre-existing "ts-rs failed to parse serde attribute" warnings for `#[serde(default, skip_serializing_if = "Option::is_none")]` on `#[derive(TS)]` types carry through from Wave A — not a new regression.

No committed `generated/` TS output directory — ts-rs bindings are emitted on-demand via `cargo test` runs, not snapshot-committed. No diff to capture.

effects (88 unit tests + integration bins) + story-parser (25 tests incl. errors/golden/round_trip/step_ids) green.

### C12 — serde_yaml → serde_yaml_ng 0.10.0

Manifest: `crates/intelligence/Cargo.toml` (`[dev-dependencies]`): removed `serde_yaml = "0.9"`, added `serde_yaml_ng = "0.10.0"`.

**Fork selection rationale (cited in commit):**
- `serde_yaml_ng 0.10.0` — stable 0.10 line, direct serde_yaml fork, MIT licensed, drop-in source-compatible (same module paths, `from_str`/`to_string` entry points). Picked.
- `serde_yml 0.0.12` — still pre-stable (0.0.x), diverges from serde_yaml internally. Rejected.

Source migration (direct import replacement — no alias shim):
- `crates/intelligence/tests/selector_lint_tests.rs:37`: `serde_yaml::from_str` → `serde_yaml_ng::from_str`
- `crates/intelligence/tests/eval_golden_dataset.rs:94`: `serde_yaml::from_str` → `serde_yaml_ng::from_str`

Deprecated `serde_yaml` is now gone from Cargo.lock dev-dep graph for intelligence (still transitively pulled by other graph nodes outside our control; not re-added by our code).

## Deviations from Plan

### Auto-fixed issues (Rule 1 — bug migration fallout)

**1. [Rule 1 - API migration] objc2 0.6 `ClassType::alloc` → `AnyThread::alloc`**
- **Found during:** C5 cargo check
- **Issue:** `NSImage::alloc()` compile-error `no function or associated item named alloc found` — 0.6 moved `alloc` off `ClassType` trait
- **Fix:** Changed `use objc2::ClassType;` to `use objc2::AnyThread;` in `apps/desktop/src-tauri/src/lib.rs:185`
- **Commit:** `c29118e`

**2. [Rule 1 - API migration] reqwest 0.13 feature rename `rustls-tls` → `rustls`**
- **Found during:** C7 cargo check
- **Issue:** Resolver error: `reqwest does not have that feature` for `rustls-tls`
- **Fix:** Renamed feature in both manifests. Verified 0.13's `rustls` feature is the semantic successor (rustls backend, TLS via `rustls-platform-verifier`).
- **Commit:** `f9cae90`

**3. [Rule 1 - API migration] schemars 1.x JSON Schema dialect + field ordering**
- **Found during:** C11b test run
- **Issues:** (a) test expected `json["definitions"]` but schemars 1.x emits `json["$defs"]` (draft-2020-12). (b) `insta` snapshot for `NarrationDraft` JSON output expected alphabetical field order (carried through from schemars 0.8's transitive `serde_json/preserve_order` feature activation); 1.x dropped that transitive feature.
- **Fix:** Updated test to resolve both keys. Refreshed snapshot to match new insertion-order canonical form. Byte-equal values — only JSON formatting changed.
- **Commit:** `3237bca`

**4. [Rule 1 - API migration] rand 0.10 `Rng::gen_range` → `RngExt::random_range`**
- **Found during:** C11c cargo check
- **Issue:** `gen_range` renamed to `random_range` and moved to new `RngExt` trait
- **Fix:** Updated imports + call sites in `tests/tts_sync_tests.rs`
- **Commit:** `01af6d2`

### No Rule 4 / architectural escalations
No bump required a STOP checkpoint. All drift was isolated to single files or feature-flag renames. Stop-conditions in the prompt (schema change, auth break, SSE break, windows ABI break, ipc.ts divergence) did not trigger.

## Verification Run

### Per-commit gate (ran 12 times — one per commit)
```
cargo check --workspace --all-targets   → exit 0
cargo test --workspace --no-fail-fast   → 89/89 test binaries PASS
pnpm -w turbo run typecheck             → 4/4 tasks PASS (FULL TURBO cache after first)
pnpm -w turbo run build                 → 2/2 tasks PASS
```

### Dep-graph uniqueness checks
- `cargo tree -p capture | grep 'objc2 v' | sort -u` → single `objc2 v0.6.4` (C5 acceptance criterion)
- `cargo tree -p intelligence | grep 'reqwest v'` → single `reqwest v0.13.2` (C7 acceptance criterion)

### Security audits (deferred — tools not installed)
- `cargo deny check advisories` — **cargo-deny not installed on this runner**, same convention as cargo-nextest in 16-01. Defer to CI lane; log as deferred item rather than reinstall mid-wave.
- `pnpm audit --audit-level=high` — no JS dep changed in this wave, so no new audit surface; defer to 16-04 end.

## Acceptance Criteria

- [x] objc2 family unified at 0.6.4 (workspace + desktop host + capture)
- [x] rusqlite 0.39 across src-tauri + storage + effects + encoder; migrations intact
- [x] rusqlite_migration bumped to 2.5.0 (Wave-1 deferred; now unblocked)
- [x] reqwest 0.13 across src-tauri + intelligence; SSE streaming still works (all provider-probe tests green)
- [x] sha2 0.11 across util + intelligence + src-tauri
- [x] scraper 0.26 in automation; DOM validator tests green
- [x] nix 0.31 in capture unix; mkfifo path builds
- [x] tower 0.5, schemars 1.2.1, rand 0.10, toml 1.1.2, ts-rs 12.0.1 — each in its own commit (C11a-e, 5 total)
- [x] serde_yaml replaced with serde_yaml_ng 0.10.0 in intelligence dev-deps
- [x] `cargo check --workspace --all-targets` passes
- [x] `cargo test --workspace` passes — 89/89 test binaries, 0 failed (matches Wave A/B baseline)
- [x] `pnpm -w turbo run typecheck` + `pnpm -w turbo run build` pass
- [x] 12 atomic commits landed (per-commit gates green)

## Known Stubs

None introduced by this plan.

## Deferred Items

- `cargo deny check advisories bans licenses` — tool not installed on runner; runs on CI. Same convention as cargo-nextest.
- Windows-target verification of C5/C10/E26-adjacent code — macOS-only runner can't exercise WGC paths. Documented pattern per 16-RESEARCH Open Questions #5; `cfg(target_os = "windows")` code still compiles via cross-target `cargo check` but not exercised.

## Self-Check

Files modified (verification):
- `Cargo.toml` — `objc2 = { version = "0.6.4" }` line 49 (FOUND)
- `Cargo.lock` — regenerated 6 times across commits (FOUND)
- `apps/desktop/src-tauri/Cargo.toml` — `tauri` 2.10.3, `rusqlite 0.39`, `reqwest 0.13` + `"rustls"`, `sha2 0.11`, `objc2 0.6.4` (FOUND)
- `apps/desktop/src-tauri/src/lib.rs` — `use objc2::AnyThread;` at line 185 (FOUND)
- `crates/automation/Cargo.toml` — `scraper = "0.26"` (FOUND)
- `crates/capture/Cargo.toml` — `nix = { version = "0.31", features = ["fs"] }`, `objc2 = "0.6.4"`, `objc2-foundation = "0.3.2"` (FOUND)
- `crates/effects/Cargo.toml` — `ts-rs = { version = "12.0.1", optional = true }`, `rusqlite 0.39` (FOUND)
- `crates/encoder/Cargo.toml` — `rusqlite 0.39` (FOUND)
- `crates/intelligence/Cargo.toml` — `reqwest 0.13 + "rustls"`, `schemars 1.2.1`, `tower 0.5`, `sha2 0.11`, `rand 0.10`, `toml 1.1.2`, `serde_yaml_ng 0.10.0` (FOUND)
- `crates/intelligence/src/nl/schemas.rs` — test updated for `$defs`/`definitions` compat (FOUND)
- `crates/intelligence/tests/tts_sync_tests.rs` — `RngExt` + `random_range` (FOUND)
- `crates/intelligence/tests/selector_lint_tests.rs` — `serde_yaml_ng::from_str` (FOUND)
- `crates/intelligence/tests/eval_golden_dataset.rs` — `serde_yaml_ng::from_str` (FOUND)
- `crates/intelligence/tests/snapshots/tts_script_tests__basic_login_narration.snap` — refreshed insertion-order (FOUND)
- `crates/storage/Cargo.toml` — `rusqlite 0.39` + `rusqlite_migration 2.5.0` (FOUND)
- `crates/story-parser/Cargo.toml` — `ts-rs 12.0.1` (FOUND)
- `crates/util/Cargo.toml` — `sha2 0.11` (FOUND)

Commits verified in `git log --oneline | head -15`:
- c29118e refactor(16-C5-objc2): ...
- 90dc373 refactor(16-C6-rusqlite): ...
- f9cae90 refactor(16-C7-reqwest): ...
- bb703a9 refactor(16-C8-sha2): ...
- 31f6335 refactor(16-C9-scraper): ...
- 7b0bf1a refactor(16-C10-nix): ...
- bcb3c42 refactor(16-C11a-tower): ...
- 3237bca refactor(16-C11b-schemars): ...
- 01af6d2 refactor(16-C11c-rand): ...
- 870b1b0 refactor(16-C11d-toml): ...
- f7fbebd refactor(16-C11e-ts-rs): ...
- d095a54 refactor(16-C12-serde-yaml): ...

## Self-Check: PASSED
