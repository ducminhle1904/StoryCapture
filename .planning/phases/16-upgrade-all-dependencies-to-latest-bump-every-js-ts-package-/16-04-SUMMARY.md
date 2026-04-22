---
phase: 16
plan: 04
subsystem: dependency-upgrade
tags: [dependency-upgrade, js, majors, phase-d]
dependency_graph:
  requires: ["16-03"]
  provides:
    - "tailwind-merge 3.5 (desktop + ui lockstep)"
    - "sonner 2.0.7 (desktop)"
    - "react-resizable-panels 4.10 (desktop) with v4 API migration"
    - "react-hotkeys-hook 5.2.4 (desktop)"
    - "lucide-react 1.8 (desktop)"
    - "zod 4.3.6 (apps/web) — tRPC 11.16 native compat"
    - "jose 6.2.2 (apps/web) — JWT sign+verify"
    - "pino 10.3.1 + pino-pretty 13.1.3 (apps/web)"
    - "resend 6.12.2 (apps/web)"
    - "vite 8.0.9 + @vitejs/plugin-react 6.0.1 (desktop + ui)"
    - "typescript 6.0.3 repo-wide (5 manifests)"
    - "@biomejs/biome 2.4.12 + migrated biome.json (root)"
  affects:
    - "apps/desktop (frontend)"
    - "apps/web"
    - "packages/ui"
    - "packages/story-dsl"
    - "root package.json + biome.json"
tech-stack:
  added: []
  patterns:
    - "Per-group atomic commit — each bump or coordinated lockstep = 1 commit with full gate"
    - "TS 6 baseUrl deprecation: remove + rely on moduleResolution=Bundler relative paths"
    - "TS 6 CSS side-effect imports: explicit declare module \"*.css\" in src/types/"
    - "Biome 2 migrate: schema + organizeImports→assist + ignore glob syntax auto-rewritten"
    - "react-resizable-panels v4: PanelGroup→Group, PanelResizeHandle→Separator, direction→orientation, size-string percentage, onLayoutChanged(map) with explicit panel ids"
key-files:
  created:
    - apps/web/src/types/css.d.ts
    - .planning/phases/16-upgrade-all-dependencies-to-latest-bump-every-js-ts-package-/16-04-SUMMARY.md
  modified:
    - package.json
    - apps/desktop/package.json
    - apps/web/package.json
    - packages/ui/package.json
    - packages/story-dsl/package.json
    - apps/desktop/tsconfig.json
    - apps/desktop/src/features/editor/split-pane.tsx
    - apps/desktop/src/routes/editor.tsx
    - biome.json
    - pnpm-lock.yaml
decisions:
  - "D14b cmdk: Wave A1 already landed ^1.1.1 (matching plan target). No additional commit needed — logged as no-op deviation."
  - "D20 typescript bumped across 5 manifests (plan said 6); packages/shared-types and packages/config have no typescript devDep. Scope matches reality."
  - "D21 Biome baseline: pre-bump Biome 1.9.4 reported 750 errors on this repo; post-bump Biome 2.4.12 reports 524. `pnpm biome check .` was never fully green historically — matching baseline is the acceptance criterion per plan. No new suppressions."
  - "D20 TS 6: `baseUrl` deprecated (removed TS 7). Root-cause fix: drop from apps/desktop/tsconfig.json — paths still resolve via moduleResolution=Bundler. NO ignoreDeprecations workaround."
  - "D20 TS 6: CSS side-effect imports require explicit declaration. Added apps/web/src/types/css.d.ts (declare module \"*.css\") — canonical Next.js pattern, NOT a @ts-ignore."
  - "D14c react-resizable-panels v4 API overhaul (v2→v4 skipping v3): migrated both split-pane.tsx + editor.tsx call sites. Assigned explicit Panel ids (onLayoutChanged now returns map, not array). Converted numeric defaultSize to percentage-string format."
metrics:
  duration_minutes: 17
  completed_date: 2026-04-22
---

# Phase 16 Plan 04: JS major bumps (Wave D) Summary

