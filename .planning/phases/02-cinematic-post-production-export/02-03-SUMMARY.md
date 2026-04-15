---
phase: 02-cinematic-post-production-export
plan: 03
subsystem: storage
tags: [storage, sqlite, migrations, presets, scpreset, rusqlite-migration, render-queue, sound-library]
requirements:
  - POST-09
dependency-graph:
  requires:
    - Phase 1 Plan 05 (storage crate v1, ProjectDb + AppDb + migrations infra)
  provides:
    - storage::repos::preset_repo (install_bundled / CRUD)
    - storage::repos::render_job_repo (D-04 queue semantics)
    - storage::repos::timeline_repo
    - storage::repos::sound_library_repo (manifest sync)
    - storage::{EffectPreset, NewEffectPreset, PresetTier, RenderJob, NewRenderJob, RenderJobStatus, EffectSettings, TimelineState, SoundLibraryEntry, SoundCategory}
    - storage::{export_preset, import_preset, migrate_preset_v1_to_v2, ScpresetFile, ScpresetMetadata, CURRENT_SCPRESET_VERSION, MAX_SCPRESET_BYTES}
    - assets/preset-defaults/{linear,runway,tella,loom,plain}.scpreset (5 bundled defaults)
    - project.sqlite schema v6 (v1 + 5 v2 tables)
    - app.sqlite schema v2 (v1 + effect_presets mirror)
  affects:
    - Plan 10 (render queue) — poll_ready / mark_* / on_startup_mark_orphans
    - Plan 12 (editor UI) — preset picker + timeline persistence
    - Plan 08 (sound library) — sync_from_manifest consumes its manifest.json
    - Plan 03 Tauri host — should call on_startup_mark_orphans + install_bundled during setup()
tech-stack:
  added: []
  patterns:
    - "v2 migrations registered as separate M::up(...) files, appended to v1 Vec<M>; LATEST_VERSION bumped per tier"
    - ".scpreset stable embedded id enables idempotent INSERT OR IGNORE on bundled install"
    - "D-04 render queue ORDER BY priority DESC, created_at ASC with status='pending' poll filter"
    - "story_id columns are opaque TEXT (no FK) — no stories table exists in v1; constraint deferred"
key-files:
  created:
    - crates/storage/src/migrations/v2/mod.rs
    - crates/storage/src/migrations/v2/m001_timeline_state.sql
    - crates/storage/src/migrations/v2/m002_effect_presets.sql
    - crates/storage/src/migrations/v2/m003_effect_settings.sql
    - crates/storage/src/migrations/v2/m004_render_jobs.sql
    - crates/storage/src/migrations/v2/m005_sound_library_index.sql
    - crates/storage/src/models/mod.rs
    - crates/storage/src/models/timeline_state.rs
    - crates/storage/src/models/effect_preset.rs
    - crates/storage/src/models/effect_settings.rs
    - crates/storage/src/models/render_job.rs
    - crates/storage/src/models/sound_library_entry.rs
    - crates/storage/src/repos/mod.rs
    - crates/storage/src/repos/preset_repo.rs
    - crates/storage/src/repos/timeline_repo.rs
    - crates/storage/src/repos/render_job_repo.rs
    - crates/storage/src/repos/sound_library_repo.rs
    - crates/storage/src/preset_io.rs
    - crates/storage/tests/migrations_v2.rs
    - crates/storage/tests/preset_roundtrip.rs
    - assets/preset-defaults/linear.scpreset
    - assets/preset-defaults/runway.scpreset
    - assets/preset-defaults/tella.scpreset
    - assets/preset-defaults/loom.scpreset
    - assets/preset-defaults/plain.scpreset
    - assets/preset-defaults/README.md
  modified:
    - crates/storage/src/lib.rs
    - crates/storage/src/migrations/mod.rs
    - crates/storage/src/migrations/project/mod.rs
    - crates/storage/src/migrations/app/mod.rs
    - crates/storage/tests/app_db.rs (schema_version baseline bumped 1 -> 2)
    - crates/storage/tests/migrations.rs (schema_version baselines bumped)
  renamed:
    - crates/storage/src/models.rs -> crates/storage/src/models/mod.rs
