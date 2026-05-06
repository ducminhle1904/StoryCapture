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

## Current Repo Reality (refreshed 2026-05-06)

- Desktop routes: `/`, `/onboarding`, `/settings`, `/editor/:projectId`,
  `/recorder/:projectId`, `/post-production`, `/post-production/:storyId`.
- Tauri IPC surface is large and actively evolving: 28 exported IPC modules,
  124 registered commands, and 150 Specta `.typ::<T>()` registrations as of
  this refresh. Generated TS currently emits 124 async wrappers and 161
  exported type aliases in `packages/shared-types/src/ipc.ts` (never
  hand-edited).
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
- Post-production is now real-recording backed: latest recording preview,
  typed 5-track Clip union, computeGraph → Effects AST JSON, Story → Timeline
  auto-population, and recording sidecars (`.actions.json`, `.trajectory.json`,
  `.steps.json`) feed cursor/zoom/callout/highlight defaults.
- Export reality: post-production MP4 auto export prefers `libx264` on macOS
  for screen-content quality and NVENC → QSV → AMF on Windows when available;
  explicit hardware choices still exist. FFmpeg effects filters remain
  CPU-bound; rounded-frame masking is intentionally a fast export no-op for
  now. The GPU compositor boundary exists but is not the production backend.
  Details live in `docs/DOMAIN.md`.
- Editor has hybrid UI / Code modes. UI mode edits canonical DSL blocks and
  optional `<story>.polish.json`; `Record & Polish` records, then opens
  post-production in Review & Export mode.
- Logging was overhauled (commit `a8e78b6`): `tracing` + size-rolling files,
  per-run session UUID prefix, `log_from_frontend` IPC bridge, ~95
  `#[tracing::instrument(err)]` wrappers, configurable from Settings →
  Logs. All local-only — no telemetry.
- `packages/ui` ships shared tokens plus the `claude-design` namespace and
  15 `Sc*` primitive families. Tailwind v4 `@theme` block is canonical; inspect
  `packages/ui/src/claude-design/primitives/` instead of trusting stale counts.
- Current manifest pins: desktop Tauri CLI `^2.10.1`, React `^19.2.5`, Vite
  `^8.0.9`, Tailwind `^4.2.4`; web Next `^16.2.4`, tRPC `^11.16.0`, Prisma
  `^6.0.0`, NextAuth `5.0.0-beta.31`.
- Web companion has public/watch/embed/invite pages, dashboard workspace/video
  surfaces, tRPC routers, NextAuth v5 GitHub + Google OAuth, R2 multipart
  upload, Resend invites, Vercel cron analytics aggregation, and desktop sync.
- Live project status is `.planning/STATE.md` plus
  `.planning/POST-PROD-ROADMAP.md` for the current post-production push. Treat
  `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, and old roadmap tables
  as historical planning artifacts unless explicitly refreshed.

## Source Of Truth

Read only what the task needs.

1. `docs/ARCHITECTURE.md`
   Use for repo layout, crate ownership, IPC, route surfaces, web APIs, CI and
   release topology.
2. `docs/DOMAIN.md`
   Use for DSL semantics, pipeline behavior, self-healing targets, recording
   sidecars, post-prod graph model, and intelligence layer.
3. `docs/CONVENTIONS.md`
   Use for code style, testing, state management, file layout, commit format,
   and workflow conventions.
4. `docs/CREDENTIALS.md`
   Use for signing, notarization, updater, OAuth, R2, JWT, cron, and email
   secrets.
5. `.planning/STATE.md`
   Use for current milestone snapshot, operator-gated blockers, and latest
   shipped highlights. For post-production follow-ups also read
   `.planning/POST-PROD-ROADMAP.md`.

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
