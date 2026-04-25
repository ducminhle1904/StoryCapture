# StoryCapture Agent Guide

Lean entrypoint for coding agents. Keep this file short and push detail into
read-on-demand docs.

## Project

StoryCapture turns a written `.story` script into a polished demo video.

- Desktop app: Tauri v2 + React 19 + Vite 8 on macOS and Windows.
- Core loop: author DSL → automate a real browser → capture native pixels →
  encode → apply cinematic post-production → optionally upload/share via the
  web companion.
- Web companion: Next.js 16 + tRPC 11 + Prisma 6 + R2/S3 for sharing,
  workspaces, analytics, and desktop sync.

## Current Repo Reality (refreshed 2026-04-25)

- Desktop routes: `/`, `/onboarding`, `/settings`, `/editor/:projectId`,
  `/recorder/:projectId`, `/post-production`, `/post-production/:storyId`,
  `/region-overlay`.
- Tauri IPC surface is ~26 modules / 70+ commands (system, automation,
  picker, author_snapshot, app_settings, audio, capture, region_overlay,
  encode, parse, projects, render, export, preset, timeline, sound_library,
  updater, keys, dryrun, simulator, lsp, nl, tts, upload, web_account,
  web_sync). Single source of truth: `apps/desktop/src-tauri/src/ipc_spec.rs`
  via tauri-specta — generated TS lands in `packages/shared-types/src/ipc.ts`
  (never hand-edited).
- Domain crates active and non-trivial: `story-parser`, `automation`,
  `capture`, `encoder`, `effects`, `storage`, `intelligence`, `util`.
  No `crates/gpu_scale/` yet (Phase 8 still planned).
- Picker has been relocated to the Preview panel (Phase 11 code-complete,
  flipped 2026-04-23): drives author-session via `picker_start_author`,
  reads `.story` + `.story.targets.json` only, FSM-routed cancel and
  one-click re-pick from a failed simulator step.
- Author-time simulator (Phase 10) ships with filmstrip scrubber, step
  decoration, pause/step events, Promote-to-fallback gate, and editor
  read-only lock during runs.
- Logging was overhauled (commit `a8e78b6`): `tracing` + size-rolling files,
  per-run session UUID prefix, `log_from_frontend` IPC bridge, ~95
  `#[tracing::instrument(err)]` wrappers, configurable from Settings →
  Logs. All local-only — no telemetry.
- `packages/ui` ships shared tokens plus the `claude-design` namespace and
  10 `Sc*` primitives (Button/Input/Badge/Switch/Card/Kbd/Slider/Select/
  Segmented + tests). Tailwind v4 `@theme` block is canonical.
- Web companion runs Next.js 16 + tRPC 11 + Prisma 6, NextAuth v5
  (5.0.0-beta.31), GitHub + Google OAuth, R2 multipart upload, Resend
  invites, Vercel cron analytics aggregation.
- Live project status is `.planning/STATE.md`. Treat `.planning/PROJECT.md`
  and `.planning/REQUIREMENTS.md` as historical planning artifacts unless
  explicitly refreshed.

## Source Of Truth

Read only what the task needs.

1. `docs/ARCHITECTURE.md`
   Use for repo layout, crate ownership, IPC, route surfaces, web APIs, CI and
   release topology.
2. `docs/DOMAIN.md`
   Use for DSL semantics, pipeline behavior, self-healing targets, post-prod
   graph model, intelligence layer, and live roadmap summary.
3. `docs/CONVENTIONS.md`
   Use for code style, testing, state management, file layout, commit format,
   and workflow conventions.
4. `docs/CREDENTIALS.md`
   Use for signing, notarization, updater, OAuth, R2, JWT, cron, and email
   secrets.
5. `.planning/STATE.md`
   Use for current milestone, live progress, operator-gated blockers, and
   latest shipped phases.

## Load-On-Demand Map

- Changing structure, IPC, crates, routing, release flows:
  read `docs/ARCHITECTURE.md`
- Changing DSL, automation behavior, capture/render pipeline, roadmap-facing
  capability notes:
  read `docs/DOMAIN.md`
- Changing code style, tests, state patterns, workflow rules:
  read `docs/CONVENTIONS.md`
- Changing signing, auth, R2, email, cron, or release secrets:
  read `docs/CREDENTIALS.md`

## Working Rules

- No workarounds. Fix root cause or stop with evidence.
- Plan first for breaking or big changes: public API, IPC, DSL, schema,
  security, build/release, or broad cross-cutting refactors.
- Use GSD workflow entrypoints before repo edits unless the user explicitly
  asks to bypass.
- Keep docs token-efficient: put detail in `docs/*.md`, keep this file lean,
  and add read-on-demand pointers instead of duplicating long explanations.
- When code changes invalidate agent guidance, update this file only at the
  headline level and put the full refresh in the relevant doc.
- **Sidecar placeholder gotcha**: if you run
  `bash scripts/dev/install-sidecar-placeholders.sh` to unblock
  `cargo check`, the stubs left in `apps/desktop/src-tauri/binaries/` will
  hang Live Preview / author preview at runtime ("Starting preview…")
  unless the SEA build replaces them. `pnpm tauri:dev` and `pnpm tauri:build`
  now auto-rebuild the SEA (commit `69eb3a3`), and `build-sea.mjs`
  treats ≤ 10 KB outputs as stubs and forces rebuild. If you ever bypass
  both guards, `rm` the `playwright-sidecar-<triple>` placeholder before
  running `pnpm tauri:dev`. Full context: `docs/CONVENTIONS.md` → "Local
  sidecar binaries".
