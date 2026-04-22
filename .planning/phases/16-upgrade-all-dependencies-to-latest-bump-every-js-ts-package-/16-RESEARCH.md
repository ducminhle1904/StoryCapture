# Phase 16: Upgrade all dependencies to latest — Research

**Researched:** 2026-04-22
**Domain:** Monorepo dependency upgrade (Rust + TS/JS), 173 packages across 20 manifests
**Confidence:** MEDIUM (PRD audit is HIGH; per-crate breaking-change surface research is MEDIUM; many claims about 0.x→0.x diffs are [ASSUMED] from training and must be re-verified at commit time via `cargo check` output)

## Summary

Phase 16 is an upgrade-only phase governed by the PRD at `.planning/notes/deps-upgrade-plan.md`. The PRD already enumerates every target version, the 15 coordination groups that must move atomically, and the 5-phase execution order (A Safe → B Tauri/Vitest → C Rust 0.x breaking → D JS majors → E Gated framework majors). The planner does NOT need a second version audit.

What the planner DOES need is per-bump **risk surface** knowledge: which APIs break, which symbols to grep for before editing, which tests gate each commit, and how to verify the commit gate (`cargo check && cargo nextest && turbo run typecheck && turbo run build`) is actually green. This research document provides that — organized by execution phase and by coordination group.

**Primary recommendation:** Plan decomposition should map **1 PLAN.md per execution phase A/B/C/D/E** (5 plans), with **waves grouped by coordination group** inside each plan. Every task's verification step must run the full per-commit gate, NOT just a crate-local test. `chromiumoxide` is confirmed absent from every `Cargo.toml` (only in doc comments at `crates/automation/src/capability.rs` and `apps/desktop/src-tauri/src/{logging.rs,commands/app_settings.rs}`) — exclude from this phase entirely per CONTEXT deferred section.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Execution order — 5 sequential phases, each commit must be green:**

- **Phase A (Safe patch/minor):** A1 workspace Rust patch/minor bump (one commit); A2 per-workspace npm patch/minor bumps (desktop, web, ui, shared-types, playwright-sidecar, smoke-app).
- **Phase B (Coordinated non-breaking):** B3 Tauri group (Rust `tauri*` 2.x → 2.10.x + JS `@tauri-apps/*` latest + CLI); B4 Playwright sidecar `vitest` 2 → 4.
- **Phase C (0.x breaking, one commit per group):** C5 `objc2` family 0.5 → 0.6; C6 `rusqlite` 0.34 → 0.39; C7 `reqwest` 0.12 → 0.13; C8 `sha2` 0.10 → 0.11; C9 `scraper` 0.20 → 0.26; C10 `nix` 0.29 → 0.31; C11 one commit per crate for `tower`, `schemars`, `rand`, `toml`, `ts-rs`; C12 replace deprecated `serde_yaml`.
- **Phase D (JS majors, per-package verification):** D13 `tailwind-merge` 2→3; D14 `sonner`/`cmdk`/`react-resizable-panels`/`react-hotkeys-hook`/`lucide-react`; D15 `zod` 3→4; D16 `jose` 5→6; D17 `pino` 9→10 + `pino-pretty` 11→13; D18 `resend` 4→6; D19 `vite` 6→8 + `@vitejs/plugin-react` 4→6; D20 `typescript` 5→6 repo-wide; D21 Biome 1→2 + `biome migrate`.
- **Phase E (Gated framework majors):** E22 `next-auth` (confirm via `npm view next-auth dist-tags`); E23 `@types/node` SKIP; E24 Next 15→16; E25 Prisma 6→7; E26 `windows` 0.58→0.62; E27 `tauri-specta`/`specta` RC bump + regenerate `packages/shared-types/src/ipc.ts`; E28 docs sync (`CLAUDE.md`, `docs/ARCHITECTURE.md`).

**Coordination groups (15, move together in ONE commit):** Tauri group · TanStack Query · tRPC · Prisma · AWS SDK · objc2 family · rusqlite · pest · reqwest · ts-rs · tauri-specta/specta · React · Vite toolchain · TypeScript · Biome.

**Do NOT bump:** `screencapturekit =1.5.4`; `chromiumoxide` (not present); `@types/node` 22→25; committed majors from CLAUDE.md unless D/E authorizes.

**Per-commit verification gate (MANDATORY):** `cargo check && cargo nextest && turbo run typecheck && turbo run build`. Web: also `turbo run test --filter=web`. Desktop FE: `pnpm --filter desktop test`. After IPC/typespec bumps: regenerate `packages/shared-types/src/ipc.ts` and verify round-trip.

**Commit message convention:** `type(scope): subject`; `scope = 16-A1`/`16-B3`/`16-C6-rusqlite`; type = `chore` for safe, `refactor` for API-surface, `feat` only if new behavior adopted. **Never add `Co-Authored-By` trailers.**

### Claude's Discretion

- Exact plan decomposition (number of PLAN.md files mapping to A1..E28).
- Wave/parallelization within each phase (C5–C12 could parallelize where commit boundaries permit).
- How to structure `must_haves` for goal-backward verification.
- Choice between `serde_yml` vs `serde_yaml_ng` (pick more active fork, cleanest swap).

### Deferred Ideas (OUT OF SCOPE)

- `chromiumoxide` addition (CLAUDE.md lists it, no `Cargo.toml` reference) — defer until user confirms intent.
- `@types/node` 22 → 25 — gated on Node runtime floor decision.
- `next-auth` v5 bump is conditional on `npm view next-auth dist-tags` showing newer beta than `5.0.0-beta.31`.
</user_constraints>

## Project Constraints (from CLAUDE.md)

Directives the planner MUST honor for every task in this phase:

