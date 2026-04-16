---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 02
subsystem: storage
tags: [rust, sqlite, rusqlite-migration, ai-telemetry, tts-cache, conversation-history, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/01
    provides: crates/intelligence trait surface (consumer of these tables)
  - phase: 02-cinematic-post-production-export/03
    provides: storage crate v2 migration infra (v1→v6)
provides:
  - storage::phase3::{insert_nl_turn, load_nl_history, insert_llm_metric, insert_tts_metric, upsert_tts_cache, lookup_tts_cache, gc_tts_cache_older_than, session_total_cost}
  - storage::phase3::{NlTurnInsert, NlTurn, LlmTurnMetric, TtsClipMetric, TtsCacheEntry}
  - project.sqlite schema v10 (v1 + 5 v2 + 4 v3 migrations)
  - 4 AI tables (nl_conversations, tts_cache_index, llm_turn_metrics, tts_clip_metrics)
  - session_rollup VIEW (per-session cost + token + latency aggregates)
  - Voiceover path-traversal guard (T-03-02-02 mitigation)
affects:
  - Phase 3 Wave 2 (LLM orchestrator writing llm_turn_metrics + nl_conversations)
  - Phase 3 Wave 3 (TTS cache writing tts_cache_index + tts_clip_metrics)
  - Future analytics surface consuming session_rollup
tech-stack:
  added: []
  patterns:
    - "v3 migration bundle layered via `all.extend(v3::project_migrations())` append pattern established by v2"
    - "Typed connection-scoped helpers (free functions taking `&Connection`) mirroring v2 repos/ convention — no ProjectDb wrapping needed for cross-tier reuse"
    - "Path traversal defense encoded in storage helper (upsert_tts_cache) so any caller — actor, CLI, tests — inherits the guard"
    - "GC accepts a `delete_fn: FnMut(&Path) -> io::Result<()>` closure so filesystem policy is caller-controlled (testable + dry-run friendly)"
    - "Sqlite VIEW bundled with last CREATE TABLE migration (m004) to keep v3 bundle count aligned with plan arithmetic"
key-files:
  created:
    - crates/storage/src/migrations/v3/m001_nl_conversations.sql
    - crates/storage/src/migrations/v3/m002_tts_cache_index.sql
    - crates/storage/src/migrations/v3/m003_llm_turn_metrics.sql
    - crates/storage/src/migrations/v3/m004_tts_clip_metrics.sql
    - crates/storage/src/migrations/v3/mod.rs
    - crates/storage/src/phase3.rs
    - crates/storage/tests/phase3_migration_tests.rs
  modified:
    - crates/storage/src/lib.rs
    - crates/storage/src/migrations/mod.rs
    - crates/storage/src/migrations/project/mod.rs
    - crates/storage/tests/migrations.rs
    - crates/storage/tests/migrations_v2.rs
key-decisions:
  - "Adopted existing repo convention (src/migrations/vN/mNNN_*.sql) instead of the plan's literal `V5__phase3_ai_tables.sql` single-file path — Phase 2 Plan 03 already established the multi-M::up bundle pattern and fusing four independent tables into one migration would diverge."
  - "Bundled session_rollup VIEW with m004_tts_clip_metrics.sql (not a 5th migration) so v3 contributes exactly 4 version bumps — view depends on llm_turn_metrics which already exists by m003."
  - "gc_tts_cache_older_than takes FnMut callback rather than performing std::fs::remove_file directly — decouples storage crate from fs policy, enables test spies, and matches plan's explicit acceptance-criterion wording."
  - "ENOENT from delete_fn is swallowed (row still removed) so GC remains idempotent when the underlying file is already gone; other io::Error kinds bubble via ToSqlConversionFailure (UserFunctionError variant doesn't exist on rusqlite 0.34)."
  - "Path guard allows any `voiceover/` prefix (including nested subdirs like `voiceover/step-xyz/`) while rejecting absolute, parent-dir, and non-voiceover prefixes — strict enough to block escape, lenient enough for future per-step directories."
requirements-completed: [AI-01, AI-02]
duration: 4 min
completed: 2026-04-16
---

# Phase 03 Plan 02: Storage V5 Migration — AI Tables + Session Rollup Summary

**v3 migration bundle (4 tables + 1 view) bumping `project.sqlite` to user_version=10, plus 8 typed phase3 helpers (nl/llm/tts inserts + queries, tts cache upsert/gc, session_total_cost) with T-03-02-02 path-traversal defense wired into upsert_tts_cache.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-16T00:52:55Z
- **Completed:** 2026-04-16T00:57:20Z
- **Tasks:** 2
- **Commits:** 2 (test + feat)
- **Files created:** 7
- **Files modified:** 5

## What Was Built

**Task 1 — v3 migration bundle.** Four `M::up` steps registered in `crates/storage/src/migrations/v3/` and chained onto the existing v2 bundle via `all.extend(v3::project_migrations())`:

| # | File | Creates |
|---|------|---------|
| m001 | nl_conversations.sql | `nl_conversations` (PK id, UNIQUE(project_id, turn_index), role CHECK in user/assistant/tool) + `idx_nl_conversations_project` |
| m002 | tts_cache_index.sql   | `tts_cache_index` (sha256 hash PK) + `idx_tts_cache_project` + `idx_tts_cache_last_used` |
| m003 | llm_turn_metrics.sql  | `llm_turn_metrics` (AI-SPEC §7.2 verbatim schema) + `idx_llm_turn_session` |
| m004 | tts_clip_metrics.sql  | `tts_clip_metrics` + `idx_tts_clip_step` + **`session_rollup` VIEW** (`COUNT`, `SUM(cost_usd)`, `SUM(input+output tokens)`, `AVG(first_token_ms)`, `MAX(timestamp)` grouped by session_id) |

`project_migrations::LATEST_VERSION` advances from 6 → 10. `app.sqlite` is unchanged (AI tables are per-project by design).

**Task 2 — phase3 typed helpers.** `crates/storage/src/phase3.rs` ships the 7 functions listed in the plan's `<interfaces>` block plus `insert_tts_metric` (needed by Wave 3 tests), with 5 companion structs (`NlTurnInsert`, `NlTurn`, `LlmTurnMetric`, `TtsClipMetric`, `TtsCacheEntry`). Key behaviours:

- `insert_nl_turn` / `load_nl_history(project_id)` — ordered by `turn_index ASC`; round-trip preserves role, content, tool_calls_json, token_usage_json, model, provider.
- `upsert_tts_cache` — `INSERT ... ON CONFLICT(hash) DO UPDATE SET last_used_at = excluded.last_used_at`. On re-upsert only `last_used_at` is touched (content-addressed cache key semantics). **T-03-02-02 guard runs before SQL:** rejects absolute paths, any `..` component, and any path not starting with `voiceover/`.
- `gc_tts_cache_older_than(conn, cutoff_ms, delete_fn)` — selects rows with `last_used_at < cutoff_ms`, calls `delete_fn(&Path)` for each (errors bubble except ENOENT, which is swallowed so row cleanup proceeds), deletes the row, returns the count removed.
- `session_total_cost(conn, &session_id)` — `SUM(cost_usd)` with `Option::unwrap_or(0.0)` for empty-session safety.

## Decisions Made

See `key-decisions` frontmatter. Summary:

1. **Multi-file migration bundle** instead of single `V5__phase3_ai_tables.sql` — matches v2's established pattern; deviating would break `project::LATEST_VERSION` arithmetic (which counts `M::up` calls, not schema steps).
2. **View bundled with m004** — view depends on `llm_turn_metrics` (created in m003), so it fits cleanly in the final migration without needing a 5th bump.
3. **Callback-based GC** — closure signature `FnMut(&Path) -> io::Result<()>` is exactly what the plan's behaviour case #4 requires. Enables test spies with zero filesystem I/O.
4. **`ToSqlConversionFailure` for I/O error bubbling** — `rusqlite::Error::UserFunctionError` does not exist in rusqlite 0.34 (scope boundary: blocking issue caught during first compile). Picked the nearest structural variant so downstream code can pattern-match if needed.

## Task Commits

1. **Task 1+2 RED — failing tests** — `35c0b97` `test(03-02): add failing tests for v3 AI tables + phase3 helpers`
2. **Task 1+2 GREEN — migration bundle + helpers + rebased v1/v2 tests** — `ef6a8d7` `feat(03-02): v3 AI tables migration + phase3 typed helpers`

Both tasks completed inside the same RED → GREEN cycle because they share a single integration-test file (9 tests). No REFACTOR pass needed — code is already minimal.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Plan's `migrations/V5__phase3_ai_tables.sql` single-file path does not match the established repo convention**
- **Found during:** Task 1 read_first (inspecting `crates/storage/migrations/`)
- **Issue:** Phase 2 Plan 03's SUMMARY and the actual crate layout use `src/migrations/vN/mNNN_*.sql` with `rusqlite_migration::M::up(include_str!(...))` calls appended to a `Vec<M<'static>>`. `LATEST_VERSION` is the migration count, not a schema identifier. Writing a single `V5__phase3_ai_tables.sql` would (a) not match the existing project structure and (b) bundle four independent tables into one migration step, making future reversibility harder.
- **Fix:** Split into 4 files under `src/migrations/v3/` (one per table), created `src/migrations/v3/mod.rs` returning `Vec<M<'static>>`, wired it in `migrations/mod.rs` and `migrations/project/mod.rs` via `all.extend(v3::project_migrations())`. Bumped `project::LATEST_VERSION` from 6 to 10.
- **Files modified:** all v3/*.sql + v3/mod.rs (created), migrations/mod.rs + migrations/project/mod.rs (modified)
- **Commit:** `ef6a8d7`

**2. [Rule 3 - Blocking] Pre-existing v1/v2 tests hardcoded `user_version == 6`**
- **Found during:** Task 1 verify (first `cargo test -p storage`)
- **Issue:** `tests/migrations.rs::fresh_db_runs_to_latest` and `tests/migrations_v2.rs` (4 assertions in 3 tests) all asserted `user_version == 6`. After LATEST_VERSION bumped to 10, they fail.
- **Fix:** Rebased assertions to 10 with comment explaining the v1:1 + v2:5 + v3:4 arithmetic. The `downgrade_detected_*` tests still use 42/99 as "higher than supported" — those remain valid. Same pattern Phase 2 Plan 03 used when bumping v1 → v2.
- **Files modified:** `crates/storage/tests/migrations.rs`, `crates/storage/tests/migrations_v2.rs`
- **Commit:** `ef6a8d7`

**3. [Rule 3 - Blocking] `rusqlite::Error::UserFunctionError` does not exist on rusqlite 0.34**
- **Found during:** Task 2 first compile of `gc_tts_cache_older_than`
- **Issue:** The plan's threat-model note mentions `UserFunctionError` for the path-guard violation error. The variant is gated to rusqlite's optional `functions` feature (not enabled in this crate) and is absent in the current binding.
- **Fix:** Used `rusqlite::Error::InvalidParameterName` for the path-guard error (semantically "callers passed a disallowed parameter value") and `rusqlite::Error::ToSqlConversionFailure` for the GC-delete I/O bubble. Both are always-available variants.
- **Files modified:** `crates/storage/src/phase3.rs`
- **Commit:** `ef6a8d7`

**4. [Rule 2 - Missing Critical] `insert_tts_metric` not listed in plan's <interfaces> but required by Wave 3 symmetry**
- **Found during:** Task 2 drafting
- **Issue:** Plan's interface block lists `insert_llm_metric` but not `insert_tts_metric`. The v3 schema has `tts_clip_metrics` and Wave 3 plans will need an inserter. Adding it now keeps the API symmetric and lets `tts_clip_metric_insert_roundtrips` test exercise the schema.
- **Fix:** Added `insert_tts_metric(conn, &TtsClipMetric)` mirroring the LLM inserter pattern.
- **Files modified:** `crates/storage/src/phase3.rs`, `crates/storage/tests/phase3_migration_tests.rs`
- **Commit:** `ef6a8d7`

---

**Total deviations:** 4 auto-fixed (3 blocking, 1 missing-critical). **Impact:** All deviations were necessary to make the plan compile and match the real repo conventions. No scope creep — every change is either structural (matching repo pattern) or test-parity (rebasing v1/v2 tests that the LATEST_VERSION bump invalidates).

## Authentication Gates

None — storage crate has no external dependencies requiring credentials.

## Verification

```bash
cargo test -p storage                                       # 55/55 green
cargo test -p storage --test phase3_migration_tests         # 9/9 green
cargo test -p storage --test phase3_migration_tests \
  migration_v5_creates_all_tables                           # 1/1 green (plan AC)
```

**Acceptance criteria results (Task 1):**

- `grep -c "^CREATE TABLE" v3/*.sql` → 4 (one per file) ✓
- `grep -c "^CREATE VIEW" v3/*.sql` → 1 (in m004) ✓
- `grep 'v3' src/migrations/project/mod.rs` → 4 matches (wired) ✓
- `grep 'UNIQUE (project_id, turn_index)' m001_nl_conversations.sql` → 1 ✓
- `migration_v5_creates_all_tables` test → PASS ✓

**Acceptance criteria results (Task 2):**

- `grep -c "fn upsert_tts_cache" phase3.rs` → 1 ✓
- `grep -c "fn gc_tts_cache_older_than" phase3.rs` → 1 ✓
- `grep -c "pub mod phase3" lib.rs` → 1 ✓
- All 4 round-trip tests (nl roundtrip, tts upsert, session cost, gc with delete_fn) → PASS ✓

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|-----------|-------------|----------|
| T-03-02-01 (Info Disclosure — conversation content) | accepted + flagged | Migration m001 header documents "API keys MUST NEVER be written into content"; token_usage_json carries numeric counters only. Callers inherit Plan 03-01 redaction layer for tracing sinks. |
| T-03-02-02 (Path Traversal — tts_cache_index.file_path) | mitigated | `validate_voiceover_path` in phase3.rs rejects absolute paths, `..` components, and non-`voiceover/` prefixes. Test `upsert_tts_cache_rejects_path_traversal` asserts rejection of 3 attack vectors + acceptance of valid input. |
| T-03-02-03 (DoS — unbounded conversation growth) | mitigated (structural) | `turn_index` INTEGER + `idx_nl_conversations_project` supports cheap pagination. Auto-summarization hook deferred (plan explicit). |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. Every helper has a working implementation; `insert_tts_metric` is a non-stub addition (deviation #4).

## Issues Encountered

None beyond the auto-fixed deviations above. TDD cycle ran clean: RED commit fails to compile (expected, phase3 module doesn't exist); GREEN commit compiles and all 9 new tests + 46 pre-existing tests pass on first attempt after the `UserFunctionError`→`ToSqlConversionFailure` swap.

## User Setup Required

None — pure-Rust crate with no external service dependencies.

## Next Plan Readiness

- **Wave 2 orchestrator** (Plan 03-03+) can call `insert_nl_turn` and `insert_llm_metric` directly against the `&Connection` borrowed from `ProjectDb`. The public export `storage::phase3::{...}` is stable.
- **Wave 3 TTS pipeline** (later plans) has `upsert_tts_cache` / `lookup_tts_cache` / `gc_tts_cache_older_than` ready. Cache key is provider+model+voice_id+script_sha — callers compute the sha256 and pass it as `hash`.
- **Analytics surface** can query `SELECT * FROM session_rollup` for per-session dashboards without joining the base tables.
- No blockers for Wave 2. No known schema gaps.

## Handoff Notes

- All phase3 helpers take `&Connection`, not `&ProjectDb` — this intentionally matches the v2 `repos/` convention so callers who already hold a raw Connection (e.g., actors in `crates/intelligence`) don't have to plumb a ProjectDb through.
- `gc_tts_cache_older_than` requires a closure argument; production callers should pass `|p| std::fs::remove_file(p)`, tests should pass a spy that records paths.
- `session_rollup` view auto-updates on any llm_turn_metrics write — no materialization, no refresh step.

## Self-Check: PASSED

File existence:
- `crates/storage/src/migrations/v3/m001_nl_conversations.sql` → FOUND
- `crates/storage/src/migrations/v3/m002_tts_cache_index.sql` → FOUND
- `crates/storage/src/migrations/v3/m003_llm_turn_metrics.sql` → FOUND
- `crates/storage/src/migrations/v3/m004_tts_clip_metrics.sql` → FOUND
- `crates/storage/src/migrations/v3/mod.rs` → FOUND
- `crates/storage/src/phase3.rs` → FOUND
- `crates/storage/tests/phase3_migration_tests.rs` → FOUND

Commits:
- `35c0b97` (test RED) → FOUND
- `ef6a8d7` (feat GREEN) → FOUND

Verification:
- `cargo test -p storage` → 55/55 passed

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-16*
