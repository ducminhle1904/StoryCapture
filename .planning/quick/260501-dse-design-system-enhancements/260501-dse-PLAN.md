quick_id: 260501-dse
mode: quick
title: Design system audit and primitive enhancements
date: 2026-05-01

# Scope

Evaluate the active StoryCapture design system and add small, reusable
enhancements without changing desktop route behavior or public IPC.

# Findings

- `packages/ui` already owns the active `sc-*` token layer, Geist typography,
  Base UI-backed primitives, and desktop imports.
- The system is dark-first and operationally appropriate for a desktop authoring
  tool, but the primitive set stops at controls and lacks shared loading, empty,
  helper/error, and callout surfaces.
- Existing app code repeats one-off inline styles for loading, errors, and empty
  states. The lowest-risk enhancement is to add reusable primitives in
  `packages/ui` and let feature screens migrate incrementally.

# Tasks

1. Add shared primitive CSS for field layouts, textarea, skeleton loading,
   empty states, callouts, reduced motion, and stronger disabled states.
2. Export React primitives from `@storycapture/ui`.
3. Add focused package-level tests for the new primitives.
4. Update the package README to reflect the current active design system.

# Out Of Scope

- No desktop route rewrites.
- No dependency additions.
- No theme switching store changes.
- No generated IPC edits.