- **No workarounds** — solve at root cause. If a bump breaks a test, fix the real API drift; do not `#[allow(deprecated)]`, skip the test, or pin back to the old version silently.
- **No `Co-Authored-By` trailers** in any commit.
- **Concise code comments** — if a bump forces a workaround rationale, one line max.
- **Plan Before Breaking / Big Changes** — every major bump (Phase C/D/E) already qualifies; planner must present plan for user approval before executing Phase C onwards. Phase A/B only if scope expands.
- **Keep agent docs in sync** — Phase E28 is mandatory, NOT optional. Any bump in Phase C/D/E that changes a CLAUDE.md / `docs/ARCHITECTURE.md` / `docs/CONVENTIONS.md` line must update the doc in the same task (not deferred to E28 if the doc fact changed mid-phase).
- **Committed majors locked** (Tauri 2.x, React 19, Next 15, Tailwind v4, Zustand 5, TanStack Query 5, Motion 12, Prisma 6, NextAuth v5, tRPC 11, Biome — project allows v2, `screencapturekit` pinned, `chromiumoxide` absent). Phase D/E steps that cross these lines (Next 15→16, Prisma 6→7, Biome 1→2, TypeScript 5→6, Vite 6→8) require explicit per-step user approval at execution time.
- **Reply in user's language** (Vietnamese for this project).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Rust crate bumps (`objc2`, `rusqlite`, `reqwest`, `sha2`, `scraper`, `nix`, `tower`, `schemars`, `rand`, `toml`, `ts-rs`) | Domain crates (`crates/*`) + Tauri host (`apps/desktop/src-tauri`) | — | Pure-Rust changes; Tauri commands are thin bridges and recompile automatically |
| Tauri plugin JS+Rust group | Desktop host + desktop frontend + shared-types + smoke-app | — | IPC surface straddles Rust and TS |
| `tauri-specta`/`specta` RC bump | Desktop host | `packages/shared-types` (regen target) + `crates/story-parser` (optional specta feature) | IPC typespec codegen crosses both sides |
| React 19 patch + Motion/Zustand/TanStack Query bumps | `apps/desktop` + `packages/ui` + `apps/web` | — | Pure TS/React surface |
| Next/Prisma/zod/jose/pino/resend | `apps/web` | — | Web companion only |
| Vite 6→8 + plugin-react 4→6 + Vitest | Desktop build tooling + `packages/ui` | `scripts/playwright-sidecar` (Vitest only) | Build toolchain shared across frontends |
| TypeScript 5→6 | Repo-wide (6 manifests) | — | Touches every workspace |
| Biome 1→2 | Root devDep | Repo-wide via `biome.json` | Single config drives lint/format everywhere |
| `windows` 0.58→0.62 | `crates/capture` (WGC backend) | Workspace root | Collapses transitive duplication from `windows-capture 2.0` |
| Docs sync (E28) | `CLAUDE.md` + `docs/ARCHITECTURE.md` | — | Keep agent-facing docs accurate |

## Phase Requirements

No REQ-IDs — PRD at `.planning/notes/deps-upgrade-plan.md` is the authoritative source of truth. Success is defined by:
1. Each of A1..E28 landing as a green commit (commit gate: `cargo check && cargo nextest && turbo run typecheck && turbo run build`).
2. No regression in desktop `pnpm --filter desktop test`, web `turbo run test --filter=web`, or any Rust integration test behind the real-hardware feature flags (`real-capture`, `real-capture-windows`, `real-ffmpeg`, `real-playwright-tests`) — the planner must run these on a best-effort basis where the runner supports them.
3. Docs updated at E28 (CLAUDE.md/docs/ARCHITECTURE.md drift corrected).

## Standard Stack

This phase does not introduce new dependencies. The "stack" for this phase is the **set of tools that make upgrades safe** — all already committed:

### Upgrade tooling (already present)

| Tool | Purpose | Command |
|------|---------|---------|
| `cargo` + workspace `Cargo.toml` | Rust version bumps | `cargo update -p <crate> --precise <ver>` or edit workspace `[workspace.dependencies]` |
| `cargo nextest` | Faster workspace test execution | `cargo nextest run --workspace` |
| `pnpm` 9.x | JS workspace package manager | `pnpm up -r <pkg>@<ver>` or edit manifest + `pnpm install` |
| `turbo` 2.x | Orchestrate typecheck/build across workspaces | `turbo run typecheck`, `turbo run build`, `turbo run test --filter=<ws>` |
| `biome migrate` | Biome 1→2 schema + rule-id migration | `pnpm biome migrate --write` (D21 only) |
| `pnpm tauri-specta` codegen (existing script) | Regenerate `packages/shared-types/src/ipc.ts` after specta bump | Per `docs/ARCHITECTURE.md` IPC section |
| `pnpm prisma generate` | Regenerate Prisma client output after 6→7 | From `apps/web` |

### Verification commands (order per-commit)

```bash
# Rust side (runs in repo root or workspace member)
cargo check --workspace --all-targets
cargo nextest run --workspace

# JS/TS side
pnpm install                          # refresh lockfile if manifests changed
turbo run typecheck                   # repo-wide TS gate
turbo run build                       # repo-wide build gate
turbo run test --filter=web           # if web deps changed
pnpm --filter desktop test            # if desktop FE deps changed
```

**Version verification:** Planner MUST re-run `pnpm view <pkg> version` / `cargo search <crate>` or `npm view <pkg>@latest version` at execution time for each step — the PRD was audited 2026-04-21 and patch/minor versions drift weekly. The PRD's target-version tables are a lower bound; take the newer latest if it exists within the committed major.

## Architecture Patterns

### Execution flow

```
Per step (A1..E28):
  1. Read target version from PRD + re-verify with `pnpm view` / `cargo search`
  2. Edit manifest(s) — ALL members of coordination group in ONE commit
  3. Regenerate lockfile(s): `pnpm install` and/or let cargo update on next build
  4. Run per-commit gate (cargo check + nextest + turbo typecheck + build)
  5. Run targeted follow-ups for the specific risk surface (see Risk Surface Inventory below)
  6. Commit with convention: `type(16-<step>[-<crate>]): subject`
  7. If gate fails: fix root cause (NO workarounds per CLAUDE.md) or escalate to user
```

### Recommended plan decomposition

**Recommended: 5 PLAN.md files, one per execution phase.**

- `16-01-PLAN.md` = Phase A (safe bumps, ~2 waves: Rust workspace, then per-JS-workspace)
- `16-02-PLAN.md` = Phase B (Tauri group + playwright-sidecar Vitest unification, 2 waves)
- `16-03-PLAN.md` = Phase C (0.x breaking, ~8 waves grouped by crate — objc2, rusqlite, reqwest, sha2, scraper, nix, the "one commit each" group C11, serde_yaml replacement C12)
- `16-04-PLAN.md` = Phase D (JS majors, ~9 waves — one per coordinated group)
- `16-05-PLAN.md` = Phase E (gated framework majors, ~7 waves including docs sync)

