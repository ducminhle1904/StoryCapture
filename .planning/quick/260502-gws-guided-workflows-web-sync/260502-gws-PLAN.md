quick_id: 260502-gws
mode: quick
title: Guided workflow web catalog and sync

## Goal

Finish deferred guided-workflow work after desktop-local V1:

- Add guided workflow metadata to the web Template catalog.
- Mirror workflow roadmap metadata through desktop-web sync.
- Record manual Tauri QA expectations for the new flow.

## Scope

- Additive Prisma schema changes only.
- Preserve existing `TemplateCategory` marketplace grouping.
- Desktop remains source of truth for workflow roadmap status.
- Web companion displays workflow roadmap metadata read-only.

## Verification

- Prisma generate.
- Web tests and typecheck.
- Desktop typecheck, focused Vitest, cargo check/tests, and Specta regenerate.
- Manual Tauri smoke checklist captured in summary.
