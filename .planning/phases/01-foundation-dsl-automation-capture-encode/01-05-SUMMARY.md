---
phase: 01-foundation-dsl-automation-capture-encode
plan: 05
subsystem: storage
tags: [storage, sqlite, rusqlite, migrations, project-folder, portability]
requirements:
  - FOUND-06
dependency-graph:
  requires:
    - 01-01 (workspace scaffold + storage stub crate)
    - 01-04 (story-parser — used as dev-dep to verify starter-story parses)
  provides:
    - storage::AppDb (global app.sqlite)
    - storage::ProjectDb (per-project project.sqlite)
    - storage::ProjectFolder + create_project / open_project / list_projects
    - storage::bootstrap(app_data_dir) — Tauri host hook
    - storage::StorageError (thiserror, serializable)
    - storage::{Project, NewProject, Session, NewSession, Step, NewStep, StepAttempt, NewAttempt, Export, NewExport, Preset, PresetScope, SessionStatus, StepStatus}
  affects:
    - Plan 03 Tauri host (calls storage::bootstrap in setup())
    - Plan 06 automation (writes Session + Step + StepAttempt rows)
    - Plan 08 encoder (writes Export rows)
    - Plan 09 UI (reads project list + session details via IPC)
tech-stack:
  added:
    - rusqlite 0.34 (feature: bundled, time, uuid)
    - rusqlite_migration 2.0
    - slug 0.1
    - time 0.3
    - tempfile 3 (dev)
  patterns:
    - Two-tier SQLite (D-27): global app.sqlite + per-project project.sqlite
    - Migrations via rusqlite_migration M::up(...) with user_version pragma
    - PRAGMA journal_mode = WAL + foreign_keys = ON on every connection
    - UUID v7 IDs (Uuid::now_v7) for time-ordered, monotonic-per-process index locality
    - thiserror error taxonomy (no anyhow at this layer — anyhow only at Tauri boundary per D-31)
    - Project folder is the portable unit: zip + move + unzip + open just works (D-28)
key-files:
  created:
    - crates/storage/src/lib.rs
    - crates/storage/src/error.rs
    - crates/storage/src/models.rs
    - crates/storage/src/app_db.rs
    - crates/storage/src/project_db.rs
    - crates/storage/src/project_folder.rs
    - crates/storage/src/migrations/mod.rs
    - crates/storage/src/migrations/app/mod.rs
    - crates/storage/src/migrations/app/001_init.sql
    - crates/storage/src/migrations/project/mod.rs
    - crates/storage/src/migrations/project/001_init.sql
    - crates/storage/tests/app_db.rs
    - crates/storage/tests/project_db.rs
    - crates/storage/tests/migrations.rs
    - crates/storage/tests/roundtrip.rs
  modified:
    - crates/storage/Cargo.toml (added rusqlite + rusqlite_migration + slug + dev-deps)
decisions:
  - "rusqlite 0.34 + rusqlite_migration 2.0 (upgraded from plan-spec 0.33/1.3 due to libsqlite3-sys links collision; same API surface)"
  - "UUID v7 over v4 — time-ordered for B-tree index locality on id column"
  - "Folder format version (FOLDER_FORMAT_VERSION='1') stored in .storycapture/version.txt — separate from SQL schema user_version. Two version axes: folder layout vs DB schema."
  - "Starter story file uses 'story \"Name\" { meta {...} scene \"Name\" { pause } }' wrapper to satisfy story-parser grammar"
  - "All export.path / screenshot_path stored as RELATIVE strings — never canonicalized — preserves portability"
metrics:
  duration: ~25 min
  completed_date: 2026-04-14
  tests_passing: 18
  total_tests: 18
---

# Phase 1 Plan 05: Storage Crate Summary

**One-liner:** Two-tier SQLite (global `app.sqlite` + per-project `project.sqlite`) via `rusqlite` + `rusqlite_migration` 2.0, with portable project folders (zip + move + open works), schema-version-mismatch guard, and UUID v7 IDs.

## Schema v1 (frozen)

### `app.sqlite`
- **`projects`** — `id TEXT PK, name TEXT, folder_path TEXT UNIQUE, created_at INTEGER, last_opened_at INTEGER, thumbnail_path TEXT` + `idx_projects_last_opened ON (last_opened_at DESC)`.
- **`app_settings`** — `key TEXT PK, value TEXT, updated_at INTEGER` (upsert via `ON CONFLICT(key) DO UPDATE`).

