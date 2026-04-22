---
phase: 16
plan: 05
subsystem: dependency-upgrade
tags: [dependency-upgrade, gated, framework-majors, phase-e, docs-sync, next16]
dependency-graph:
  requires:
    - 16-04 (Wave D JS major bumps)
  provides:
    - Next.js 16 in apps/web
    - CLAUDE.md + docs/ARCHITECTURE.md sync to final Phase 16 pins
  affects:
    - apps/web (Turbopack is now default bundler)
    - docs agent-facing references
tech-stack:
  added: []
  patterns: []
key-files:
  created:
    - .planning/phases/16-upgrade-all-dependencies-to-latest-bump-every-js-ts-package-/16-05-SUMMARY.md
  modified:
    - apps/web/package.json
    - apps/web/next-env.d.ts
    - pnpm-lock.yaml
    - CLAUDE.md
    - docs/ARCHITECTURE.md
    - crates/encoder/Cargo.toml
decisions:
  - E22 skipped — no newer next-auth beta on npm dist-tags (5.0.0-beta.31 is current latest beta)
  - E24 approved — Next 15 → 16.2.4 landed (Turbopack is default; no breaking migration needed)
  - E25 deferred — @auth/prisma-adapter peerDeps do not list Prisma 7
  - E26 deferred — no Windows CI runner available to verify WGC surface bump
  - E27 documented blocked-no-op — specta 2.0.0-rc.24 requires nightly Rust (const_type_id, debug_closure_helpers)
  - E28 landed — all doc references synced to final pins
metrics:
  duration: ~25 min
  completed-date: 2026-04-22
---

# Phase 16 Plan 05: Gated framework majors + docs sync Summary

Landed Next.js 15 → 16 in apps/web and synchronized CLAUDE.md + docs/ARCHITECTURE.md to the final pinned versions from Waves 1–5. All other gated framework majors (next-auth, Prisma 7, windows 0.62, tauri-specta RC) are documented as intentionally skipped / deferred with evidence.

## Executed Tasks

### E24-exec — Next 15 → 16 in apps/web

**Commit:** `ac8e8f8` `refactor(16-E24-next): bump next 15 -> 16 in apps/web`

Pre-resolution: user APPROVED at E24-pre.

Changes:
- `apps/web/package.json`: `next: ^15.3.0 → ^16.2.4`
- `apps/web/next-env.d.ts`: auto-regenerated; Next 16 added `import "./.next/types/routes.d.ts"` for the new typed-routes feature
- `@prisma/client` kept on 6.x (E25 decoupled)
- Turbopack is the default bundler in Next 16 — no code changes required
- No `middleware.ts`, `unstable_cache`, `export const revalidate`, or `export const dynamic` in `apps/web/src` — nothing to migrate
- tRPC 11 + NextAuth v5-beta remain compatible (no API drift observed)

Gate: `turbo run typecheck --filter=@storycapture/web` ✅, `turbo run build --filter=@storycapture/web` ✅. No `test` script defined for apps/web (same as prior waves).

Turbopack emits a warning about Prisma generated-client dynamic `require()` calls — pre-existing (resolves with Prisma 7 upgrade). Build still succeeds.

### E28 — Docs sync

**Commit:** `3d1625b` `docs(16-E28): sync CLAUDE.md + docs/ARCHITECTURE.md with Phase 16 final pins`

**CLAUDE.md Technology Stack tables updated to final Phase 16 pins:**

| Reference | Before | After |
|---|---|---|
| `tauri` | 2.8.x | 2.10.x |
| `tokio` | 1.40+ | 1.52.x |
| `pest` / `pest_derive` | 2.7.x | 2.8.x |
| `rusqlite` | 0.33.x | 0.39.x |
| `rusqlite_migration` | 1.3.x | 2.5.x |
| `reqwest` (rustls) | — | 0.13.x (added row) |
| `screencapturekit` (doom-fish) | 1.70.x | =1.5.4 (pinned) |
| `objc2` family | current | 0.6.x (unified) |
| `windows-capture` | 1.5.x | =2.0.0 |
| `windows` (windows-rs) | 0.58+ | 0.58 (deferred 0.62 bump noted) |
| `xcap` | 0.8.x | 0.9.x |
| `vite` | 6.x | 8.x |
| `@vitejs/plugin-react` | 4.x | 6.x |
| `typescript` | 5.7+ | 6.x |
| `lucide-react` | 0.460+ | 1.8.x |
| `zod` | 3.x | 4.x |
| `sonner` | 1.x | 2.x |
| `next` | 15.x | 16.x (Turbopack default) |
| `next-auth` | 5.x (beta) | 5.0.0-beta.31 (pinned) |
| `jose` | 5.x | 6.x |
| `pino` / `pino-pretty` | 9.x / 11.x | 10.x / 13.x |
| `resend` | — | 6.x (added row) |
| `Biome` | latest | 2.x (renamed section; removed ESLint/Prettier) |
| `Tauri 2.8 + plugins` version note | 2.8 | 2.10 |
| Prisma + Next.js pair note | Prisma 6 + Next 15 | Prisma 6 + Next 16 (Turbopack dynamic-require warning noted) |
| Web Companion section header | "(Next.js 15)" | "(Next.js 16)" |
| Arch quick-rules (bottom of CLAUDE.md) | "Next.js 15 App Router" | "Next.js 16 App Router (Turbopack default)" |
| `react-hook-form` / `@hookform/resolvers` | present | removed (not in tree since Wave D) |
| `react-resizable-panels`, `react-hotkeys-hook`, `tailwind-merge` | — | added rows (3.x / 5.x / 3.x) |

