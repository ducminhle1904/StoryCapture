---
phase: 16
plan: 01
subsystem: dependency-upgrade
tags: [dependency-upgrade, rust, npm, phase-a, safe-bumps]
dependency_graph:
  requires: []
  provides:
    - "Workspace Rust crates at PRD A1 patch/minor targets"
    - "Per-workspace npm manifests at PRD A2 patch/minor targets"
    - "Regenerated Cargo.lock + pnpm-lock.yaml"
  affects:
    - "apps/desktop/src-tauri"
    - "crates/{automation,capture,effects,encoder,intelligence,storage,story-parser,util}"
    - "apps/desktop (frontend)"
    - "apps/web"
    - "packages/ui"
    - "scripts/playwright-sidecar"
tech-stack:
  added: []
  patterns:
    - "Workspace [workspace.dependencies] block pin upgrades propagate to member crates via workspace = true"
    - "Per-package manifest bumps + single pnpm install to regenerate pnpm-lock.yaml atomically"
key-files:
  created: []
  modified:
    - Cargo.toml
    - Cargo.lock
    - apps/desktop/src-tauri/Cargo.toml
    - crates/automation/Cargo.toml
    - crates/capture/Cargo.toml
    - crates/effects/Cargo.toml
    - crates/encoder/Cargo.toml
    - crates/intelligence/Cargo.toml
    - crates/storage/Cargo.toml
    - crates/story-parser/Cargo.toml
    - crates/util/Cargo.toml
    - scripts/notarize/smoke-app/src-tauri/Cargo.toml
    - apps/desktop/package.json
    - apps/web/package.json
    - packages/ui/package.json
    - scripts/playwright-sidecar/package.json
    - pnpm-lock.yaml
decisions:
  - "specta-typescript kept at 0.0.9 — target 0.0.11 demands specta =2.0.0-rc.24 which belongs to Phase E27 coordination group (tauri-specta/specta/specta-typescript atomic)"
  - "rusqlite_migration pinned 2.0.0 instead of plan's 2.5.0 — 2.5.0 requires rusqlite 0.39; rusqlite stays at 0.34 until Phase C6. 2.0.0 is the highest rusqlite_migration release compatible with rusqlite 0.34."
metrics:
  duration_minutes: 18
  completed_date: 2026-04-22
---

# Phase 16 Plan 01: Safe Rust + npm patch/minor bumps Summary

Landed Phase 16 Wave A in two atomic commits: Rust workspace safe bumps (A1) and per-workspace npm safe bumps (A2). Both gates green: `cargo check --workspace --all-targets`, `cargo test --workspace`, `turbo run typecheck`, `turbo run build`, `vitest` on apps/desktop (201/209 — matches pre-bump baseline, 8 pre-existing failures carried forward).

## Commits

- `24f7b31` — chore(16-A1): bump workspace Rust patch/minor deps
- `1eb1542` — chore(16-A2): bump workspace npm patch/minor deps

## What was changed

### A1 — Rust (12 manifests + Cargo.lock)

Workspace root (`Cargo.toml`):
- tokio 1.40 → 1.52
- serde 1 → 1.0.228, serde_json 1 → 1.0.149
- thiserror 2 → 2.0.18, anyhow 1 → 1.0.102
- tracing 0.1 → 0.1.44, tracing-subscriber 0.3 → 0.3.23
- uuid 1 → 1.23.1, parking_lot 0.12 → 0.12.5

`apps/desktop/src-tauri`: tracing-appender 0.2.5, log 0.4.29, keyring 3.6.3, once_cell 1.21.4, async-trait 0.1.89, time 0.3.47, url 2.5.8, base64 0.22.1, hex 0.4.3. Tauri crates + rusqlite + objc2* left untouched (Phase B/C).

`crates/automation`: async-trait 0.1.89, url 2.5.8, tempfile 3.27.0.

`crates/capture`: async-trait 0.1.89, xcap 0.9.4, image 0.25.10, bytemuck 1.25.0, tempfile 3.27.0, core-foundation 0.10.1. Skipped nix / sysinfo / cpal / ringbuf / rubato / screencapturekit / windows / objc2* / core-graphics / objc2-foundation (Phase C/E pins).

`crates/effects`: indexmap 2.14.0, image 0.25.10, rayon 1.12.0, insta 1.47.2 (dev), tempfile 3.27.0 (dev). Skipped rusqlite + ts-rs (Phase C).