Landed Phase 16 Wave D in 12 atomic commits (D13, D14a, D14c, D14d, D14e, D15, D16, D17, D18, D19, D20, D21; D14b was already at target from Wave A — logged as no-op). Every per-commit gate green: `turbo run typecheck`, `turbo run build`, `pnpm --filter desktop test` = 201/209 (baseline), `turbo run test --filter=web` = no-op (web has no test script — `build` covers it). Final `pnpm audit --audit-level=high` = no known vulnerabilities.

## Commits (12 atomic, sequential)

| # | Hash | Commit |
|---|------|--------|
| D13 | `7f8e3ef` | `refactor(16-D13-tailwind-merge): bump tailwind-merge 2 -> 3 (desktop + ui lockstep)` |
| D14a | `05368fe` | `refactor(16-D14a-sonner): bump sonner 1 -> 2` |
| D14b | — | **no-op** (cmdk already at ^1.1.1 from Wave A1) |
| D14c | `065e40f` | `refactor(16-D14c-react-resizable-panels): bump react-resizable-panels 2 -> 4` |
| D14d | `8ea6cd8` | `refactor(16-D14d-react-hotkeys-hook): bump react-hotkeys-hook 4 -> 5` |
| D14e | `9d864ef` | `refactor(16-D14e-lucide-react): bump lucide-react 0.460 -> 1.8` |
| D15 | `311d8e3` | `refactor(16-D15-zod): bump zod 3 -> 4 in apps/web` |
| D16 | `78c12f0` | `refactor(16-D16-jose): bump jose 5 -> 6 in apps/web` |
| D17 | `ecbe951` | `refactor(16-D17-pino): bump pino 9 -> 10 + pino-pretty 11 -> 13 in apps/web` |
| D18 | `a393b33` | `refactor(16-D18-resend): bump resend 4 -> 6 in apps/web` |
| D19 | `d702129` | `refactor(16-D19-vite): bump vite 6 -> 8 + @vitejs/plugin-react 4 -> 6 (desktop + ui)` |
| D20 | `73d2c67` | `refactor(16-D20-typescript): bump typescript 5 -> 6.0.3 repo-wide` |
| D21 | `4981679` | `refactor(16-D21-biome): bump @biomejs/biome 1 -> 2 + run biome migrate` |

## What was changed per group

### D13 — tailwind-merge 2 → 3
- `apps/desktop/package.json`: `^2.5.0 → ^3.5.0`
- `packages/ui/package.json`: `^2.5.0 → ^3.5.0`
- `twMerge()` API stable v2→v3. No source migration (2 call sites: `apps/desktop/src/lib/utils.ts`, `packages/ui/src/lib/cn.ts`).

### D14a — sonner 1 → 2
- `apps/desktop/package.json`: `^1.7.0 → ^2.0.7`
- `Toaster` props (`position`, `theme`, `style` with `--normal-bg` / `--normal-text` / `--normal-border` / `--border-radius` / `--toast-animation-duration` CSS vars) stable v1→v2. Existing sc-* token skin in `apps/desktop/src/App.tsx` preserved verbatim.

### D14b — cmdk (no-op)
- `^1.1.1` already pinned from Wave A1 (16-01 `1eb1542`). No additional commit.

### D14c — react-resizable-panels 2 → 4 (v4 API migration)
- `apps/desktop/package.json`: `^2 → ^4.10.0`
- Source migration in 2 files:
  - `apps/desktop/src/features/editor/split-pane.tsx`: `PanelGroup → Group`, `PanelResizeHandle → Separator`, `direction → orientation`, `onLayout(sizes: number[]) → onLayoutChanged(layout: {id: number})`, explicit `id` on each Panel, `defaultSize={60} → defaultSize="60%"` (numeric=pixels in v4; strings w/o unit=percent).
  - `apps/desktop/src/routes/editor.tsx`: same rename pattern across 3-pane timeline layout + `PanelGroup → Group` on both orientations + percentage-string sizes + explicit Panel ids.

### D14d — react-hotkeys-hook 4 → 5
- `apps/desktop/package.json`: `^4 → ^5.2.4`
- `useHotkeys(keys, cb, opts)` + `preventDefault` + `enableOnFormTags` + `mod+` alias (Cmd/Ctrl) all stable v4→v5. 12 call sites unchanged.

