---
phase: 16
name: upgrade-all-dependencies-to-latest
source: PRD (.planning/notes/deps-upgrade-plan.md)
gathered: 2026-04-22
status: Ready for planning
---

# Phase 16: Upgrade all dependencies to latest — Context

**Source:** PRD Express Path (`.planning/notes/deps-upgrade-plan.md`, audited 2026-04-21)

<domain>
## Phase Boundary

**In scope:**
- Bump every JS/TS npm package and Rust crate across the monorepo to its latest allowed version per PRD.
- Maintain all "committed major" constraints from CLAUDE.md (Tauri 2.x, React 19, Next 15, Tailwind v4, Zustand 5, TanStack Query 5, Motion 12, Prisma 6, NextAuth v5, tRPC 11, `screencapturekit` 1.5.4, etc.) unless the PRD explicitly authorizes a gated major bump.
- Keep all 15 coordinated bump groups locked together (Tauri, TanStack Query, tRPC, Prisma, AWS SDK, objc2 family, rusqlite group, pest group, reqwest, ts-rs, tauri-specta/specta, React, Vite toolchain, TypeScript, Biome).
- Update stale doc references in `CLAUDE.md` / `docs/ARCHITECTURE.md` (`screencapturekit` 1.70 → 1.5.4, `windows-capture` 1.5 → 2.0, `objc2` 0.5 → 0.6).
- Ensure each commit remains runnable: `cargo check && cargo nextest && turbo run typecheck && turbo run build` must pass before committing.

**Out of scope:**
- Adding new dependencies (only upgrades).
- Switching stacks (no replacing committed choices).
- Node runtime floor change (keep `engines.node >= 20`; `@types/node` stays on 22).
- `chromiumoxide` addition — listed in CLAUDE.md but absent from Cargo; defer investigation unless user confirms.
- Feature work, refactors, or cleanups unrelated to the upgrade.

**Success criteria:**
- Each of the 5 execution phases (A–E) lands as its own atomic commit group.
- Typespec IPC round-trip passes after any `tauri-specta` / `specta` bump.
- Provider probe + streaming tests pass after `reqwest` 0.12 → 0.13.
- `biome migrate` applied after Biome 1 → 2.
- Docs (`CLAUDE.md`, `docs/ARCHITECTURE.md`) reflect final versions.
- No regression in `turbo run typecheck`, `turbo run build`, `cargo nextest`, `turbo run test`.

</domain>

<decisions>
## Implementation Decisions (LOCKED from PRD)

### Execution order — 5 sequential phases, each commit must be green

**Phase A: Safe patch/minor-only (no API surface risk)**

A1. One commit bumping all workspace Rust patch/minor-only crates listed in PRD §"Phase A step 1". Verify: `cargo nextest` across workspace.
A2. Per-workspace commits for safe npm patch/minor packages:
   - `apps/desktop`: TanStack Query, Tauri plugins minor bumps, `motion`, `zustand`, react patch, `@types/react*`, `tailwindcss`, `@tailwindcss/vite`, `cmdk`, etc. (sonner deferred to Phase D).
   - `apps/web`: AWS SDK, `geoip2-node`, `superjson`, `@auth/prisma-adapter`, `tsx`, `@tailwindcss/postcss`, `tailwindcss`.
   - `packages/ui`, `packages/shared-types`, `scripts/playwright-sidecar` (`playwright-core`), `scripts/notarize/smoke-app` (`@tauri-apps/cli`).

**Phase B: Coordinated non-breaking bumps**

B3. Tauri group commit: Rust `tauri*` 2.x → 2.10.x + JS `@tauri-apps/*` 2.x latest + `@tauri-apps/cli`. Touches desktop host + smoke-notarize + desktop frontend + shared-types.
B4. Playwright sidecar: bump `vitest` 2 → 4 to unify with repo-wide Vitest 4.

**Phase C: Coordinated 0.x breaking bumps (one commit per group)**

C5. `objc2` family 0.5 → 0.6 (workspace + desktop host + capture) — aligns with encoder. Test both platforms.
C6. `rusqlite` 0.34 → 0.39 across `src-tauri`, `storage`, `effects`, `encoder`. Regenerate migrations; run storage integration tests.
C7. `reqwest` 0.12 → 0.13 in `src-tauri` + `intelligence`. Re-exercise provider probes + streaming tests.
C8. `sha2` 0.10 → 0.11 in `util` + `intelligence` + `src-tauri` (author snapshot hashing).
C9. `scraper` 0.20 → 0.26 in `automation`; run author-time DOM validator tests.
C10. `nix` 0.29 → 0.31 in `capture` (unix audio fifo); verify mkfifo path.
C11. One commit per crate: `tower` 0.4 → 0.5, `schemars` 0.8 → 1.x, `rand` 0.8 → 0.10, `toml` 0.8 → 1.x, `ts-rs` 10 → 12 (effects + story-parser lockstep).
C12. Replace deprecated `serde_yaml` with `serde_yml` (or `serde_yaml_ng`) in intelligence dev-deps.