Rationale: each plan maps to one PRD phase → atomic user-approval boundary. Waves inside a plan can be sequential (Phase C/D/E) or parallelized only where commit boundaries are disjoint (Phase A1 vs A2 workspaces — but lockfile contention makes serial safer).

### Anti-patterns to avoid

- **Bulk manifest edit across coordination groups in one commit.** Breaks atomicity; rollback becomes impossible. Each group → one commit.
- **`cargo update` without editing manifests.** `cargo update` only respects existing semver constraints. For a 0.x breaking bump the manifest MUST be edited first.
- **Using `pnpm up --latest` without reviewing.** Would skip past gated majors (Next 15→16 etc.) before user approval.
- **Regenerating IPC typespec types casually.** After `tauri-specta`/`specta` bumps the regen MUST be part of the same commit; a decoupled regen breaks the desktop FE build silently.
- **Skipping `cargo nextest` because "it's just a patch bump".** Patch bumps of `rusqlite`, `reqwest`, etc. have historically shipped breaking behavior in 0.x.
- **`#[allow(deprecated)]` as a fix.** Violates CLAUDE.md "no workarounds." Port to the new API.

## Runtime State Inventory

Phase 16 is a code-only dep upgrade. Runtime state audit:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | **None** — no data migrations implied by dep bumps. `rusqlite` 0.34→0.39 is an API change, not a file-format change; existing SQLite DBs continue to read. `rusqlite_migration` 2.x handles the same migration table format. | None |
| Live service config | **None** — no external services configured. | None |
| OS-registered state | **None** — no Task Scheduler, launchd, pm2 registrations touched. | None |
| Secrets/env vars | **None renamed.** `next-auth` v5-beta config env var names unchanged if we stay in v5 line. `jose` 5→6 does NOT change `NEXTAUTH_SECRET` semantics. | None |
| Build artifacts | **Regen required after these steps:** E25 (Prisma 6→7 → regenerate `apps/web/generated/prisma/` output dir per existing Prisma Next.js guide); E27 (tauri-specta RC → regenerate `packages/shared-types/src/ipc.ts`); D19 (Vite 6→8 → `.turbo` / Vite build cache should be cleared to avoid stale transform cache). `pnpm-lock.yaml` and `Cargo.lock` regenerated per-commit group. | Regen per step |

**Canonical question check:** *After every file is updated, what runtime systems still have the old string cached?* → Only build artifacts (Prisma client output, specta-generated TS types, build caches). All addressed inline.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Biome 1 → 2 rule migration | Manual rule-id search/replace | `pnpm biome migrate --write` | Biome ships a migration tool that rewrites `biome.json` schema URL + renamed rule ids correctly [CITED: biomejs.dev migration guide]. Manual editing will miss renamed rules. |
| Prisma 6 → 7 client regen | Hand-patch `@prisma/client` imports | `pnpm prisma generate` after bump | Prisma client is generated code; edits are lost on next generate [VERIFIED: current repo pattern per Prisma Next.js guide]. |
| `tauri-specta` codegen | Hand-edit `packages/shared-types/src/ipc.ts` | Run existing codegen script per `docs/ARCHITECTURE.md` (`ipc_spec.rs` → `.typ::<T>()` → generated TS) | File header says "auto-generated — never hand-edit" [VERIFIED: repo convention]. |
| Lockfile reconciliation | `rm -rf node_modules && reinstall` | `pnpm install` (cascade-dedup built in) + `cargo generate-lockfile` only when genuinely corrupted | Destructive reinstall hides resolver errors; `pnpm install` surfaces them. |
| Rust cross-crate version unification | Patch each crate's Cargo.toml individually with different versions | Workspace `[workspace.dependencies]` block — already used in repo for `tokio`/`serde`/`objc2`/etc. | Single source of truth; prevents multi-version graph (see `windows` 0.58 vs 0.62 duplication note). |

## Common Pitfalls

### Pitfall 1: `rusqlite` 0.34 → 0.39 five-minor jumps
**What goes wrong:** Between `rusqlite` 0.34 and 0.39, several API refinements landed: `Transaction::commit()` signature changes, `ToSql`/`FromSql` trait bounds tightened, `Connection::prepare_cached` lifetime shifts, `Error::FromSqlConversionFailure` variants may gain fields [ASSUMED — must verify via `cargo check` output at C6 execution]. Storage crate (`crates/storage/src/{app_db.rs,project_db.rs,phase3.rs}`) uses `params!`, `OptionalExtension`, `Connection`, `Error::FromSqlConversionFailure`, `Error::InvalidParameterName`. These are the primary surfaces to audit.
**Why it happens:** `rusqlite` 0.x has one breaking release per minor; 5 minors = 5 breaking changesets compounded.
**How to avoid:** Bump in ONE commit (C6), run `cargo check -p storage -p effects -p encoder -p storycapture` first to collect ALL breakage, then fix root-cause-first (NO `#[allow(deprecated)]`). Verify `rusqlite_migration` 2.5.x is compatible with `rusqlite` 0.39 before committing (check the `rusqlite_migration` changelog on crates.io at execution time).
**Warning signs:** `cargo check` errors in `Error::FromSqlConversionFailure(...)` constructor arity; borrowed-lifetime errors in `prepare_cached` call sites.
**Confidence:** MEDIUM — the specific API changes are [ASSUMED]; verified pattern is that each `rusqlite` minor has shipped at least one breaking change historically.

