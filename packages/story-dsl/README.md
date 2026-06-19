# @storycapture/story-dsl

Story DSL AST/vocabulary and CodeMirror language support.

## What Lives Here

- `src/ast.ts`: checked-in Story AST/type surface.
- `src/codemirror-lang.ts`: CodeMirror parser/token/highlight/editor support.
- `src/index.ts`: package barrel.

## Important Boundary

This package is not the runtime automation parser. Runtime parsing is reached
from desktop renderer code through `apps/desktop/src/ipc/parse.ts` and handled
by the Electron host compatibility surface.

When changing DSL semantics, inspect both:

- editor support in this package and `apps/desktop/src/features/editor`;
- runtime parse/simulator/automation behavior in desktop IPC and Electron host
  code.

## Commands

- `pnpm --dir packages/story-dsl typecheck`