**Phase D: JS major bumps (each needs pass/fail verification before next)**

D13. `tailwind-merge` 2 → 3 (desktop + ui lockstep).
D14. Per-package commits: `sonner` 1 → 2, `cmdk` patch, `react-resizable-panels` 2 → 4, `react-hotkeys-hook` 4 → 5, `lucide-react` 0.460 → 1.x. Rerun component tests.
D15. `zod` 3 → 4 (web) — coordinate with tRPC input validators.
D16. `jose` 5 → 6 (web) — token verification; re-test desktop↔web auth flow.
D17. `pino` 9 → 10 + `pino-pretty` 11 → 13 (web).
D18. `resend` 4 → 6 (web).
D19. `vite` 6 → 8 + `@vitejs/plugin-react` 4 → 6 + verify Tailwind v4 plugin compatibility (desktop + ui).
D20. `typescript` 5 → 6 across root + 5 workspaces. Run `turbo run typecheck` repo-wide.
D21. Biome 1 → 2. Run `biome migrate`, commit `biome.json` changes.

**Phase E: Gated framework majors**

E22. `next-auth`: confirm v5 beta latest via `npm view next-auth dist-tags`; bump if published version > current `5.0.0-beta.31`.
E23. `@types/node` 22 → 25: SKIP (PRD defers; Node floor unchanged).
E24. **Next 15 → 16** (web) — review App Router breaking changes + RSC cache; `@prisma/client` stays on 6 until E25.
E25. **Prisma 6 → 7** (web) — client + CLI + adapter lockstep. Regenerate migrations / client output.
E26. **`windows` 0.58 → 0.62** (capture + workspace) — collapse version duplication; retest WGC backend.
E27. **`tauri-specta` / `specta` RC bump** — move to current 2.x-rc; regenerate `packages/shared-types/src/ipc.ts`.
E28. **Docs sync**: update `CLAUDE.md` + `docs/ARCHITECTURE.md` to reflect `screencapturekit` pinned 1.5.4, `windows-capture` 2.0, `objc2` 0.6, any new final pins from this phase.

### Coordination Groups (atomic — move together in ONE commit)

1. Tauri group (Rust `tauri*` + JS `@tauri-apps/*`).
2. TanStack Query + Devtools across desktop + web.
3. tRPC `server` + `client` + `tanstack-react-query`.
4. Prisma `prisma` (CLI) + `@prisma/client`.
5. AWS SDK `client-s3` + `s3-request-presigner`.
6. `objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-av-foundation`, `objc2-core-media`, `objc2-core-video`.
7. `rusqlite` across `src-tauri`, `storage`, `effects`, `encoder`.
8. `pest` + `pest_derive`.
9. `reqwest` in `src-tauri` + `intelligence`.
10. `ts-rs` in `effects` + `story-parser`.
11. `tauri-specta` + `specta` + `specta-typescript` + `story-parser` specta feature.
12. React: `react` + `react-dom` + `@types/react` + `@types/react-dom` across desktop + web + ui.
13. Vite toolchain: `vite` + `@vitejs/plugin-react` + `@tailwindcss/vite` + `tailwindcss` + `@tailwindcss/postcss` + `@vitest/ui` + `vitest`.
14. TypeScript: single repo-wide 5 → 6 across 6 manifests.
15. Biome: single root devDep; `biome migrate` touches `biome.json` repo-wide.

### Do NOT bump (deliberate pins from CLAUDE.md / PRD)

- `screencapturekit =1.5.4` — leave untouched (MEDIUM risk flag).
- `chromiumoxide` — not currently in any `Cargo.toml`; do not add as part of this phase.
- `@types/node` 22 → 25 — blocked unless Node runtime floor raised (out of scope).
- Committed majors from CLAUDE.md remain untouched unless explicitly authorized in Phase D/E above.

### Per-commit verification gate (MANDATORY)

Every commit in this phase must pass before being committed:
```
cargo check && cargo nextest && turbo run typecheck && turbo run build
```

If web-specific changes: also run `turbo run test --filter=web`.
If desktop frontend: `pnpm --filter desktop test`.
After IPC/typespec bumps: regenerate `packages/shared-types/src/ipc.ts` and verify round-trip.

### Commit message convention