### Pitfall 2: `reqwest` 0.12 → 0.13 + SSE streaming break
**What goes wrong:** `reqwest` 0.13 may change `ClientBuilder` feature gates (`rustls-tls` vs `native-tls` defaults), `RequestBuilder::send()` return types, and byte-stream APIs used by `eventsource-stream`. The intelligence crate uses `eventsource-stream` to wrap `reqwest`'s `bytes_stream()` for Anthropic/OpenAI SSE (confirmed in `crates/intelligence/src/llm/anthropic.rs`). If `bytes_stream()` signature shifts, SSE parsing breaks at runtime — not at compile time for the wrapper, but at test time for provider probes.
**Why it happens:** 0.x HTTP libraries routinely refactor TLS backend and streaming surface.
**How to avoid:** After C7 bump, run `cargo nextest -p intelligence` (includes wiremock-based provider probe tests at `crates/intelligence/tests/`) AND the `real-playwright-tests` / provider streaming tests if a live API key is available. Verify `eventsource-stream` 0.2 still accepts the new `reqwest` 0.13 byte stream — check `eventsource-stream`'s `Cargo.toml` at bump time for a `reqwest = "0.13"` declaration.
**Warning signs:** Test failure in `llm::anthropic::tests` or `llm::openai::tests`; feature-flag compile errors like "cannot find rustls-tls-webpki-roots".
**Confidence:** MEDIUM — [ASSUMED] 0.13 has API drift; verified that streaming surface is business-critical per code grep.

### Pitfall 3: `objc2` 0.5 → 0.6 — encoder already on 0.6, capture on 0.5
**What goes wrong:** Multi-version `objc2` in the dep graph causes "two different `NSString` types" compile errors if a single module transitively pulls both. Encoder crate already uses 0.6; capture's SCK backend still on 0.5. Unifying to 0.6 will break capture's `msg_send!`/`Retained<>`/`ClassType` usage — the 0.5→0.6 migration removes `mutability::` traits and shifts to a new retained-pointer model [ASSUMED — verify via `objc2` 0.6 CHANGELOG].
**Why it happens:** `objc2` is pre-1.0 and API churns significantly per minor.
**How to avoid:** C5 in ONE commit covers workspace root, desktop host (`apps/desktop/src-tauri/src/lib.rs` uses `ClassType`), and capture. After bump, run `cargo check --target x86_64-apple-darwin` (or aarch64) to surface all macOS-only breakage. Windows CI must still pass (the `cfg(target_os = "macos")` guards should keep it isolated). Verify `objc2-app-kit` 0.3.x + `objc2-foundation` 0.3.x versions align with `objc2` 0.6.x family.
**Warning signs:** Errors about `ClassType` not found, `Retained::autorelease_return` method removed, `NSString::from_str` signature mismatch.
**Confidence:** MEDIUM — repo confirms encoder is on 0.6 already; [ASSUMED] for specific 0.5→0.6 API shifts.

### Pitfall 4: `rand` 0.8 → 0.10 — but repo only uses `rand::random()`
**What goes wrong:** Training knowledge says `thread_rng()` removed, `rand::rng()` is new entry point, `SliceRandom` moved [ASSUMED]. BUT: grep of `crates/intelligence/src` shows the ONLY use is `rand::random::<u64>() % 1000` in `llm/retry.rs`. `rand::random()` is the simplest top-level API and is generally stable across 0.8→0.10 transitions.
**Why it happens:** PRD flags `rand` as "massive API shuffle" but actual repo exposure is one line.
**How to avoid:** C11 bump is LOW risk for this repo specifically. Verify that `rand::random::<u64>()` still compiles after the bump — if not, migrate to `rand::rng().random::<u64>()` or equivalent new API.
**Warning signs:** Single `cargo check` error in `retry.rs` — easy root-cause fix.
**Confidence:** HIGH — grep evidence is [VERIFIED]; API surface is tiny.

### Pitfall 5: `schemars` 0.8 → 1.x — derive macro + `JsonSchema` trait changes
**What goes wrong:** `schemars` 1.0 GA rewrote the derive macro and changed `JsonSchema` trait methods [ASSUMED]. Repo uses it at `crates/intelligence/src/nl/schemas.rs` and `crates/intelligence/src/tts/script.rs` — multiple `#[derive(JsonSchema)]` types + `schemars::schema_for!()` macro calls. Output JSON Schema format may also change (draft-07 vs draft-2020-12), affecting LLM prompts that embed the schema string.
**How to avoid:** C11 `schemars` bump touches `intelligence` only. After bump, run `cargo nextest -p intelligence`; compare `schema_for!(StoryDoc)` output string before/after (the PRD test at `schemas.rs:233` likely snapshots it). If snapshot diff is material, update `insta` snapshot and verify the new schema still works with LLM providers (may need prompt adjustment — out of scope for this phase; escalate to user if schema format changed).
**Warning signs:** `insta` snapshot failures in schemas tests; derive macro errors on `JsonSchema`.
**Confidence:** MEDIUM — [ASSUMED] for specific API shifts; [VERIFIED] grep evidence of usage sites.

### Pitfall 6: `tauri-specta` / `specta` RC bump — IPC typespec regen
**What goes wrong:** Currently pinned `tauri-specta =2.0.0-rc.21` + `specta =2.0.0-rc.22`. PRD says check crates.io for newer 2.x-rc. RC-to-RC bumps frequently rename trait methods in `specta::Type`, change `specta-typescript` output syntax, or shift `collect_commands!` macro behavior. If `packages/shared-types/src/ipc.ts` regenerates with material diff, desktop FE imports may break (TS 6 strict mode will surface).
**How to avoid:** E27 is its own wave. After bumping: (1) run the existing regen script (per `docs/ARCHITECTURE.md` IPC section), (2) inspect diff on `packages/shared-types/src/ipc.ts` — if diff is non-trivial, run `turbo run typecheck` across desktop to find import breakage, (3) fix consumer call sites.
**Warning signs:** Large diff in `ipc.ts`; TS errors in `apps/desktop/src/ipc/*.ts`.
**Confidence:** MEDIUM — [VERIFIED] regen pattern exists in repo; [ASSUMED] specific RC-RC diff surface.