### `project.sqlite`
- **`sessions`** — `id, story_hash, started_at, ended_at, status, meta_json`. `status ∈ {running, completed, failed, aborted}`.
- **`steps`** — `id, session_id FK→sessions ON DELETE CASCADE, ordinal, command_json, started_at, ended_at, status, error_message`. `status ∈ {running, succeeded, failed, skipped}`. Indexed by `(session_id, ordinal)`.
- **`step_attempts`** — `id, step_id FK→steps ON DELETE CASCADE, selector_strategy, selector_value, attempted_at, outcome, screenshot_path`. Indexed by `step_id`.
- **`exports`** — `id, session_id FK→sessions ON DELETE CASCADE, format, path, size_bytes, duration_ms, created_at`. Indexed by `(session_id, created_at DESC)`.
- **`presets`** — `id, name UNIQUE, scope, config_json, created_at`. Phase 2 extends.

All timestamps are unix-epoch milliseconds (i64). All IDs are UUID v7 strings. All foreign keys enforced (`PRAGMA foreign_keys = ON`). All connections use WAL journal mode.

## Migration File Count

- `app.sqlite`: 1 migration (`001_init.sql`) → `LATEST_VERSION = 1`
- `project.sqlite`: 1 migration (`001_init.sql`) → `LATEST_VERSION = 1`

Adding a new migration is one file + one `M::up(...)` line + bumping `LATEST_VERSION`. The `SchemaVersionMismatch` guard fires BEFORE `to_latest` if the on-disk `user_version` is HIGHER than `LATEST_VERSION` — which means an older build of the app cannot silently corrupt a DB written by a newer build (D-28 requirement).

## Project Folder Layout

```
<slug>/
  project.sqlite
  story.story              # DSL source — parses cleanly through story-parser
  assets/                  # screenshots, thumbnails
  exports/                 # rendered MP4s
  .storycapture/
    version.txt            # "1" — folder format version (separate from DB schema)
```

`AppDb.projects.folder_path` stores an absolute path on the user's current machine — this is the ONLY place absolute paths appear. The folder itself contains zero absolute paths, so zip + move + extract + open is a no-op.

## Portability Test Scope (proven)

- `create_project_produces_full_layout` — every required child exists
- `reopen_project_after_move` — recursive copy to brand-new tempdir, open succeeds, sessions intact
- `zip_move_unzip_roundtrip` — copy to deeply nested location, exports preserved, paths stay relative
- `version_mismatch_rejected` — overwrite `version.txt` with "99" → `InvalidProjectFolder`
- `no_absolute_paths_in_project_db` — relative export path stored is the SAME string read back; never canonicalized
- `starter_story_parses` — cross-crate integration with `story-parser` (zero diagnostics)
- `list_projects_finds_folders` — walk discovers marker; bare dirs without marker are ignored

## Slug Crate Version

`slug = "0.1"` (resolved to 0.1.6). Pure Rust, no transitive deps. Used to derive folder names from project display names. Original (un-slugified) name is stored in `projects.name` for display.

## Platform Path Resolution

The crate does NOT resolve platform-specific paths itself — that's intentional. The Tauri host (Plan 03) uses `app.path().app_data_dir()` and passes it to `storage::bootstrap(app_data_dir)`. From CONTEXT.md D-27:

- **macOS** (this host): `~/Library/Application Support/StoryCapture/app.sqlite` — Tauri `app_data_dir()` returns `~/Library/Application Support/<bundle-id>` on macOS, so `bootstrap(dir).join("app.sqlite")` yields the correct path.
- **Windows**: `%APPDATA%\StoryCapture\app.sqlite` — Tauri `app_data_dir()` returns `%APPDATA%\<bundle-id>` on Windows; same `bootstrap(dir)` call yields the correct path.

This keeps the storage crate platform-agnostic and headless-CLI-friendly (Phase 5).

## Notes for Downstream Plans

### Plan 03 (Tauri host)
Wire in `setup()`:
```rust
let app_data_dir = app.path().app_data_dir().expect("app data dir");
let app_db = storage::bootstrap(&app_data_dir)?;
app.manage(Mutex::new(app_db));
```
Then expose IPC commands `list_projects`, `create_project`, `open_project`, etc. that operate on the managed `AppDb` and per-call `ProjectDb` instances.