Follow CLAUDE.md: `type(scope): subject`.
- `scope` = phase-plan id (`16-A1`, `16-B3`) or specific crate (`16-C6-rusqlite`).
- `type` = `chore` for safe bumps, `refactor` for coordinated API-surface bumps, `feat` only if a bump enables new behavior that must be adopted.
- Never add `Co-Authored-By` trailers.

### Risky items requiring extra care (per PRD §"Risky / needs review")

- `tauri-specta` + `specta` RC — verify typespec codegen round-trip passes (IPC contract) before committing.
- `objc2` 0.5 → 0.6 — touches every Obj-C FFI site in capture's SCK backend.
- `rusqlite` 0.34 → 0.39 — 5 minor jumps w/ breaking APIs each; verify `rusqlite_migration` 2.x compat.
- `reqwest` 0.12 → 0.13 — test Anthropic/OpenAI SSE streams in intelligence crate.
- `rand` 0.8 → 0.10 — massive API reshuffle (rng traits, `thread_rng` gone).
- `schemars` 0.8 → 1.x — breaking derive macro changes in intelligence.
- `windows` 0.58 → 0.62 — WGC-surface breaking change; resolves transitive duplication from `windows-capture`.
- `@base-ui-components/react` beta.6 → rc.0 — API could shift before 1.0.0 stable; lockstep desktop + ui.

### Claude's Discretion (PRD doesn't prescribe)

- Exact plan decomposition (how many PLAN.md files map to steps A1..E28) — planner may group where sensible (e.g., one PLAN per phase A/B/C/D/E, or finer splits).
- Wave/parallelization within each phase (e.g., C5–C12 could parallelize where commit boundaries permit).
- How to structure `must_haves` for goal-backward verification.
- Choice between `serde_yml` vs `serde_yaml_ng` for C12 — pick the more actively-maintained fork with the cleanest swap (PRD says "straight swap").

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents (researcher, planner, checker) MUST read these before planning or implementing.**

### Source PRD
- `.planning/notes/deps-upgrade-plan.md` — the authoritative audit and execution plan for this phase.

### Project committed-stack constraints
- `CLAUDE.md` — committed majors, "What NOT to Use", risk flags, version compatibility notes.
- `docs/ARCHITECTURE.md` — cross-crate flows and trait boundaries that may be affected by bumps (especially objc2, rusqlite, reqwest).
- `docs/CONVENTIONS.md` — lint/format (Biome), testing (cargo-nextest, Vitest), commit style.
- `docs/DOMAIN.md` — capture/encoder backends, intelligence providers — relevant for `objc2`, `windows`, `reqwest`, `schemars`, `rand` bumps.

### Workspace manifests (audited in PRD, must be touched by plans)
- `package.json` (root)
- `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`
- `apps/web/package.json`
- `packages/config/package.json`, `packages/shared-types/package.json`, `packages/story-dsl/package.json`, `packages/ui/package.json`
- `scripts/playwright-sidecar/package.json`
- `scripts/notarize/smoke-app/package.json`, `scripts/notarize/smoke-app/src-tauri/Cargo.toml`
- `Cargo.toml` (workspace root)
- `crates/automation/Cargo.toml`, `crates/capture/Cargo.toml`, `crates/effects/Cargo.toml`, `crates/encoder/Cargo.toml`, `crates/intelligence/Cargo.toml`, `crates/storage/Cargo.toml`, `crates/story-parser/Cargo.toml`, `crates/util/Cargo.toml`
- `tools/e2e-playwright-capture/Cargo.toml`

### Lockfiles (MUST be regenerated per commit group)
- `pnpm-lock.yaml`
- `Cargo.lock`

</canonical_refs>

<specifics>
## Specific Ideas

- Expected bump counts from PRD: ~18 patch, ~60 minor, ~33 major (gated), ~62 already-latest.
- PRD provides per-package target versions in the manifest-by-manifest tables — planner should extract the target version for each package into task actions (no guessing).
- For Biome 1 → 2: the migrate command is `biome migrate`, output must be committed.
- For Prisma 6 → 7: regenerate client output path per `apps/web` Prisma config.
- For `tauri-specta`: post-bump, regenerate `packages/shared-types/src/ipc.ts` via existing script (per `docs/ARCHITECTURE.md` IPC section).

</specifics>

<deferred>
## Deferred Ideas

- `chromiumoxide` addition — CLAUDE.md lists it but no Cargo.toml references it; tracking deferred to a separate phase once user confirms intent.
- `@types/node` 22 → 25 — gated on a separate Node runtime floor decision, not part of this phase.
- `next-auth` v5 beta bump is conditional: only if `npm view next-auth dist-tags` shows a newer beta than `5.0.0-beta.31`; otherwise skip.

</deferred>

---

*Phase: 16-upgrade-all-dependencies-to-latest*
*Context gathered: 2026-04-22 via PRD Express Path*
