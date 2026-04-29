# Phase 24 — E2E Integration Test in CI

**Status:** PROPOSED
**Date drafted:** 2026-04-28
**Depends on:** Phase 20 (cursor render fix), Phase 21 (E2E verification — establishes baseline)
**Blocker level:** 🟢 Quality — prevents regression, doesn't add user-facing feature

## Why this exists

After Phase 20 + 21 land, E2E export works. But there's no automated test that verifies it stays working. Any future change to story-parser, capture pipeline, encoder, effects, or compute-graph could silently break E2E without anyone noticing until release UAT.

This phase wires a synthetic E2E test in CI that catches regressions early.

## Goal

CI runs an E2E test on every PR: synthetic recording → mocked post-prod state → real export → ffprobe-verified MP4 output. Fails the PR if the pipeline breaks.

## Acceptance criteria

1. **AC1** — Test fixture: pre-built 5-second MP4 (or auto-generated) + matching trajectory JSON sidecar, committed to repo.
2. **AC2** — Test harness loads fixture, builds Graph via computeGraph (TS-side, then JSON-serialized), invokes `export_run_inner` (Rust-side) without going through Tauri.
3. **AC3** — Output MP4 is verified via `ffprobe`: correct duration ±100ms, correct resolution (1080p), at least 1 video stream + 0-1 audio streams.
4. **AC4** — Optional: middle-frame pixel comparison with golden image (catches encoder output drift).
5. **AC5** — Test runs on macOS GitHub Actions runner. Skipped on Windows runner (TCC + windows-capture overhead — Phase 25 might adapt).
6. **AC6** — Test runs in < 60 seconds. Runs in CI workflow `.github/workflows/test.yml` (or equivalent).

## Plan breakdown — 2 plans, sequential

### Plan 24-01 — Synthetic test fixture + harness

**Files:**
- NEW `crates/encoder/tests/fixtures/sample-5s-1080p.mp4` — 5-second 1080p test video. Generate via FFmpeg one-off: `ffmpeg -f lavfi -i color=blue:size=1920x1080:duration=5 -c:v libx264 -t 5 sample-5s-1080p.mp4`. Commit binary (Git LFS if size > 1MB).
- NEW `crates/encoder/tests/fixtures/sample-5s-1080p.trajectory.json` — synthetic trajectory: 5 seconds × 60Hz = 300 frames. Cursor moves diagonally across the canvas. 3 evenly-spaced click frames. ~10KB JSON, commit normally.
- NEW `crates/encoder/tests/e2e_export.rs` — integration test:
  - Load fixture MP4 + trajectory.
  - Build Graph in Rust (since this is a Rust integration test): manually construct the equivalent of computeGraph's output. Source node + cursor-overlay node.
  - Call `export_run_inner(req, None, &test_db)` — bypass queue actor for synchronous run. Or expose a helper: `export_run_blocking(graph, output_path)`.
  - Verify output MP4 exists, ffprobe checks pass.

**Tests inside test:**
- Smoke: graph deserialize succeeds.
- Smoke: export completes < 60s.
- Pass: output duration ≈ input duration.
- Pass: output codec is h264.

**Risks:**
- FFmpeg sidecar must be available in CI. Existing CI workflows already use it (capture-soak workflow), so check.
- Encoder requires SQLite DB for queue; either bypass (export_run_inner with None handle) or use `:memory:` DB.

**Estimate:** 1.5-2h.

### Plan 24-02 — Wire into GitHub Actions

**Files:**
- EDIT `.github/workflows/test.yml` (or create `e2e-test.yml`):
  - macOS-latest runner.
  - Steps: checkout, install Rust toolchain, install pnpm + deps, build SEA sidecar, run `cargo test -p encoder --test e2e_export -- --nocapture`.
  - Cache `target/` between runs to keep < 60s.
- EDIT existing CI doc / readme if any to mention new gate.

**Risks:**
- macOS runners are slow (build time can dominate); cache aggressively.
- SEA sidecar build adds ~30s; required by export pipeline.
- TCC / signing may block FFmpeg sidecar exec in CI sandbox; test in throwaway PR first.

**Estimate:** 30 min - 1h.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Test fixture binary bloats repo | Medium | git history bloat | Use Git LFS for fixture MP4 if size > 500KB |
| Test is flaky due to render time variance | Low | flaky CI | Use generous timeout; run synchronously |
| `export_run_inner` API not directly callable from test (depends on Tauri context) | Medium | rework | Plan 24-01 may need to expose a `cargo test`-friendly helper; refactor minimum to enable |
| Pixel-diff golden image flakes on different FFmpeg versions / hw | High if used | flaky CI | Skip pixel-diff initially; only ffprobe checks are robust |

## Out of scope

- Performance regression test (separate phase if needed).
- Frontend E2E (Playwright) for the post-prod editor — too heavy for every PR.
- Cross-platform: Windows + Linux runners. macOS first; expand if test stabilizes.
- Pixel-perfect output diffing — Phase 23-02 already does parity at the effects level.

## Estimated total

- 24-01: 1.5-2h
- 24-02: 30 min - 1h
- **Total: 2-3h**

Sequential. 24-02 depends on 24-01 producing a passing test locally.