### Pitfall 7: Vite 6 → 8 skipping 7
**What goes wrong:** PRD jumps Vite 6 → 8 directly, skipping 7. Vite 7 introduced rolldown as the optional bundler and changed plugin API surface; Vite 8 continued. Tailwind v4 plugin (`@tailwindcss/vite` 4.2.x) should support Vite 7+8 but confirm. `@vitejs/plugin-react` 6.x targets Vite 7+ — coordinate bump (already group 13).
**How to avoid:** D19 in one commit. Run `pnpm --filter desktop dev` + `turbo run build` after bump; inspect for deprecated-API warnings in Vite plugin output. Confirm `@tailwindcss/vite` version is Vite-8-compatible at bump time via `pnpm view @tailwindcss/vite peerDependencies`.
**Warning signs:** Plugin load errors; missing exports in `vite/client`; Tailwind CSS not injecting.
**Confidence:** MEDIUM — [ASSUMED] Vite 7→8 diff surface; [CITED: package.json] coord group structure.

### Pitfall 8: TypeScript 5 → 6 — strictness surge
**What goes wrong:** TS 6 tightens default strictness (e.g., `noUncheckedIndexedAccess` behavior, deprecated APIs removed, stricter inference in React 19 JSX). 6 manifests pin `^5.7`. After bump, `turbo run typecheck` may surface dozens of errors across desktop+web+ui+shared-types+story-dsl+config.
**How to avoid:** D20 AFTER D19 (Vite toolchain must be stable first). Run `turbo run typecheck` immediately after bump; fix errors root-cause-first (no `as any` per CLAUDE.md). Budget: this is the largest JS risk item in the phase.
**Warning signs:** Large count of TS errors across workspaces post-bump.
**Confidence:** MEDIUM — [ASSUMED] specific TS 6 strictness changes (TS 6.0.3 is the PRD-stated latest as of 2026-04-21, must reverify at exec time).

### Pitfall 9: Prisma 6 → 7 — client output path + migration format
**What goes wrong:** Prisma 7 may change default client output dir (6 already uses `./generated/prisma/client` per CLAUDE.md recipe), migration SQL format, or `@prisma/client` runtime API. E25 requires `prisma` CLI + `@prisma/client` lockstep. NextAuth `@auth/prisma-adapter` must still support Prisma 7 — verify at bump time.
**How to avoid:** E25 gated. Before committing: `pnpm prisma generate`, `pnpm prisma migrate status`, `turbo run typecheck --filter=web`, `turbo run test --filter=web`. Do NOT touch `prisma/schema.prisma` for non-upgrade reasons in this commit.
**Warning signs:** Adapter peer-dep warnings; generated-client import breakage in tRPC routers.
**Confidence:** MEDIUM — [ASSUMED] Prisma 7 change surface.

### Pitfall 10: Next 15 → 16 — App Router + RSC cache semantics
**What goes wrong:** Next 16 App Router may change RSC default cache behavior, `next.config.js` schema, and middleware API [ASSUMED]. Must keep Prisma 6 pinned until E25. E24 must NOT bump Prisma simultaneously.
**How to avoid:** E24 gated. Read Next 16 upgrade guide at bump time. Run `turbo run build --filter=web` + `turbo run test --filter=web`. Verify tRPC 11 + NextAuth v5-beta still compatible with Next 16 before committing (both list Next 15 as supported — check their current changelogs).
**Warning signs:** RSC fetch-cache warnings; `next.config` schema errors; middleware compile errors.
**Confidence:** LOW — [ASSUMED] Next 16 specifics; gated for user approval.

### Pitfall 11: `zod` 3 → 4 + tRPC 11 compat
**What goes wrong:** tRPC 11 inputs use `zod`. Zod 4 breaking changes include `.object()` strict-mode default, error-map API, and possibly `.parse()` return type polish [ASSUMED]. If tRPC 11.16 was compiled against Zod 3, Zod 4 may need tRPC to publish a compat release — verify at bump time.
**How to avoid:** D15 gated. Before bumping, check `@trpc/server` changelog for Zod 4 support. If tRPC 11.16 doesn't yet support Zod 4, SKIP D15 (user approval to defer). Post-bump: `turbo run typecheck --filter=web` + `turbo run test --filter=web`.
**Warning signs:** tRPC route input-validation compile errors; `.parse()` runtime errors in existing tests.
**Confidence:** LOW — [ASSUMED] Zod 4 + tRPC 11 compat status; must verify at exec time.

### Pitfall 12: `serde_yaml` replacement — `serde_yml` vs `serde_yaml_ng`
**What goes wrong:** `serde_yaml` 0.9.34+deprecated is unmaintained upstream. Two community forks exist: `serde_yml` (Sebastien Rousseau) and `serde_yaml_ng` (community continuation). Both advertise drop-in replacement. PRD says "straight swap". Only used in `crates/intelligence` dev-deps.
**How to avoid:** C12. Pick the more actively maintained fork at execution time:
- `cargo search serde_yml` + `cargo search serde_yaml_ng` — compare latest release date and downloads
- Historical trend (as of training cutoff): `serde_yaml_ng` has been more actively maintained with cleaner swap semantics [ASSUMED — verify at exec time].
- Swap pattern: replace `serde_yaml = "0.9"` with `<chosen> = "<latest>"` + `use serde_yml as serde_yaml;` re-export if test code uses the `serde_yaml::` path, OR update test imports directly.
- Since this is dev-deps-only (no runtime impact), risk is isolated.
**Warning signs:** Compile errors in `crates/intelligence/tests/*` referencing `serde_yaml::`.
**Confidence:** LOW — [ASSUMED] fork activity status; verify at exec time.

### Pitfall 13: Lockfile regeneration timing
**What goes wrong:** Regenerating `pnpm-lock.yaml` or `Cargo.lock` per-edit inside a coordination group (e.g., bumping Tauri plugin 1 of 10, running install, bumping plugin 2, running install again) produces a noisy commit history and can surface transient resolver conflicts.
**How to avoid:** For each coordination group: edit ALL manifests first, run `pnpm install` / `cargo check` ONCE at end of group, then run verification gate, then commit. Lockfiles are regenerated ONCE per coordination group commit.
**Confidence:** HIGH — [VERIFIED] standard monorepo practice.

## Code Examples

### Pattern: Workspace Rust patch/minor bump (A1)

Edit `Cargo.toml` (workspace root) — single block, single commit:

```toml
# Cargo.toml [workspace.dependencies]
tokio = { version = "1.52", features = ["rt-multi-thread", "macros"] }
serde = { version = "1.0.228", features = ["derive"] }
serde_json = "1.0.149"
# ...every safe patch/minor per PRD A1 table
```