Kept CLAUDE.md lean per project doc-sync rule — short bullet rows; full per-crate + per-package version table lives in **docs/ARCHITECTURE.md § Phase 16 final pinned versions** (new section added). Risk-flag content intact; only version numbers updated.

**docs/ARCHITECTURE.md updates:**
- Repo-layout block: "Vite 6 + Tauri 2" → "Vite 8 + Tauri 2.10" and "Next.js 15" → "Next.js 16 (Turbopack)".
- Web-companion section: "Next.js 15" → "Next.js 16 App Router (Turbopack is the default bundler as of Next 16)".
- Auth line: NextAuth v5 → "NextAuth v5 (pinned at `5.0.0-beta.31` — no newer beta on npm dist-tags)".
- **New section: "Phase 16 final pinned versions (post deps-upgrade)"** — three tables (Rust workspace, desktop frontend, web companion) plus "Intentionally deferred in Phase 16" block documenting Prisma 7, windows 0.62, and tauri-specta/specta rc.24 with root-cause blockers.

**Stale-comment cleanup:**
- `crates/encoder/Cargo.toml` — removed stale "capture crate still uses objc2 0.5" note; both crates unified on objc2 0.6 since Wave C.

Gate: `cargo check --workspace` ✅.

## Skipped Tasks

### E22 — next-auth bump

**Pre-resolution:** user selected SKIP after running `pnpm view next-auth dist-tags` (per checkpoint guidance).

Evidence (dist-tags snapshot):
```
{ ..., beta: '5.0.0-beta.31', latest: '4.x', ... }
```

Current `apps/web/package.json` already pins `next-auth: 5.0.0-beta.31`. The `beta` dist-tag matches our pinned version exactly — there is no newer beta on npm to bump to. Recorded as skipped (not deferred, not commented out; simply omitted). Will revisit when a newer `5.0.0-beta.N` or the stable v5 appears on npm.

## Deferred / Blocked Tasks

### E25 — Prisma 6 → 7

**Pre-resolution:** user selected DEFER.

Evidence (`pnpm view @auth/prisma-adapter peerDependencies`):
```
{ '@prisma/client': '>=2.26.0 || >=3 || >=4 || >=5 || >=6' }
```
No `>=7` entry. Per the plan's explicit "STOP and escalate if the adapter does not support Prisma 7" clause, E25-exec is omitted entirely.

**Action to unblock:** Reattempt after `@auth/prisma-adapter` publishes a release whose peerDependencies include `@prisma/client >=7`.

### E26 — windows 0.58 → 0.62

**Pre-resolution:** user selected DEFER. E26-runner-check = `no` (Windows runner unavailable on macOS darwin host).

The `windows` crate bump changes the WGC (`Graphics_Capture`) surface. Verifying the change requires building + testing `crates/capture` on an `x86_64-pc-windows-msvc` target, which we cannot do from the current workstation. Per the plan's explicit "MUST NOT execute without Windows CI runner" clause, E26-exec is omitted.

Current state: `windows = "0.58"` as direct dep in `crates/capture/Cargo.toml` and workspace `Cargo.toml`; `windows-capture 2.0.0` transitively pulls `windows 0.62`. Two versions coexist in the graph (benign; our code only imports 0.58 directly).

**Action to unblock:** Dedicated Windows-CI phase with a `windows-latest` GitHub runner (or operator VM) available to run `cargo check --target x86_64-pc-windows-msvc -p capture` and the real-hardware WGC tests.

### E27 — tauri-specta / specta RC bump

**Pre-resolution:** user selected RUN.