decisions:
  - "story_id columns use TEXT without FK — no `stories` table exists in v1. Adding a real FK is deferred to the migration that introduces the stories table. Callers pass whatever id (session id / UUID string) they prefer."
  - "Preset ast stored as opaque `ast_json: String` — storage crate stays decoupled from `crates/effects`. Typed deserialization happens at the caller's boundary."
  - "Error taxonomy: preset-specific errors (invalid kind, too-new version, unsupported v1, oversized file) fold into StorageError::Serialization with descriptive messages rather than new enum variants. Avoids a breaking change to StorageError while keeping the plan's intent (each error is checkable by message)."
  - "MAX_SCPRESET_BYTES = 5 MiB — enforced before JSON parse (T-02-07 DoS mitigation)."
  - "NewEffectPreset carries an optional `id` so bundled presets can supply stable UUIDs; user-exported presets usually omit it (UUID v7 generated)."
metrics:
  duration: ~45 minutes
  completed_date: 2026-04-15
  task_count: 3
  test_count: 42
  file_count: 26
---

# Phase 2 Plan 03: Storage v2 migrations + `.scpreset` I/O + 5 bundled defaults

**One-liner:** Extend `crates/storage` from Phase 1 schema v1 to v6 with five new tables (timeline_state, effect_presets, effect_settings, render_jobs, sound_library_index), typed models + repositories (including D-04 render-queue lifecycle: priority poll, resume-on-startup, cancel gating), and a schema-versioned `.scpreset` JSON file format with five bundled default presets (Linear / Runway / Tella / Loom / Plain) installed idempotently via stable UUIDs.

## Schema v2 delivered

### project.sqlite (v1 → v6)

| Table                | Key columns                                                                                                              | Indexes |
|----------------------|--------------------------------------------------------------------------------------------------------------------------|---------|
| `timeline_state`     | `story_id TEXT PK, layout_json TEXT, last_modified INTEGER`                                                              | — |
| `effect_presets`     | `id TEXT PK, scope CHECK∈(project,global), name, description, ast_json, version, bundled, created_at, author, tags_json` | `idx_effect_presets_scope` |
| `effect_settings`    | `story_id TEXT PK, preset_id → effect_presets(id) ON DELETE SET NULL, overrides_json, last_modified`                      | — |
| `render_jobs`        | D-04: `id, story_id, preset_id, format∈(mp4,webm,gif), resolution∈(720p,1080p,4k), fps∈(24,30,60), quality∈(low,med,high), status∈(pending,running,completed,failed,cancelled,interrupted), progress_pct, started_at, completed_at, error, priority, output_path, batch_id, created_at` | `idx_render_jobs_status`, `idx_render_jobs_priority (priority DESC, created_at ASC)`, `idx_render_jobs_batch` |
| `sound_library_index`| `id, category∈(sfx,bgm), name, file_path, duration_ms, waveform_peaks BLOB, license, source_url, author, bundled`        | `idx_sound_library_category` |

### app.sqlite (v1 → v2)

- Adds `effect_presets` with the exact same schema (global-scope mirror).
- `LATEST_VERSION = 2`.

## Repository function signatures (for downstream plan reference)