Then: `cargo check --workspace && cargo nextest run --workspace`.

### Pattern: JS coordinated group bump (B3 Tauri group)

All `@tauri-apps/*` packages across 4 manifests — edit all, then one `pnpm install`:

```jsonc
// apps/desktop/package.json
{
  "dependencies": {
    "@tauri-apps/api": "^2.10.1",
    "@tauri-apps/plugin-dialog": "^2.7.0",
    // ...every plugin
  }
}
```

Single `pnpm install` at repo root → single `pnpm-lock.yaml` diff.

### Pattern: Rusqlite 0.34 → 0.39 coordination (C6)

Edit workspace `Cargo.toml` + each member's `Cargo.toml`:

```toml
# Cargo.toml [workspace.dependencies]
rusqlite = { version = "0.39", features = ["bundled"] }
rusqlite_migration = "2.5"

# crates/storage/Cargo.toml → no version change needed if using `rusqlite = { workspace = true }`
```

Then `cargo check -p storage -p effects -p encoder -p storycapture` to collect ALL breakage at once; fix root-cause in one pass.

### Pattern: Biome 1 → 2 migration (D21)

```bash
# After bumping @biomejs/biome to 2.x in root package.json + pnpm install:
pnpm biome migrate --write
# Commit biome.json changes alongside the bump
pnpm biome check .
```

Expected `biome.json` diff: schema URL `1.9.4` → `2.x`, some rule ids renamed (Biome 2 migration tool handles automatically).

### Pattern: tauri-specta RC bump + regen (E27)

```bash
# 1. Edit apps/desktop/src-tauri/Cargo.toml: tauri-specta + specta + specta-typescript
# 2. Edit crates/story-parser/Cargo.toml: specta optional feature
# 3. Run existing IPC codegen script (per docs/ARCHITECTURE.md IPC section)
# 4. Inspect packages/shared-types/src/ipc.ts diff
# 5. Run turbo run typecheck to find consumer breakage
# 6. Fix consumers, then commit
```

## State of the Art

| Old Approach (pre-Phase 16) | Current Approach (post-Phase 16) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `serde_yaml` 0.9.34+deprecated | `serde_yml` or `serde_yaml_ng` | C12 | Dev-deps only; test-time behavior unchanged |
| `rusqlite` 0.34 | `rusqlite` 0.39 | C6 | API migration; no data format change |
| Biome 1.9.4 schema/rules | Biome 2.x schema/rules | D21 | Config migration via `biome migrate`; some rules renamed |
| Vite 6 + plugin-react 4 | Vite 8 + plugin-react 6 | D19 | Build toolchain upgrade; Tailwind v4 plugin compat required |
| TypeScript 5.7.x | TypeScript 6.x | D20 | Stricter default type-checking; existing `any`-free code should mostly pass |
| `objc2` 0.5 (capture) + 0.6 (encoder) | `objc2` 0.6 everywhere | C5 | Collapses duplicate-in-graph; unifies macOS FFI surface |
| CLAUDE.md refs `screencapturekit 1.70.x`, `windows-capture 1.5.x`, `objc2 0.5` | Docs reflect pinned `1.5.4`, `2.0`, `0.6` | E28 | Agent-facing doc drift corrected |

**Deprecated (must replace, do not restore):**
- `serde_yaml` — upstream marked deprecated.
- `@types/node 25` — not adopted in this phase (gated on Node floor change).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `cargo` (stable Rust) | All Rust bumps | ✓ (assumed — repo is active) | per `rust-toolchain.toml` | — |
| `cargo-nextest` | Per-commit gate | ✓ per CLAUDE.md tooling list | latest | `cargo test` fallback if nextest unavailable on CI runner |
| `pnpm` 9.x | All JS bumps | ✓ per `package.json` engines | 9.x | — |
| `turbo` 2.5.x | typecheck + build | ✓ per root `package.json` | 2.5.x | Fallback: per-workspace `pnpm typecheck`/`build` |
| `biome` 1.9.4 → 2.x | D21 migration | ✓ pre-bump (1.9.4); post-bump installed via bump | — | — |
| `prisma` CLI | E25 | ✓ per `apps/web/package.json` devDep | 6.x → 7.x | — |
| `@tauri-apps/cli` | B3 + E27 | ✓ | 2.x → 2.10.x | — |

**Missing dependencies with no fallback:** None (this phase uses the existing toolchain exclusively).

**Missing dependencies with fallback:** `cargo-nextest` — if a CI lane lacks it, fall back to `cargo test --workspace`.

## Risk Surface Inventory (per coordination group)

The single most valuable output for the planner: specific grep patterns and test targets that must pass for each risky group.