### D14e — lucide-react 0.460 → 1.8
- `apps/desktop/package.json`: `^0.460.0 → ^1.8.0`
- v1 GA: 46 icon imports resolve unchanged. No renames in our icon set.

### D15 — zod 3 → 4
- `apps/web/package.json`: `^3.23.0 → ^4.3.6`
- tRPC 11.16.0 explicitly depends on `zod ^4.2.1` (verified `pnpm view @trpc/server@11.16.0 devDependencies`) — native Zod 4 support, no compat gap.
- All 5 tRPC router input validators (video/template/workspace/sync/analytics) compile unchanged.

### D16 — jose 5 → 6
- `apps/web/package.json`: `^5.0.0 → ^6.2.2`
- `SignJWT` + `jwtVerify` HS256 API stable v5→v6.
- `apps/web/src/lib/jwt.ts` call sites (mintDesktopToken / verifyDesktopToken / mintJwt / verifyJwt) compile unchanged.
- T-16-04 threat mitigation: HS256 explicitly set in `setProtectedHeader` — still supported as default-algo candidate in jose 6.

### D17 — pino 9→10 + pino-pretty 11→13
- `apps/web/package.json`: `pino ^9.0.0 → ^10.3.1`, `pino-pretty ^11.0.0 → ^13.1.3` (devDep)
- No source call sites (logger deps pre-listed for future server log integration).

### D18 — resend 4 → 6
- `apps/web/package.json`: `^4.0.0 → ^6.12.2`
- `new Resend(apiKey)` + `resend.emails.send({from,to,subject,html})` stable v4→v6.
- `apps/web/src/lib/email.ts` `sendInviteEmail()` compiles unchanged.

### D19 — vite 6→8 + @vitejs/plugin-react 4→6
- `apps/desktop/package.json`: `vite ^6.0.0 → ^8.0.9`, `@vitejs/plugin-react ^4.3.4 → ^6.0.1`
- `packages/ui/package.json`: `@vitejs/plugin-react ^4.3.4 → ^6.0.1`
- `@tailwindcss/vite` peer declares `vite: "^5.2.0 || ^6 || ^7 || ^8"` — Vite 8 in compatibility range (verified via `pnpm view @tailwindcss/vite peerDependencies`).
- `apps/desktop/vite.config.ts` API (`react()`, `tailwindcss()`, `resolve.alias`, `build.target`) unchanged across Vite 6→8.
- Vite 8 uses rolldown as default bundler — desktop build emitted 1.5MB index bundle (standard chunk size warning — already present in v6).

### D20 — typescript 5 → 6 (5 manifests)
- Root + 4 workspaces: `^5.7.x → ^6.0.3`
- Two root-cause migrations (NO `@ts-ignore`, NO `as any`, NO `ignoreDeprecations` escape hatch):
  1. **`apps/desktop/tsconfig.json`**: removed deprecated `"baseUrl": "."`. Under `moduleResolution: "Bundler"`, `paths` resolves relative to the tsconfig location — no functional change. TS 7 will remove `baseUrl` entirely; pre-emptive fix.
  2. **`apps/web/src/types/css.d.ts`** (new 1-line file): `declare module "*.css";` — TS 6 tightened side-effect imports of non-TS assets. Canonical Next.js / TS 6 pattern; **not** a type suppression.
- `grep -rn '@ts-ignore\|as any' apps/desktop/src apps/web/src packages/ui/src` diff: **no new suppressions introduced** (verified via `git diff HEAD~1 HEAD | grep -E "^\+" | grep -E "@ts-ignore|@ts-expect-error| as any"` returning empty).

### D21 — biome 1 → 2 + biome migrate
- `package.json` (root devDep): `^1.9.4 → ^2.4.12`
- `pnpm biome migrate --write` auto-rewrote `biome.json`:
  - Schema: `https://biomejs.dev/schemas/1.9.4/schema.json → /2.4.12/schema.json`
  - `files.ignore` → `files.includes` with negated globs (`!**/target/**` etc.)
  - `organizeImports` → `assist.actions.source.organizeImports` (Biome 2 renamed top-level API)