```rust
// preset_repo (tier-agnostic; works on either project.sqlite or app.sqlite)
pub fn list_by_scope(conn: &Connection, scope: PresetTier) -> Result<Vec<EffectPreset>, StorageError>;
pub fn get(conn: &Connection, id: Uuid) -> Result<Option<EffectPreset>, StorageError>;
pub fn insert(conn: &Connection, p: &NewEffectPreset) -> Result<Uuid, StorageError>;
pub fn update(conn: &Connection, p: &EffectPreset) -> Result<(), StorageError>;
pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError>;
pub fn install_bundled(conn: &Connection, scope: PresetTier, bundled_dir: &Path) -> Result<usize, StorageError>;

// render_job_repo (D-04 queue)
pub fn enqueue(conn: &Connection, j: &NewRenderJob) -> Result<Uuid, StorageError>;
pub fn poll_ready(conn: &Connection, limit: u32) -> Result<Vec<RenderJob>, StorageError>; // ORDER BY priority DESC, created_at ASC
pub fn get(conn: &Connection, id: Uuid) -> Result<Option<RenderJob>, StorageError>;
pub fn mark_running(conn: &Connection, id: Uuid) -> Result<(), StorageError>;          // only if pending
pub fn update_progress(conn: &Connection, id: Uuid, pct: f32) -> Result<(), StorageError>;
pub fn mark_completed(conn: &Connection, id: Uuid, output_path: &Path) -> Result<(), StorageError>;
pub fn mark_failed(conn: &Connection, id: Uuid, error: &str) -> Result<(), StorageError>;
pub fn cancel(conn: &Connection, id: Uuid) -> Result<(), StorageError>;                // only if pending or running
pub fn on_startup_mark_orphans(conn: &Connection) -> Result<u32, StorageError>;        // running -> interrupted
pub fn list_active(conn: &Connection, story_id: &str) -> Result<Vec<RenderJob>, StorageError>;
pub fn list_by_batch(conn: &Connection, batch_id: &str) -> Result<Vec<RenderJob>, StorageError>;

// timeline_repo
pub fn load(conn: &Connection, story_id: &str) -> Result<Option<TimelineState>, StorageError>;
pub fn save(conn: &Connection, story_id: &str, layout_json: &str) -> Result<(), StorageError>;  // UPSERT
pub fn delete(conn: &Connection, story_id: &str) -> Result<(), StorageError>;

// sound_library_repo
pub fn list_by_category(conn: &Connection, category: SoundCategory) -> Result<Vec<SoundLibraryEntry>, StorageError>;
pub fn list_all(conn: &Connection) -> Result<Vec<SoundLibraryEntry>, StorageError>;
pub fn sync_from_manifest(conn: &Connection, manifest_path: &Path) -> Result<usize, StorageError>;
```

## `.scpreset` file layout (v2)

```jsonc
{
  "id": "<uuid, optional>",
  "version": 2,
  "kind": "effect_preset",
  "name": "...",
  "description": "...",
  "bundled": true,
  "ast": { "schema_version": 2, "output_width": 1920, "output_height": 1080,
           "output_fps": 60, "video": [ ... ], "audio": [ ... ] },
  "metadata": { "author": "StoryCapture", "created_at": 1744761600000, "tags": [...] }
}
```

Guardrails:
- **Kind check** — any value other than `"effect_preset"` is rejected.
- **Version check** — values above `CURRENT_SCPRESET_VERSION` (=2) return a descriptive error prompting the user to upgrade the app.
- **Size cap** — files above `MAX_SCPRESET_BYTES` (5 MiB) are rejected before JSON parsing (T-02-07 DoS mitigation).
- **v1 migration stub** — `migrate_preset_v1_to_v2` always returns `unsupported v1` (v1 never shipped; the seam is kept for symmetry with future v2→v3).

## Bundled preset inventory (stable UUIDs)

