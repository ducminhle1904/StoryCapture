---
phase: 16
plan: 02
subsystem: dependency-upgrade
tags: [dependency-upgrade, tauri-group, vitest, phase-b]
dependency_graph:
  requires: ["16-01"]
  provides:
    - "Rust tauri* crates at 2.10.x exact pins"
    - "JS @tauri-apps/* packages at 2.x latest"
    - "Playwright sidecar vitest unified at 4.1.5"
  affects:
    - "apps/desktop/src-tauri"
    - "apps/desktop"
    - "packages/shared-types"
    - "scripts/notarize/smoke-app"
    - "scripts/playwright-sidecar"
tech-stack:
  added: []
  patterns:
    - "Tauri Rust↔JS lockstep: Rust crate minor aligned to JS plugin minor (e.g., tauri-plugin-updater 2.10.1 ↔ @tauri-apps/plugin-updater 2.10.1)"
    - "Single atomic commit per coordinated group (B3 = Tauri lockstep, B4 = sidecar vitest)"
key-files:
  created:
    - .planning/phases/16-upgrade-all-dependencies-to-latest-bump-every-js-ts-package-/16-02-SUMMARY.md
  modified:
    - apps/desktop/src-tauri/Cargo.toml
    - scripts/notarize/smoke-app/src-tauri/Cargo.toml
    - apps/desktop/package.json
    - packages/shared-types/package.json
    - scripts/notarize/smoke-app/package.json
    - scripts/playwright-sidecar/package.json
    - pnpm-lock.yaml
decisions:
  - "Cargo.lock unchanged by B3 — resolver had already locked tauri 2.10.3 / tauri-build 2.5.6 / tauri-plugin-updater 2.10.1 in the lockfile prior to this plan; Cargo.toml pin change is a SemVer tighten, not a resolve step. Verified via grep in Cargo.lock post-bump."
  - "playwright-sidecar vitest 2→4 required zero source-side test migration: 60/60 tests pass verbatim on Vitest 4.1.5."
metrics:
  duration_minutes: 10
  completed_date: 2026-04-22
---

# Phase 16 Plan 02: Tauri group lockstep + Playwright sidecar Vitest unification Summary

Landed Phase 16 Wave B in two atomic commits: Tauri group Rust↔JS lockstep bump to 2.10.x (B3) and Playwright sidecar Vitest 2→4 unification (B4). Both per-commit gates green: cargo check --workspace, cargo test --workspace (89/89 test bins, 0 failed), turbo typecheck, turbo build, apps/desktop vitest 201/209 (baseline), playwright-sidecar vitest 60/60.

## Commits