| Group | Grep pattern to audit before editing | Tests to run after bump |
|-------|---------------------------------------|--------------------------|
| C5 objc2 0.5→0.6 | `grep -rn "use objc2\|ClassType\|msg_send!\|Retained\|AnyObject\|NSString::from_str"` in `crates/capture/src/macos/`, `apps/desktop/src-tauri/src/` | `cargo check --target aarch64-apple-darwin -p capture -p storycapture`; macOS `cargo nextest -p capture --features real-capture` if available |
| C6 rusqlite 0.34→0.39 | `grep -rn "rusqlite::\|params!\|OptionalExtension\|prepare_cached\|Error::FromSqlConversionFailure"` in `crates/storage/`, `crates/effects/`, `crates/encoder/`, `apps/desktop/src-tauri/` | `cargo nextest -p storage -p effects -p encoder`; integration tests at `crates/storage/tests/` |
| C7 reqwest 0.12→0.13 | `grep -rn "reqwest::\|Client::builder\|bytes_stream\|ClientBuilder"` in `crates/intelligence/`, `apps/desktop/src-tauri/` | `cargo nextest -p intelligence` (wiremock-based provider probes at `crates/intelligence/tests/`); live-API streaming tests if `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` set |
| C8 sha2 0.10→0.11 | `grep -rn "sha2::\|Sha256::\|Digest::"` in `crates/util/`, `crates/intelligence/`, `apps/desktop/src-tauri/` | `cargo nextest -p util -p intelligence`; author-snapshot hashing tests |
| C9 scraper 0.20→0.26 | `grep -rn "scraper::\|Selector::parse\|Html::parse"` in `crates/automation/` | `cargo nextest -p automation`; author-time DOM validator tests |
| C10 nix 0.29→0.31 | `grep -rn "nix::\|mkfifo\|fcntl"` in `crates/capture/src/` (unix only) | `cargo check --target x86_64-unknown-linux-gnu -p capture` (fifo path); macOS build still green |
| C11 rand 0.8→0.10 | `grep -rn "rand::"` → **only `llm/retry.rs`** | `cargo nextest -p intelligence` (retry tests) |
| C11 schemars 0.8→1.x | `grep -rn "schemars::\|JsonSchema\|schema_for!"` in `crates/intelligence/` | `cargo nextest -p intelligence`; inspect `insta` snapshots for schema diff |
| C11 toml 0.8→1.x | `grep -rn "toml::\|toml::from_str\|toml::Deserializer"` in `crates/intelligence/` eval_report bin | `cargo nextest -p intelligence`; eval_report bin smoke run |
| C11 ts-rs 10→12 | `grep -rn "ts_rs\|#\\[derive.*TS"` in `crates/effects/`, `crates/story-parser/` | `cargo check --features ts-export -p effects -p story-parser`; regenerate TS types under `generated/` and diff |
| C11 tower 0.4→0.5 | `grep -rn "tower::\|tower::Service\|Layer"` in `crates/intelligence/` | `cargo nextest -p intelligence` |
| C12 serde_yaml | `grep -rn "serde_yaml::"` → `crates/intelligence/tests/` dev-deps | `cargo nextest -p intelligence --tests` |
| D15 zod 3→4 | `grep -rn "from \"zod\"\|z\\.object\|z\\.string\\(\\)\\.parse"` in `apps/web/` | `turbo run typecheck --filter=web`; `turbo run test --filter=web` |
| D16 jose 5→6 | `grep -rn "from \"jose\"\|jwtVerify\|createRemoteJWKSet"` in `apps/web/` | Desktop↔web auth smoke test if available |
| D19 Vite 6→8 | N/A (build tooling) | `turbo run build`; `pnpm --filter desktop dev` manual smoke |
| D20 TS 5→6 | N/A (repo-wide) | `turbo run typecheck` |
| D21 Biome 1→2 | N/A | `pnpm biome check .` |
| E24 Next 15→16 | `grep -rn "next.config\|export const revalidate\|unstable_cache"` in `apps/web/` | `turbo run build --filter=web`; `turbo run test --filter=web` |
| E25 Prisma 6→7 | `grep -rn "@prisma/client\|PrismaClient"` in `apps/web/` | `pnpm prisma generate`; `pnpm prisma migrate status`; `turbo run test --filter=web` |
| E26 windows 0.58→0.62 | `grep -rn "use windows::\|Direct3D11\|GraphicsCaptureItem"` in `crates/capture/src/windows/` | Windows CI build (if available); else defer verification to next Windows-gated phase |
| E27 tauri-specta RC | Diff `packages/shared-types/src/ipc.ts` | `turbo run typecheck`; desktop FE import checks |

## Validation Architecture

Per `.planning/config.json`, `workflow.nyquist_validation` is explicitly `false`. **Skipped per instruction.**

The per-commit gate in CONTEXT.md (`cargo check && cargo nextest && turbo run typecheck && turbo run build`) functions as the de facto validation for this phase.

## Security Domain

**Applicability:** Dependency upgrades have a narrow security surface — the concern is (1) not introducing known-vulnerable transitive deps, and (2) not weakening existing crypto/auth primitives.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (E22, D16) | `next-auth` v5 + `@auth/prisma-adapter` + `jose` 6 — ensure adapter peer-dep alignment; verify `jwtVerify` signature unchanged |
| V3 Session Management | yes (E22) | NextAuth session cookie semantics must not change silently with v5-beta bump |
| V4 Access Control | no direct change | — |
| V5 Input Validation | yes (D15) | `zod` 4 + tRPC 11 — verify validation behavior unchanged for existing routers |
| V6 Cryptography | yes (C8, D16) | `sha2` 0.11 digest API (author-snapshot hashing); `jose` 6 JWKS + JWT verification (auth token) — **NEVER hand-roll, both are standard libraries** |
| V14 Configuration | yes (phase-wide) | Run `cargo deny check advisories` after Phase C + Phase E; run `pnpm audit --audit-level=high` after Phase D + Phase E |

### Known Threat Patterns for dep-upgrade

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malicious transitive dep (supply chain) | Tampering | `cargo deny check bans advisories`; `pnpm audit` |
| Downgraded crypto primitive | Information Disclosure | Verify `sha2` 0.11 still offers SHA-256 at ≥128-bit security; verify `jose` 6 still defaults to secure JWT algos |
| Deprecated dep reintroduced | Tampering | Do NOT restore `serde_yaml`; replacement crate must be maintained (check last-publish date at C12) |
| Cached lockfile drift between machines | Tampering | Commit `pnpm-lock.yaml` + `Cargo.lock` with each coordination-group commit |

