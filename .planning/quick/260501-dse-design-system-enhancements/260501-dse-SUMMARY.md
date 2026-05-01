quick_id: 260501-dse
mode: quick
status: complete
date: 2026-05-01

# Summary

Audited the active `@storycapture/ui` design system and added reusable
primitive coverage for the missing interaction states:

- `ScField` for label/helper/meta/error structure with aria wiring.
- `ScTextarea` using the shared input visual language without adding a new
  dependency.
- `ScSkeleton` for layout-sized loading states.
- `ScEmptyState` for unboxed empty views with optional icon/actions.
- `ScCallout` for info/success/warn/danger messages.

CSS enhancements landed in `claude-design/app.css`:

- Motion timing/easing tokens are now used by buttons, inputs, skeletons, and
  animated entry states.
- Reduced-motion support disables shimmer/pulse/fade animation without
  `!important`.
- Buttons and inputs now have clearer disabled, invalid, hover, focus, and
  tactile active states.
- `info` and `warn` badge tones now have visual definitions matching their
  exported TypeScript union.

Documentation updated:

- `claude-design/README.md` now describes this directory as the active desktop
  design system instead of a raw, unwired handoff.

# Verification

- `pnpm typecheck` in `packages/ui` — PASS.
- `pnpm test` in `packages/ui` — PASS, 14 files / 33 tests.
- `pnpm exec biome lint packages/ui/src/claude-design/app.css` — PASS.
- `pnpm exec biome check --write` on the new TS/TSX primitive files and
  primitive export barrel — PASS, fixed formatting/import order.
- `git diff --check -- packages/ui .planning/quick/260501-dse-design-system-enhancements` — PASS.

Note: full `biome check packages/ui/src packages/ui/README.md` still reports
pre-existing package issues outside this quick task, including Tailwind
`@theme` parse diagnostics in `packages/ui/src/tokens.css` and older primitive
test formatting/non-null assertions.