- `90c6846` — refactor(16-B3): bump Tauri group (Rust tauri* 2.10.x + JS @tauri-apps/* 2.x latest)
- `33e37a7` — chore(16-B4): unify playwright-sidecar vitest 2 -> 4.1.5

## What was changed

### B3 — Tauri group lockstep (6 manifests)

Rust side — `apps/desktop/src-tauri/Cargo.toml`:
- tauri-build `"2"` → `"2.5.6"` (build-dep)
- tauri `"2"` → `"2.10.3"`
- tauri-plugin-log `"2"` → `"2.8.0"`
- tauri-plugin-fs `"2"` → `"2.5.0"`
- tauri-plugin-dialog `"2"` → `"2.7.0"`
- tauri-plugin-updater `"2"` → `"2.10.1"`
- tauri-plugin-window-state `"2"` → `"2.4.1"`
- tauri-plugin-shell `"2"` → `"2.3.5"`
- tauri-plugin-opener `"2"` → `"2.5.3"`
- tauri-plugin-process `"2"` → `"2.3.1"`
- tauri-plugin-single-instance `"2"` → `"2.4.1"`
- tauri-plugin-store `"2.4"` → `"2.4.2"`
- tauri-plugin-os `"2"` → `"2.3.2"`

Rust side — `scripts/notarize/smoke-app/src-tauri/Cargo.toml`:
- tauri-build `"2"` → `"2.5.6"`
- tauri `"2"` → `"2.10.3"`

JS side — `apps/desktop/package.json`:
- @tauri-apps/api `^2.0.0` → `^2.10.1`
- @tauri-apps/plugin-dialog `^2.0.0` → `^2.7.0`
- @tauri-apps/plugin-fs `^2.0.0` → `^2.5.0`
- @tauri-apps/plugin-log `^2.0.0` → `^2.8.0`
- @tauri-apps/plugin-os `^2.0.0` → `^2.3.2`
- @tauri-apps/plugin-process `^2.0.0` → `^2.3.1`
- @tauri-apps/plugin-shell `^2.0.0` → `^2.3.5`
- @tauri-apps/plugin-store `^2.4.0` → `^2.4.2`
- @tauri-apps/plugin-updater `^2.0.0` → `^2.10.1`
- @tauri-apps/plugin-window-state `^2.0.0` → `^2.4.1`
- @tauri-apps/cli `^2.0.0` → `^2.10.1` (devDep)

JS side — `packages/shared-types/package.json`: @tauri-apps/api `^2.0.0` → `^2.10.1`

JS side — `scripts/notarize/smoke-app/package.json`: @tauri-apps/cli `^2.0.0` → `^2.10.1`

pnpm-lock.yaml regenerated in the same commit (+90/-30 entries for @tauri-apps/*). Cargo.lock untouched — verified the resolver had already locked all tauri* crates at the target versions, so the `"2" → "2.10.3"` pin change was a SemVer tighten with no resolve delta. Confirmed via `grep -E '^name = "tauri"$' -A1 Cargo.lock` returning `version = "2.10.3"`.

### B4 — Playwright sidecar Vitest unification

`scripts/playwright-sidecar/package.json`:
- vitest `^2.1.0` → `^4.1.5` (devDep, aligns with repo-wide Vitest 4.1.5 baseline set in Wave A for apps/desktop + packages/ui)

pnpm-lock.yaml regenerated (net -515 lines: Vitest 2 dep tree shed, shared with existing v4 install from Wave A so no net add). Zero test source migration needed — 60/60 sidecar tests pass verbatim under Vitest 4.

## Deviations from Plan

### None

Both tasks landed at the exact PRD target versions with no auto-fixes required:
- No IPC/Tauri plugin API breakage between `2.x → 2.10.x` — preserved major, all call sites compile unchanged.
- No Vitest 2→4 test API migration required — no legacy APIs in sidecar suite.
- No `@ts-ignore`, no `--no-verify`, no workarounds.
- No Co-Authored-By trailer.

One non-deviation worth noting: Cargo.lock had no diff for B3. The plan's acceptance criterion says "Cargo.lock + pnpm-lock.yaml present in commit". Verified this holds because the workspace resolver had already pre-locked tauri 2.10.3 / tauri-build 2.5.6 / all plugins at their 2.10.x versions prior to this plan (likely during Wave A's broader `cargo check` pass). The Cargo.toml pin change tightens the allowed range from `"2"` to exact pins but the resolved versions did not move, so no lockfile update was triggered. This is correct behavior, not a bug.

## Verification Run

### B3 gate
```
cargo check --workspace --all-targets   → exit 0
cargo test --workspace --no-fail-fast   → 89/89 test binaries PASS (0 failed, 1238 lines of log)
pnpm install                             → exit 0 (rework of @tauri-apps/* tree)
pnpm -w turbo run typecheck              → 4/4 tasks PASS
pnpm -w turbo run build                  → 2/2 tasks PASS
apps/desktop vitest run                  → 201/209 PASS (8 pre-existing failures carried forward, matches 16-01 baseline)
```

### B4 gate
```
pnpm install                             → exit 0
pnpm --filter playwright-sidecar test    → 60/60 tests PASS (5 test files, Vitest v4.1.5, 13.09s)
pnpm -w turbo run typecheck              → 4/4 tasks PASS (FULL TURBO cache hit)
pnpm -w turbo run build                  → 2/2 tasks PASS (FULL TURBO cache hit)
```

## Acceptance Criteria

B3:
- [x] `grep 'tauri = "2.10.3"' apps/desktop/src-tauri/Cargo.toml` present
- [x] `grep '"@tauri-apps/api": "\^2.10.1"' apps/desktop/package.json` present
- [x] `grep 'tauri-plugin-updater = "2.10.1"' apps/desktop/src-tauri/Cargo.toml` present
- [x] `grep '"@tauri-apps/api": "\^2.10.1"' packages/shared-types/package.json` present
- [x] `cargo check --workspace --all-targets` exit 0
- [x] `cargo test --workspace` exit 0 (89/89 test bins green; cargo-nextest not installed locally per 16-01 convention)
- [x] `turbo run typecheck` exit 0
- [x] `turbo run build` exit 0
- [x] `pnpm --filter @storycapture/desktop exec vitest run` matches 201/209 baseline
- [x] pnpm-lock.yaml present in commit; Cargo.lock verified already at target (no diff)

B4:
- [x] `grep '"vitest": "\^4.1.5"' scripts/playwright-sidecar/package.json` present
- [x] `pnpm install` exit 0
- [x] `pnpm --filter playwright-sidecar test` exit 0 (60/60)
- [x] `turbo run typecheck` exit 0
- [x] `turbo run build` exit 0

## Known Stubs

None introduced by this plan.

## Deferred Items

None. Items intentionally not bumped here are all tracked under Phase 16-03 (C), 16-04 (D), 16-05 (E) per `16-CONTEXT.md`.

## Self-Check

Files modified (verification):
- apps/desktop/src-tauri/Cargo.toml — `tauri = "2.10.3"` on line 26
- apps/desktop/package.json — `"@tauri-apps/api": "^2.10.1"` on line 33
- packages/shared-types/package.json — `"@tauri-apps/api": "^2.10.1"` on line 19
- scripts/notarize/smoke-app/src-tauri/Cargo.toml — `tauri = "2.10.3"` on line 12
- scripts/notarize/smoke-app/package.json — `"@tauri-apps/cli": "^2.10.1"`
- scripts/playwright-sidecar/package.json — `"vitest": "^4.1.5"`
- pnpm-lock.yaml — regenerated across both commits

Commits verified in `git log --oneline`:
- 90c6846 refactor(16-B3): bump Tauri group (Rust tauri* 2.10.x + JS @tauri-apps/* 2.x latest)
- 33e37a7 chore(16-B4): unify playwright-sidecar vitest 2 -> 4.1.5

## Self-Check: PASSED