Security verification commands (run once at end of Phase C and once at end of Phase D/E):
```bash
cargo deny check advisories bans licenses
pnpm audit --audit-level=high
```

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `rusqlite` 0.34→0.39 has breaking API shifts per minor (`Transaction`, `ToSql`, `prepare_cached`) | Pitfall 1 | Surface breakage turns out smaller than estimated → C6 easier than planned (LOW risk of being wrong; best-case scenario) |
| A2 | `reqwest` 0.13 changes TLS feature gates + `bytes_stream` signature | Pitfall 2 | SSE streaming breaks at runtime in intelligence crate — caught by provider probe tests |
| A3 | `objc2` 0.5→0.6 removes `mutability::` traits + changes Retained model | Pitfall 3 | Larger capture-crate refactor than estimated → extend C5 timeline |
| A4 | `schemars` 1.0 derive macro + `JsonSchema` trait changed | Pitfall 5 | JSON Schema output string changes, breaks LLM prompts downstream |
| A5 | `serde_yaml_ng` more actively maintained than `serde_yml` | Pitfall 12 | Pick wrong fork; swap needs redo |
| A6 | Vite 7→8 has additional breaking changes beyond plugin-react 4→6 | Pitfall 7 | D19 needs extra fixing work |
| A7 | TS 6 tightens default strictness beyond `noUncheckedIndexedAccess` | Pitfall 8 | D20 needs larger fix-up |
| A8 | Next 15→16 changes RSC cache + middleware API | Pitfall 10 | E24 needs web refactor beyond dep bump |
| A9 | Prisma 7 preserves existing generated-client output path conventions | Pitfall 9 | E25 needs path migration |
| A10 | `eventsource-stream` 0.2.3 is compatible with `reqwest` 0.13 | Pitfall 2 | SSE path blocked until `eventsource-stream` publishes a compat release |
| A11 | tRPC 11.16 is compatible with Zod 4 | Pitfall 11 | D15 must be deferred until tRPC publishes Zod 4 support |
| A12 | `rusqlite_migration` 2.5.x supports `rusqlite` 0.39 | Pitfall 1 | C6 blocked until `rusqlite_migration` releases compat version |
| A13 | `tauri-specta`/`specta` 2.x-rc latest is newer than `rc.21`/`rc.22` at exec time | E27 | E27 no-op if not; otherwise bump happens |
| A14 | Biome 2 `migrate` command idempotently rewrites `biome.json` for the recommended-only config this repo uses | Pitfall, D21 | D21 may need manual rule-id renames |

**Action for planner/user:** each assumption above is a "verify at execution time, before committing the step" item. Most are re-verifiable via `cargo search` / `pnpm view` / reading the crate's CHANGELOG at the bump moment.

## Open Questions

1. **Should C11 (`tower`/`schemars`/`rand`/`toml`/`ts-rs`) be 5 separate commits or grouped?**
   - What we know: PRD says "one commit per crate"; each crate has isolated blast radius.
   - What's unclear: whether `schemars` + `ts-rs` could conflict (both touch `effects`/`intelligence` test serialization).
   - Recommendation: plan as 5 waves; re-evaluate at exec time if they can compose.

2. **`serde_yml` vs `serde_yaml_ng` — which fork?**
   - Recommendation: at C12 execution, run `cargo search serde_yml` + `cargo search serde_yaml_ng`, compare last-publish date + download counts, pick the more active one. Commit message should cite the comparison.

3. **`next-auth` v5-beta latest version?**
   - Recommendation: at E22 execution, run `pnpm view next-auth dist-tags` — if `beta > 5.0.0-beta.31`, bump; else skip E22 entirely (defer to later phase).

4. **Should `cargo-deny` / `pnpm audit` gates be added to the per-commit verification?**
   - Recommendation: run them ONCE at end of each Phase (A/B/C/D/E) rather than per-commit — per-commit would slow the gate and produce noisy transient advisory churn.

5. **How to handle macOS-only / Windows-only breakage on a runner that can't build both targets?**
   - Recommendation: Phase C5 (objc2 — macOS), C10 (nix — unix), E26 (windows — Windows-only) should call out in task actions that verification is best-effort on current runner and the next platform-CI run is the true gate. Explicitly document in plan.

## Sources

### Primary (HIGH confidence)
- `.planning/notes/deps-upgrade-plan.md` — PRD, audited 2026-04-21. Authoritative version table + coordination groups + execution order.
- `.planning/phases/16-upgrade-all-dependencies-to-latest-bump-every-js-ts-package-/16-CONTEXT.md` — locked user decisions derived from PRD.
- `CLAUDE.md` — committed-majors list, "What NOT to Use", risk flags, version-compatibility notes, "no workarounds" rule.
- `docs/ARCHITECTURE.md` — IPC codegen flow (`ipc_spec.rs` → `packages/shared-types/src/ipc.ts`), four trait boundaries touched by bumps (`BrowserDriver`, `CaptureBackend`, `LlmProvider`, `TtsProvider`).
- `docs/CONVENTIONS.md` — per-crate error enum, testing patterns (`cargo-nextest`, `insta` snapshots, real-hardware feature gates), commit style, lint/format.
- Repo grep evidence: `chromiumoxide` absent from every `Cargo.toml` (only in doc comments); `rand` usage limited to `rand::random::<u64>()` in `crates/intelligence/src/llm/retry.rs`; `schemars` + `JsonSchema` + `schema_for!` at `crates/intelligence/src/nl/schemas.rs` and `tts/script.rs`; `rusqlite` surfaces in `crates/storage/src/{app_db.rs,project_db.rs,phase3.rs}`.

### Secondary (MEDIUM confidence)
- `biome.json` — confirms Biome 1.9.4 + `recommended: true` rule policy (minimal custom rules → D21 migration is LOW friction).
- Cargo workspace pattern: `[workspace.dependencies]` already used for cross-crate version unification.

### Tertiary (LOW confidence — flagged in Assumptions Log)
- Training-knowledge of `rusqlite` 0.34→0.39 per-minor breaking changes (A1).
- Training-knowledge of `objc2` 0.5→0.6 retained-pointer model changes (A3).
- Training-knowledge of `schemars` 1.0 API reshape (A4).
- Training-knowledge of `rand` 0.9/0.10 API reshuffle (A1 "rand" note — but grep says only one call site, so impact is LOW regardless).
- Training-knowledge of Vite 7→8 / TS 5→6 / Next 15→16 / Prisma 6→7 change surfaces (A6, A7, A8, A9).

## Metadata

**Confidence breakdown:**
- Standard stack + plan decomposition: HIGH — PRD is authoritative and recent.
- Per-bump risk surfaces (grep patterns, test targets): HIGH — based on actual repo grep evidence.
- Per-bump API-diff specifics (what will break in `rusqlite`/`objc2`/`schemars`): MEDIUM — [ASSUMED] from training; verify at each step's execution.
- Gated framework majors (Next 16, Prisma 7, TS 6, Vite 8): LOW — generic assumptions; require reading each project's upgrade guide at execution time.

**Research date:** 2026-04-22
**Valid until:** 2026-05-22 (30 days — dep ecosystem churns; re-verify patch/minor targets via `pnpm view`/`cargo search` at execution time; RC/beta versions like `tauri-specta` and `next-auth` may move).