| File | id | Name | Auto-zoom | Max | Dwell | Background | Cursor / Audio |
|------|----|------|-----------|-----|-------|------------|----------------|
| `linear.scpreset`  | `…7001-8000-…001` | Linear           | subtle pan-only | 1.0x | 1200ms | Solid white                 | — |
| `runway.scpreset`  | `…7001-8000-…002` | Runway Cinematic | dynamic         | 3.0x | 500ms  | Gradient runway-dark (135°) | ripple white α≈0.95, max_r 80px |
| `tella.scpreset`   | `…7001-8000-…003` | Tella            | calm            | 2.2x | 800ms  | Gradient tella-warm (180°)  | BGM default.mp3 @ −14 dB |
| `loom.scpreset`    | `…7001-8000-…004` | Loom             | subtle          | 1.4x | 1000ms | Solid #f8f9fb               | click-subtle.wav + BGM @ −18 dB |
| `plain.scpreset`   | `…7001-8000-…005` | Plain            | —               | 1.0x | —      | —                           | — |

Because each file embeds a stable `id`, `preset_repo::install_bundled` is idempotent: the first run returns 5, every subsequent run returns 0.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking] `story_id` FK target does not exist in v1**
- **Found during:** Task 1 design
- **Issue:** Plan specifies `story_id TEXT REFERENCES stories(id) ON DELETE CASCADE`, but Phase 1 v1 has no `stories` table (only `sessions`, which represent recording runs). Emitting the FK would make migrations fail on any new project.sqlite.
- **Fix:** Store `story_id` as opaque `TEXT` without a FK in `timeline_state`, `effect_settings`, and `render_jobs`. Callers pass whatever id (session UUID, future stories.id) they want. A follow-up migration will add the FK once `stories` is introduced.
- **Files modified:** `crates/storage/src/migrations/v2/m001_timeline_state.sql`, `m003_effect_settings.sql`, `m004_render_jobs.sql`.
- **Commit:** `c4a196b`

**2. [Rule 3 - Blocking] Phase 1 tests hard-coded `schema_version == 1`**
- **Found during:** Task 1 verification (first full `cargo test -p storage` after migration wiring)
- **Issue:** `tests/app_db.rs::open_creates_db_if_missing`, `tests/migrations.rs::fresh_db_runs_to_latest`, `idempotent_rerun`, and `downgrade_detected_app` all asserted `schema_version == 1`. After the v2 bump (project → 6, app → 2) they fail.
- **Fix:** Rebased each assertion to the new `LATEST_VERSION` values with a comment explaining the bump. No test semantics were changed — the v1-specific assertions remain valid (`version_mismatch_rejected` still uses 42/99 as "higher than supported").
- **Files modified:** `crates/storage/tests/app_db.rs`, `crates/storage/tests/migrations.rs`.
- **Commit:** `c4a196b`

**3. [Rule 2 - Missing] `.scpreset` size-guard (T-02-07)**
- Plan's `<threat_model>` explicitly marks T-02-07 as `mitigate`; implemented as a pre-parse size check (`MAX_SCPRESET_BYTES = 5 MiB`) in `preset_io::import_preset`, covered by `size_guard_rejects_huge_files` test.

**4. [Rule 1 - Design] Preset errors without new StorageError variants**
- Plan sketched `StorageError::InvalidPresetKind(..)`, `::PresetTooNew { .. }`, `::UnsupportedPresetVersion(..)`. Adding variants is a breaking change to the error enum (affects Phase 1 IPC surface). Folded these into `StorageError::Serialization(msg)` with distinctive message prefixes (`"invalid .scpreset kind"`, `"newer than supported"`, `".scpreset v1 is not a shipped format"`). Tests match on message substrings. If downstream code needs structured discriminators, adding them later is additive.

### Minor scope-internal choices

- `NewEffectPreset::id` is `Option<Uuid>` so bundled presets can supply stable ids; user-exported presets typically get a fresh `Uuid::now_v7()`.
- `repos/` modules take `&rusqlite::Connection` (not `&ProjectDb`/`&AppDb`) so preset_repo works tier-agnostically; Plan 10/12 wire these through their own DB handles.
- Renamed `crates/storage/src/models.rs` into a `models/` directory to host the v2 submodules. Public re-exports preserved; downstream `use storage::{Session, ...}` still works.

### Auth gates

None.

## Test Coverage Summary