`crates/encoder`: async-trait 0.1.89, tokio-util 0.7.18, bytes 1.11.1, futures 0.3.32, tempfile 3.27.0, libc 0.2.185, insta 1.47.2 (dev), image 0.25.10 (dev). Skipped rusqlite + objc2* (Phase C).

`crates/intelligence`: eventsource-stream 0.2.3, bytes 1.11.1, tokio 1.52, tokio-stream 0.1.18, futures-util 0.3.32, async-trait 0.1.89, serde 1.0.228, serde_json 1.0.149, tower-lsp 0.20.0, dashmap 6.1.0, ropey 1.6.1, thiserror 2.0.18, anyhow 1.0.102, tracing 0.1.44, tracing-subscriber 0.3.23, regex 1.12.3, uuid 1.23.1, hex 0.4.3, symphonia 0.5.5, httpdate 1.0.3, insta 1.47.2 (dev), tempfile 3.27.0 (dev), wiremock 0.6.5 (dev). Skipped reqwest / sha2 / schemars / tower / rand / toml / serde_yaml (Phase C).

`crates/storage`: rusqlite_migration 2.0.0 (deviation — see below), time 0.3.47, slug 0.1.6, tempfile 3.27.0 (dev).

`crates/story-parser`: pest 2.8.6, pest_derive 2.8.6 (lockstep), strsim 0.11.1, uuid 1.23.1, insta 1.47.2 (dev), proptest 1.11.0 (dev).

`crates/util`: hex 0.4.3.

`scripts/notarize/smoke-app/src-tauri`: serde 1.0.228, serde_json 1.0.149.

### A2 — npm (5 manifests + pnpm-lock.yaml)

`apps/desktop`:
- @fontsource-variable/{inter,jetbrains-mono} 5.2.8
- @tanstack/react-query{,-devtools} 5.99.2 (lockstep)
- cmdk 1.1.1, motion 12.38.0, react{,-dom} 19.2.5, zustand 5.0.12
- @tailwindcss/vite 4.2.4, tailwindcss 4.2.4, @types/react 19.2.14, @types/react-dom 19.2.3
- @vitest/ui 4.1.5, vitest 4.1.5

`apps/web`:
- react{,-dom} 19.2.5, @tanstack/react-query 5.99.2 (matches desktop)
- @auth/prisma-adapter 2.11.2, superjson 2.2.6
- @aws-sdk/client-s3 3.1033.0, @aws-sdk/s3-request-presigner 3.1033.0 (lockstep)
- @maxmind/geoip2-node 6.3.4, tailwindcss 4.2.4, @tailwindcss/postcss 4.2.4
- @types/react 19.2.14, @types/react-dom 19.2.3, tsx 4.21.0

`packages/ui`: react{,-dom} peer + dev 19.2.5, @types/react 19.2.14, @types/react-dom 19.2.3, vitest 4.1.5.

`scripts/playwright-sidecar`: playwright-core 1.59.1.

`packages/shared-types` + `scripts/notarize/smoke-app`: no change (only `@tauri-apps/*` in scope — deferred to Phase B).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking dep resolver conflict] `specta-typescript` left at 0.0.9**
- **Found during:** Task A1 cargo check
- **Issue:** `specta-typescript = "0.0.11"` (plan target) requires `specta =2.0.0-rc.24`, but workspace pins `specta =2.0.0-rc.22`. The Cargo resolver aborted with "failed to select a version for `specta`".
- **Fix:** Reverted `specta-typescript` to `0.0.9`. Per PRD Coordination Group #11 (tauri-specta + specta + specta-typescript + story-parser specta feature), these three crates are atomic and must move together in Phase E27 — A1's isolated `specta-typescript` bump was an oversight in the plan.
- **Files modified:** `apps/desktop/src-tauri/Cargo.toml`
- **Commit:** `24f7b31`