**Result: blocked-no-op** (distinct from the plan's "already at latest" no-op branch).

Evidence captured at exec time:

`cargo search tauri-specta --limit 5`:
```
tauri-specta = "2.0.0-rc.24"
```

`cargo search specta --limit 10`:
```
specta = "2.0.0-rc.24"
```

`cargo search specta-typescript --limit 3`:
```
specta-typescript = "0.0.11"
```

Current pins:
- `apps/desktop/src-tauri/Cargo.toml`: `tauri-specta = "=2.0.0-rc.21"`, `specta = "=2.0.0-rc.22"`, `specta-typescript = "0.0.9"`
- `crates/story-parser/Cargo.toml`: `specta = "2.0.0-rc.22"`

Attempted bump to rc.24 (all 4 pin sites). `cargo check --workspace` failed:

```
error[E0658]: use of unstable library feature `debug_closure_helpers`
   --> specta-2.0.0-rc.24/src/datatype/attributes.rs:236:29

error: `TypeId::of` is not yet stable as a const fn
  --> specta-2.0.0-rc.24/src/datatype/reference.rs:67:17
  help: add `#![feature(const_type_id)]` to the crate attributes to enable
```

`specta 2.0.0-rc.24` requires nightly Rust. Our workspace `rust-version = "1.88"` stable. `tauri-specta@rc.24` and `specta-typescript@0.0.11` both depend exactly on `specta =2.0.0-rc.24` (confirmed via crates.io dependency API), so the entire coordination group is stuck at rc.21 / rc.22 / 0.0.9 on stable-Rust toolchains.

Verified Cargo.toml files reverted to original pinned versions; `cargo check --workspace` green.

**Action to unblock:** Either (a) wait for the specta project to revert to stable-Rust features or publish a stable-compatible 2.x release, or (b) bump the workspace MSRV to a nightly-tracking toolchain (large architectural change — would require its own phase).

Per stop-condition #2 of the plan's orchestrator contract ("tauri-specta RC has no matching specta RC that compiles with our current Rust surface"), recorded as blocked rather than executed. No commit landed; `packages/shared-types/src/ipc.ts` unchanged.

## Deviations

- **Rule 2** — intentionally preserved CLAUDE.md "Frontend — Desktop (React 19)" row cleanup: dropped the stale `react-hook-form + @hookform/resolvers` row because the tree no longer ships those (confirmed via `grep -rn react-hook-form apps/desktop/src` — zero hits). Added three rows (`react-resizable-panels`, `react-hotkeys-hook`, `tailwind-merge`) that are now first-class deps after Wave D. This is a doc accuracy fix, not a code change.
- **No Rule 1/3 auto-fixes** — E24 bump was clean; no type/build errors introduced.

## Verification Gate

| Check | Result |
|---|---|
| `turbo run typecheck` (workspace) | ✅ 4/4 green (web + desktop + ui + story-dsl; cached) |
| `turbo run build` (workspace) | ✅ 2/2 green (web + desktop; cached) |
| `cargo check --workspace --all-targets` | ✅ green (1 pre-existing `dead_code` warning in story-parser) |
| `cargo test --workspace` | ✅ all test suites passing (unchanged from baseline) |
| `pnpm biome check` | ⚠️ 130 pre-existing errors in apps/web (generated Prisma client, missing button types, missing svg titles). Files I touched (`apps/web/package.json`, `apps/web/next-env.d.ts`, CLAUDE.md, docs/ARCHITECTURE.md, crates/encoder/Cargo.toml) all biome-clean. Out of scope per executor boundary rule. |
| E28 acceptance greps | ✅ `screencapturekit.*1.70` = 0, `screencapturekit.*1.5.4` ≥ 1, `windows-capture.*1.5` = 0, `windows-capture.*2.0` ≥ 1, `objc2.*0.5` = 0, `objc2.*0.6` ≥ 1 |

## Commits Landed (chronological)

| Commit | Scope | Summary |
|---|---|---|
| `ac8e8f8` | 16-E24 | bump next 15 → 16.2.4 in apps/web |
| `3d1625b` | 16-E28 | sync CLAUDE.md + docs/ARCHITECTURE.md with Phase 16 final pins |

Total: 2 atomic commits (E22 skipped, E25/E26 deferred, E27 blocked-no-op, so 2 of 7 possible commits landed).

## Self-Check: PASSED

Created files verified:
- `.planning/phases/16-upgrade-all-dependencies-to-latest-bump-every-js-ts-package-/16-05-SUMMARY.md` (this file) — FOUND

Commits verified:
- `ac8e8f8` — FOUND (refactor(16-E24-next): bump next 15 -> 16 in apps/web)
- `3d1625b` — FOUND (docs(16-E28): sync CLAUDE.md + docs/ARCHITECTURE.md with Phase 16 final pins)

Phase 16 execution complete. Plan 16-05 is the final plan in Phase 16 — all 5 waves (A/B/C/D/E) have now landed.
