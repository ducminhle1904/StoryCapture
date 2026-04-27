# Phase 18 — Post-Production Review Fixes + Real Video / computeGraph Wiring

**Status:** Code-complete (7 atomic commits, all on local `main`, not pushed)
**Date shipped:** 2026-04-27
**Driver:** Post-production review found 8 gaps; this phase closed 7 of them. Audio curation (#19 placeholder) operator-blocked, deferred.

## Origin

A 4-agent parallel review of post-production code (frontend editor, effects crate, encoder crate, spec coverage vs Phase 02 PRD) surfaced 8 concrete gaps. Five were small/contained ("Wave 1") and two were the long-deferred 02-12b handoffs (real source video + AST graph computation). All seven landed in this single phase.

## Deliverables (7 atomic commits)

| Commit | Subject | Scope |
|---|---|---|
| 51c64b3 | feat(encoder): configurable timeouts + capture-vs-output dim lock metadata | E1 — `EncodeConfig` + `stdin_write_timeout_ms`, `first_frame_timeout_ms` (metadata-only), `capture_dims`. Pipeline emits structured warn + AtomicU64 counter on dim mismatch. |
| 0d4afda | test(effects): preview JSON ↔ FFmpeg filter parity golden test | E2 — new `crates/effects/tests/preview_render_parity.rs` (222 LoC, 35 assertions). ZoomPan-scoped; cursor/text/transition out of scope (no sample-time math). |
| fda4c89 | feat(post-prod): persist export form across modal close + reload | F1 — Zustand persist `version` 1→2 with defensive `merge`. Persists `formats/resolution/fps/quality/outFolder/baseName`. Excludes transient state. |
| cfebc75 | refactor(post-prod): generic add-clip undo action for all 5 tracks | F2 — replaces sound-only `restoreDeletedClip` with generic `add-clip` action that captures `atIndex` for position-faithful restore. +4 parameterized tests. |
| 2cd8e9c | feat(post-prod): clip context menu + preset badge on cursor/zoom/annotations | F3 — new `ClipAffordance` wrapper. Right-click menu (Properties/Delete) + decorative badge. Discovered + wired previously-unused track adapters into `timeline.tsx`. |
| df005d2 | feat(post-prod): wire real recording into preview canvas | P18-A — `EditorShell` reads `useProjectRecordings(storyId)`, prop-drills latest recording path. Loading/empty/error overlays with CTA → `/recorder/<id>`. |
| c7676d5 | feat(post-prod): computeGraph resolver from store state → effects AST JSON | P18-B — new `state/compute-graph.ts` (~280 LoC) + 4 tests. Walks 5 tracks in canonical order, emits `Graph` mirroring Rust AST shape. Replaces `graph_json: ""` placeholder. |

## Verification

- `pnpm typecheck` — ✅ PASS (clean tsc -b --noEmit)
- `cargo check --workspace` — ✅ PASS
- `cargo test -p effects --test preview_render_parity` — ✅ PASS (35 assertions)
- `pnpm vitest run src/features/post-production` — ✅ 78/80 PASS (2 pre-existing GPU/preview-engine fails unrelated)

## Cross-agent compatibility check

F2 and F3 ran in parallel and both touched the undo path. Verified via diff that F3's `pushAction({kind:'delete-clip', trackId, clipId, snapshot, atIndex})` matches F2's new action shape; undo→redo round-trips through generic `add-clip` invert. No conflict.

## Caveat — P18-B is plumbing only

Producer audit (grep) found NO production code writes the metadata field names `compute-graph.ts` reads (`sourcePath`, `trajectoryDir`, `trajectoryFps`, `sizeScale`, `target`, `scale`, `center`, `skin`, `text`, `pos`, `sizePt`, `kind`). The only references are the consumer itself + a UI tooltip hint.

Furthermore, `timeline-slice.ts` exposes only `addSoundClip` as a typed setter — no `addVideoClip` / `addCursorClip` / `addZoomClip` / `addAnnotationClip`. There is no Story → Tracks producer anywhere in the codebase.

**Net effect in production:** `graphAvailable` will always be `false` for end users. Export button stays disabled with tooltip "Add a video clip with a sourcePath to the timeline". P18-B is structurally correct but dead until producers exist.

This is the gap Phase 19 closes.

## Decisions

- **D-1: Frontend computeGraph (TS) over Rust bridge.** Symmetric with where the editor state lives. Refactor to Rust later if headless render needs the same conversion.
- **D-2: Local TS types mirror Rust AST instead of importing `packages/shared-types/src/generated/effects.ts`.** Generated file uses `bigint` for u64; `JSON.stringify` cannot encode BigInt. Drift-guarded via comment + integration risk noted.
- **D-3: Encoder `first_frame_timeout_ms` exposed as field but NOT wired into the loop.** Avoids changing pump semantics ad-hoc. Wire-in is a follow-up phase if/when behavior change is desired.
- **D-4: F3 went slightly beyond scope** — wired the previously-dead track adapters into `timeline.tsx`. Without this, the agent's adapter-only work would have been dead code. Documented in commit body.
- **D-5: Persist version bump 1→2 with no migrate fn.** First load after upgrade resets `timelineHeightPct`/`previewWidthPct` to defaults. Acceptable churn; if zero-loss is required, add `migrate: (s, v) => v === 1 ? s : s`.

## Open follow-ups (handed to Phase 19)

1. **Story → Timeline producer** — populate `tracks` from `.story` script + recording trajectory when user opens `/post-production/<storyId>`.
2. **Typed Clip discriminated union** — replace `Clip.metadata: Record<string, unknown>` with `Clip = VideoClip | CursorClip | ZoomClip | SoundClip | AnnotationClip` so producer + consumer share a schema.
3. **Trajectory recording artifact** — confirm cursor frames are persisted at recording time; if not, add a sidecar JSON.
4. **(Out of P18 scope but noted)** Audio curation (02-08 blocking todo) still operator-gated.