| Test target                                      | Count | Notes |
|--------------------------------------------------|------:|-------|
| `--lib` (repos + preset_io unit tests)           | 13    | Priority poll ordering, orphan detection, cancel gating, lifecycle, preset CRUD, manifest sync, preset error cases |
| `tests/migrations_v2.rs`                         | 5     | Fresh project → v6, fresh app → v2, v1 fixture upgrade preserves data, idempotent re-open, public API reaches v6 |
| `tests/preset_roundtrip.rs`                      | 6     | All 5 bundled files parse, export/import round-trip, invalid kind / too-new version rejected, install_bundled idempotent, size guard |
| `tests/app_db.rs`                                | 4     | (Phase 1 tests, rebased to v2 app schema) |
| `tests/project_db.rs`                            | 3     | (Phase 1 tests, unchanged — still pass) |
| `tests/migrations.rs`                            | 4     | (Phase 1 tests, rebased to v6 / v2) |
| `tests/roundtrip.rs`                             | 7     | (Phase 1 portability tests, unchanged) |
| **Total**                                        | **42**| `cargo test -p storage` exits 0 |

## Verification

- `cargo build -p storage`: passing, zero warnings.
- `cargo check -p storage`: passing.
- `cargo test -p storage`: 42/42 green.
- JSON validity: all 5 `.scpreset` files parse cleanly via `python3 -c "import json; json.load(open(...))"`.
- Opening a fresh `project.sqlite` leaves `user_version = 6`; a fresh `app.sqlite` leaves `user_version = 2`.
- A v1 fixture project.sqlite (seeded with a `sessions` row) upgrades to v6 with the seed row intact — backward-compat confirmed.

## Known Stubs

- **`migrate_preset_v1_to_v2` always errors.** Intentional — v1 never shipped; this is the migration seam for future v2 → v3 work.
- **Bundled AST bodies are representative, not canonical effect-graph emitted by Plan 01.** Each `ast` object carries the shape downstream plans will fill in (ZoomPan `preset`, `max_zoom`, `dwell_ms`, `easing`; Background Solid/Gradient; RippleOverlay; AudioSource `role`). Plan 05 (auto-zoom) and Plan 09 (ripples) will refine the exact node schemas if they diverge from this sketch — at which point these 5 JSON files may need a field tweak and a version bump.
- **`sound_library_repo::sync_from_manifest`** expects `assets/sound-library/manifest.json` produced by Plan 08; this plan does not ship the actual audio files.

## Self-Check: PASSED

File existence:
- `crates/storage/src/migrations/v2/m001_timeline_state.sql` → FOUND
- `crates/storage/src/migrations/v2/m002_effect_presets.sql` → FOUND
- `crates/storage/src/migrations/v2/m003_effect_settings.sql` → FOUND
- `crates/storage/src/migrations/v2/m004_render_jobs.sql` → FOUND
- `crates/storage/src/migrations/v2/m005_sound_library_index.sql` → FOUND
- `crates/storage/src/migrations/v2/mod.rs` → FOUND
- `crates/storage/src/models/{mod,timeline_state,effect_preset,effect_settings,render_job,sound_library_entry}.rs` → FOUND
- `crates/storage/src/repos/{mod,preset_repo,timeline_repo,render_job_repo,sound_library_repo}.rs` → FOUND
- `crates/storage/src/preset_io.rs` → FOUND
- `crates/storage/tests/migrations_v2.rs` → FOUND
- `crates/storage/tests/preset_roundtrip.rs` → FOUND
- `assets/preset-defaults/{linear,runway,tella,loom,plain}.scpreset` → FOUND (5/5)
- `assets/preset-defaults/README.md` → FOUND

Commits:
- `c4a196b` (Task 1 — v2 migrations) → FOUND
- `c3fb66e` (Task 2 — models + repos + preset_io) → FOUND
- `084c865` (Task 3 — bundled presets + roundtrip tests) → FOUND