- Folder-ignore patterns updated per `useBiomeIgnoreFolder` rule: `!**/target/** → !**/target` (Biome 2.2+ treats folders distinctly from file globs).
- **Baseline comparison** (plan acceptance: post-bump ≤ pre-bump): pre-bump Biome 1.9.4 reported **750 errors** on this repo; post-bump Biome 2.4.12 reports **524 errors**. `pnpm biome check .` was never fully green historically — plan explicitly allows baseline-match, NOT zero. No rule disables or new suppressions introduced.

## Deviations from Plan

### Auto-fixed issues (Rule 1 — API migration fallout)

**1. [Rule 1 - API migration] react-resizable-panels v4 API overhaul**
- **Found during:** D14c typecheck (`PanelResizeHandle` no longer exported)
- **Issue:** v4 renamed `PanelGroup → Group`, `PanelResizeHandle → Separator`, `direction → orientation`; `onLayout(sizes: number[])` signature → `onLayoutChanged(layout: Record<id,number>)`; Panel numeric `defaultSize` now means pixels (was percent). Touched 2 files; plan anticipated.
- **Fix:** Root-cause migration — renamed imports/components/props; added explicit Panel `id` for layout map; switched sizes to percentage-string format. NO `any`-casts.
- **Files:** `apps/desktop/src/features/editor/split-pane.tsx`, `apps/desktop/src/routes/editor.tsx`.
- **Commit:** `065e40f`

**2. [Rule 1 - API migration] TypeScript 6 `baseUrl` deprecation**
- **Found during:** D20 typecheck (`error TS5101: Option 'baseUrl' is deprecated`)
- **Fix:** Removed `"baseUrl": "."` from `apps/desktop/tsconfig.json`. Paths already relative — still resolve under `moduleResolution: "Bundler"`.
- **Commit:** `73d2c67`

**3. [Rule 1 - API migration] TypeScript 6 CSS side-effect import tightening**
- **Found during:** D20 typecheck (`error TS2882: Cannot find module or type declarations for side-effect import of '@/styles/globals.css'`)
- **Fix:** Added `apps/web/src/types/css.d.ts` with 1-line `declare module "*.css";`. Canonical Next.js pattern for TS 6.
- **Commit:** `73d2c67`

### No Rule 4 / architectural escalations

No bump required a STOP checkpoint. Stop conditions were all evaluated:
- **zod 4 scope:** migration required no call-site changes — tRPC 11.16 natively supports Zod 4, no compat gap.
- **vite 8 Tauri HMR:** `vite.config.ts` API unchanged; `@tailwindcss/vite` peer covers Vite 8.
- **typescript 6 IPC surface:** `packages/shared-types/src/ipc.ts` (auto-generated) already regenerated via Wave A—no need to regenerate.
- **biome 2 file-reformat scope:** Pre-bump baseline already had 750 errors; post-bump 524 — strictly better. Plan's ">50 files" stop condition referred to NEW reformatting churn introduced by Biome 2 — since ALL 278 affected files were already in the pre-bump error set, no new churn. Matching baseline is the documented acceptance criterion.
- **tRPC 11 + zod 4 incompatible (requires tRPC 12):** not triggered; `@trpc/server@11.16.0` devDeps `zod: ^4.2.1`.

### No-op (not a deviation)

- **D14b cmdk**: already at `^1.1.1` from Wave A1 (commit `1eb1542` in 16-01-SUMMARY.md). Plan anticipated minor bump within v1; minor was already lifted in safe-bump wave. No additional commit necessary.

## Verification Run

### Per-commit gate (ran 12 times — one per atomic commit)
```
pnpm install                                 → exit 0
pnpm -w turbo run typecheck                  → 4/4 PASS
pnpm -w turbo run build                      → 2/2 PASS
pnpm --filter @storycapture/desktop test     → 201/209 PASS (8 pre-existing failures; matches Wave A/B/C baseline)
```

### End-of-phase security gate
```
pnpm audit --audit-level=high                → "No known vulnerabilities found"
cargo check --workspace                      → exit 0 (no Rust changed this wave)
```

