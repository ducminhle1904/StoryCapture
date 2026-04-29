# Phase 21 — E2E Export Verification

**Status:** PROPOSED
**Date drafted:** 2026-04-28
**Depends on:** Phase 20 (cursor render fix)
**Blocker level:** 🔴 CRITICAL — no one has run a real E2E export yet with populated graph

## Why this exists

Phase 18-B `export_run` IPC path is wired (`commands/export.rs:210` deserializes `effects::Graph` from `graph_json`), and Phase 19-03 populates the graph at session entry. But **no human or automated test has executed an E2E export with a populated graph from a real recording**. Phase 18-B's caveat ("plumbing only, graph empty in prod") meant the export path was never exercised against real data.

Likely failure modes (unknown until run):
- `serde_json::from_str::<effects::Graph>` chokes on snake_case ↔ camelCase mismatch we missed.
- Source video path is relative when Tauri sandbox needs absolute, or vice versa.
- BigInt-as-number serialize hits a u64 overflow we didn't anticipate.
- Cursor overlay (after Phase 20) has skin-asset path resolution differences in packaged vs. dev builds.
- Encoder spawns but FFmpeg arg list has shell-quoting issue we never noticed.
- Render queue progress channel desyncs when graph has multiple nodes.

This phase doesn't add features — it surfaces bugs.

## Goal

Confirm that recording → open post-prod → click Export produces a valid MP4 on operator hardware. Document and fix every blocker that surfaces.

## Acceptance criteria

1. **AC1** — Operator records a 30-second sample browser-automation story. Opens `/post-production/<storyId>`. Timeline auto-populates (1 video clip + 1 cursor clip).
2. **AC2** — Operator clicks Export. Modal submits without TS-side error. Render queue shows the job.
3. **AC3** — Render completes within reasonable time (~30s for 30s input @ 1080p60). Output MP4 exists, plays in QuickTime + VLC, has expected duration ±100ms and resolution.
4. **AC4** — Output MP4 has cursor overlay visible at trajectory positions (after Phase 20).
5. **AC5** — Re-running with different formats (WebM, GIF) succeeds.
6. **AC6** — Every bug surfaced is either fixed in this phase OR documented in a `21-DEFERRED.md` artifact for a follow-up phase.

## Plan breakdown — 2 plans

### Plan 21-01 — Operator E2E walkthrough

**Type:** Operator-driven, no code work upfront.

**Walkthrough script:**
1. Pull latest main, run `pnpm install` + `pnpm tauri:dev`.
2. Record a 30s story. Use existing sample DSL or write a fresh one with 3-5 Click commands on a public site (e.g. wikipedia.org search flow).
3. Stop recording. Verify `<exports_dir>/<basename>.mp4` and `<basename>.trajectory.json` both exist.
4. Navigate to `/post-production/<storyId>` (or click "Send to Post-Production" from editor).
5. Verify timeline shows 1 video clip + 1 cursor clip auto-populated.
6. Verify preview canvas shows the recording when scrubbing.
7. Click Export. Choose MP4 + 1080p + medium quality. Confirm.
8. Watch render queue widget. Note any error toast.
9. When complete, open output MP4 in QuickTime. Verify cursor is visibly overlaid.
10. Repeat steps 7-9 with WebM and GIF outputs.

**Capture for each step:** screenshot + console log (browser devtools) + Tauri stdout/stderr if visible.

**Output artifact:** `phases/21-e2e-export-verification/21-WALKTHROUGH-LOG.md` — chronological log of what happened, including any bugs surfaced.

**Estimate:** 30-45 min operator time + setup.

### Plan 21-02 — Bug fix sweep

**Type:** Code work driven by 21-01's findings.

**Approach:** For each bug in `21-WALKTHROUGH-LOG.md`:
1. Triage severity (BLOCKER / WARNING / DEFERRED).
2. BLOCKERs ship in this phase — root-cause fix, atomic commit.
3. WARNINGs → judgment call: fix now if quick, defer if architectural.
4. DEFERREDs → write into `21-DEFERRED.md` with proposed phase.

**Likely fixes (anticipated, may not all surface):**
- Field-name camelCase ↔ snake_case fix in `compute-graph.ts` if Rust deserialize fails. Should be no-op since Phase 18-B already emits snake_case, but verify.
- Skin-asset path resolution in packaged build (different from dev) — may need `tauri::path::resolve_resource` instead of `CARGO_MANIFEST_DIR`.
- FFmpeg shell-quoting on Windows for paths with spaces.
- Tmp dir cleanup ordering (Phase 20-03's drop guard) racing with FFmpeg holding file handles on Windows.

**Tests:** for each fix, a regression test in the appropriate suite. Atomic commits.

**Estimate:** Highly variable. ~30 min if no bugs. ~3h if multiple. Plan budget: 2h, escalate if exceeded.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bugs are architectural, not surface | Medium | scope creep | If a fix needs > 1h, stop and defer to a new phase |
| FFmpeg sidecar missing on operator machine | Low | walkthrough blocked | Verify `pnpm tauri:dev` runs SEA build (CLAUDE.md gotcha) |
| Recording artifact lifecycle issue (e.g. mp4 still being finalized when post-prod opens) | Medium | flaky test | Document, defer to Phase 25 polish |
| Sandbox / TCC blocks file access on macOS | Medium | walkthrough blocked | Document required permissions; defer signing fix to release prep |

## Out of scope

- Performance benchmarking (deferred to dedicated phase).
- Multi-recording timeline support.
- Export result UI (preview the rendered video) — current toast.success is acceptable.
- Re-running 02-12b 5-step UAT — that's a separate operator gate.

## Estimated total

- 21-01: 45 min operator time + 15 min capture/log
- 21-02: 0-3h depending on bugs

**Total: ~1-3.5h, mostly operator-driven. Code work scope reactive.**