**2. [Rule 3 - Blocking dep resolver conflict] `rusqlite_migration` pinned 2.0.0 instead of 2.5.0**
- **Found during:** Task A1 cargo check
- **Issue:** `rusqlite_migration = "2.5.0"` (plan target) has `rusqlite = "^0.39.0"` requirement, but the workspace still pins `rusqlite = "0.34"` (deferred to Phase C6). Resolver reported duplicate `links = "sqlite3"` native library conflict.
- **Fix:** Pinned `rusqlite_migration = "2.0.0"` — the highest 2.x release whose dependency requirement (`rusqlite = "^0.34.0"`) is compatible with the current rusqlite 0.34 pin. When Phase C6 bumps rusqlite to 0.39, the matching `rusqlite_migration = "2.5.0"` can move with it.
- **Files modified:** `crates/storage/Cargo.toml`
- **Commit:** `24f7b31`
- **Note:** 16-RESEARCH.md Pitfall 1 flagged assumption A12 ("rusqlite_migration 2.5.x supports rusqlite 0.39") as a compat check — that compat holds for 2.5 ↔ 0.39 as expected, but 2.5 is explicitly incompatible with 0.34. The plan's A1 target of 2.5.0 conflicted with its own "SKIP rusqlite (Phase C)" constraint.

### No other deviations

All other bumps landed at exactly the PRD target versions. No workarounds used. No `#[allow(deprecated)]`, no `@ts-ignore`, no `--no-verify`. No Tauri, rusqlite, objc2*, or other Phase B/C/D/E crate was touched.

## Verification Run

### A1 gate
```
cargo check --workspace --all-targets   → exit 0
cargo test --workspace --no-fail-fast   → 89/89 test suites PASS (0 failed)
```
(cargo-nextest not installed locally; fell back to cargo test per plan guidance and CLAUDE.md tooling list.)

### A2 gate
```
pnpm install                            → exit 0 (resolved 734, +90 -32)
pnpm -w turbo run typecheck             → 4/4 tasks PASS
pnpm -w turbo run build                 → 2/2 tasks PASS
cd apps/desktop && pnpm exec vitest run → 201/209 PASS (8 pre-existing fails carried forward — matches STATE.md 15-04 baseline)
```

Note: `apps/web` has no `test` script, so `turbo run test --filter=web` is a no-op (explicit — not skipped). Web companion validation is covered by `turbo run build --filter=web` (full Next.js build exercising tRPC + Prisma).

## Acceptance Criteria

- [x] `grep 'tokio = { version = "1.52"' Cargo.toml` — present
- [x] `grep 'thiserror = "2.0.18"' Cargo.toml` — present
- [x] `grep 'pest = "2.8.6"' crates/story-parser/Cargo.toml` — present
- [x] No tauri* Rust crate modified in A1 diff (verified via `git show 24f7b31 -- apps/desktop/src-tauri/Cargo.toml`)
- [x] `cargo check --workspace --all-targets` exits 0
- [x] `cargo test --workspace` exits 0 (fallback for nextest)
- [x] `chore(16-A1): …` commit landed with Cargo.lock in diff
- [x] `grep '"@tanstack/react-query": "\^5.99.2"'` present in both apps/desktop + apps/web package.json
- [x] `grep '"playwright-core": "\^1.59.1"'` in scripts/playwright-sidecar/package.json
- [x] `grep '"motion": "\^12.38.0"'` in apps/desktop/package.json
- [x] `pnpm install` exits 0 with pnpm-lock.yaml regenerated
- [x] `turbo run typecheck` exits 0
- [x] `turbo run build` exits 0
- [x] `pnpm --filter @storycapture/desktop vitest run` matches 201/209 pre-bump baseline (no new failures)
- [x] `chore(16-A2): …` commit landed with pnpm-lock.yaml in diff

## Known Stubs

None introduced by this plan.

## Deferred Items

None from this plan. Items intentionally not bumped are all documented under Phase B/C/D/E in `16-CONTEXT.md`.

## Self-Check

Files created/modified (verification):
- Cargo.toml — modified, present, contains `tokio = { version = "1.52"` (line 26)
- apps/desktop/src-tauri/Cargo.toml — modified, present, `specta-typescript = "0.0.9"` (deviation preserved)
- crates/storage/Cargo.toml — modified, present, `rusqlite_migration = "2.0.0"` (deviation preserved)
- pnpm-lock.yaml — regenerated, present
- Cargo.lock — regenerated, present

Commits verified in `git log --oneline`:
- 24f7b31 chore(16-A1): bump workspace Rust patch/minor deps
- 1eb1542 chore(16-A2): bump workspace npm patch/minor deps

## Self-Check: PASSED