### Plan 06 (Automation actor)
Open `ProjectDb` once per recording session. Per step:
1. `append_step(session_id, NewStep { ordinal, command_json })` → `step_id`
2. For each selector attempt: `append_attempt(step_id, NewAttempt { selector_strategy, selector_value, outcome, screenshot_path })`
3. On step completion: `complete_step(step_id, StepStatus::{Succeeded|Failed}, error_message)`
4. On session end: `complete_session(session_id, SessionStatus::{Completed|Failed|Aborted})`

Screenshot paths MUST be relative to the project folder root (e.g., `"assets/step-3-attempt-1.png"`) — never absolute. The crate enforces nothing here; this is a discipline the writers must maintain. The `no_absolute_paths_in_project_db` test guards the contract on the read side.

### Plan 08 (Encoder)
On successful MP4 produce: `insert_export(NewExport { session_id, format: "mp4", path: "exports/<uuid>.mp4", size_bytes, duration_ms })`. Same relative-path discipline.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] rusqlite 0.33 + rusqlite_migration 1.3 caused libsqlite3-sys links collision**
- **Found during:** Task 1 build
- **Issue:** `rusqlite_migration 1.3` requires `rusqlite ^0.32` → `libsqlite3-sys 0.30/0.31`; `rusqlite 0.33` requires `libsqlite3-sys 0.31`. Different patch lines of the same `links = "sqlite3"` package conflict per Cargo's resolver.
- **Fix:** Bumped to `rusqlite = "0.34"` + `rusqlite_migration = "2"`. Public API used in this crate (`Connection`, `Migrations`, `M::up`, `to_latest`, pragmas) is stable across 0.33→0.34 and 1.3→2.0.
- **Files modified:** `crates/storage/Cargo.toml`
- **Commit:** `ad20bd5`

**2. [Rule 1 - Bug] Starter story file failed parser without `story { ... }` wrapper**
- **Found during:** Task 2 `starter_story_parses` test
- **Issue:** Plan's recommended starter content (`meta {...} scene "..." { pause }`) is missing the top-level `story "Name" { ... }` block required by the pest grammar. Parser interpreted the top-level lines as recovery_line tokens and emitted "unknown command" diagnostics for every meta entry.
- **Fix:** Wrapped starter content in `story "<name>" { meta { ... } scene "<name>" { pause } }`. Acceptance criterion `starter_story_parses` now passes with zero diagnostics.
- **Files modified:** `crates/storage/src/project_folder.rs` (`starter_story_content`)
- **Commit:** `0df2fa9`

**3. [Rule 1 - Bug] `insert_and_list_projects` test was nondeterministic**
- **Found during:** Task 1 first test run
- **Issue:** Two `touch_project` calls in the same millisecond produced equal `last_opened_at` values; the `ORDER BY last_opened_at DESC` then has free choice between rows.
- **Fix:** Added a 5ms sleep between touches to guarantee distinct timestamps. The test docstring now calls out the timing requirement.
- **Files modified:** `crates/storage/tests/app_db.rs`
- **Commit:** `ad20bd5`

### Auth Gates

None.

## Self-Check: PASSED

- `crates/storage/src/app_db.rs` — FOUND
- `crates/storage/src/project_db.rs` — FOUND
- `crates/storage/src/project_folder.rs` — FOUND
- `crates/storage/src/error.rs` — FOUND
- `crates/storage/src/models.rs` — FOUND
- `crates/storage/src/migrations/app/001_init.sql` — FOUND
- `crates/storage/src/migrations/project/001_init.sql` — FOUND
- `crates/storage/tests/app_db.rs` — FOUND (4 tests passing)
- `crates/storage/tests/project_db.rs` — FOUND (3 tests passing)
- `crates/storage/tests/migrations.rs` — FOUND (4 tests passing)
- `crates/storage/tests/roundtrip.rs` — FOUND (7 tests passing)
- Commit `ad20bd5` (Task 1) — FOUND
- Commit `0df2fa9` (Task 2) — FOUND
- `cargo tree -p storage | grep -i tauri` — zero matches (purity verified)