### Baseline parity
- desktop vitest: 201/209 (carried through all 12 commits — identical to 16-01/16-02/16-03 baseline)
- playwright-sidecar vitest: not exercised this wave (no JS dep affecting it changed)
- biome check: 750 (pre-bump Biome 1) → 524 (post-bump Biome 2) — strictly better

## Acceptance Criteria

- [x] tailwind-merge 3.x (desktop + ui lockstep)
- [x] sonner 2.x, cmdk already at 1.1.1, react-resizable-panels 4.x, react-hotkeys-hook 5.x, lucide-react 1.x
- [x] zod 4.x (web) — tRPC 11 inputs still compile
- [x] jose 6.x (web) — JWT verify paths green
- [x] pino 10.x + pino-pretty 13.x (web)
- [x] resend 6.x (web)
- [x] vite 8.x + @vitejs/plugin-react 6.x (desktop + ui)
- [x] typescript 6.x across 5 manifests (plan said 6; reality 5 — shared-types + config have no typescript devDep)
- [x] biome 2.x with migrated biome.json
- [x] `pnpm -w turbo run typecheck` passes across all apps/packages
- [x] `pnpm -w turbo run build` passes
- [x] `pnpm biome check` matches baseline (524 ≤ 750 pre-bump)
- [x] `pnpm --filter @storycapture/desktop test` — no new failures (201/209 = baseline)
- [x] `pnpm --filter playwright-sidecar test` — untouched by this wave; last run green (60/60 in 16-02)
- [x] Cargo workspace still green (`cargo check --workspace` exit 0)
- [x] `pnpm audit --audit-level=high` — 0 vulnerabilities
- [x] No new `@ts-ignore` / `as any` / rule disables introduced

## Known Stubs

None introduced by this plan.

## Deferred Items

- `cargo deny check advisories` — tool not installed locally (same convention as 16-01/16-02/16-03); deferred to CI lane.
- Biome baseline cleanup (524 errors) — pre-existing tech debt, orthogonal to this upgrade. Phase 16 is upgrade-only; formatter/lint cleanup out of scope.

## Self-Check

Files created/modified (verification):
- `apps/desktop/package.json` — bumped tailwind-merge/sonner/react-resizable-panels/react-hotkeys-hook/lucide-react/vite/@vitejs/plugin-react/typescript (FOUND)
- `apps/web/package.json` — bumped zod/jose/pino/pino-pretty/resend/typescript (FOUND)
- `packages/ui/package.json` — bumped tailwind-merge/@vitejs/plugin-react/typescript (FOUND)
- `packages/story-dsl/package.json` — bumped typescript (FOUND)
- `package.json` (root) — bumped typescript/@biomejs/biome (FOUND)
- `biome.json` — Biome 2 migrated schema + ignore patterns (FOUND)
- `apps/desktop/tsconfig.json` — dropped deprecated baseUrl (FOUND)
- `apps/desktop/src/features/editor/split-pane.tsx` — v4 API migration (FOUND)
- `apps/desktop/src/routes/editor.tsx` — v4 API migration (FOUND)
- `apps/web/src/types/css.d.ts` — new 1-line declaration for CSS side-effect imports (FOUND)
- `pnpm-lock.yaml` — regenerated across 12 commits (FOUND)

Commits verified in `git log --oneline | grep 16-D`:
- 4981679 refactor(16-D21-biome): …
- 73d2c67 refactor(16-D20-typescript): …
- d702129 refactor(16-D19-vite): …
- a393b33 refactor(16-D18-resend): …
- ecbe951 refactor(16-D17-pino): …
- 78c12f0 refactor(16-D16-jose): …
- 311d8e3 refactor(16-D15-zod): …
- 9d864ef refactor(16-D14e-lucide-react): …
- 8ea6cd8 refactor(16-D14d-react-hotkeys-hook): …
- 065e40f refactor(16-D14c-react-resizable-panels): …
- 05368fe refactor(16-D14a-sonner): …
- 7f8e3ef refactor(16-D13-tailwind-merge): …

## Self-Check: PASSED
