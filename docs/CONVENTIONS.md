# StoryCapture - Conventions

Concrete patterns used in the current Electron/TypeScript codebase.

## TypeScript / React

- File naming: kebab-case for new files. PascalCase is reserved for existing
  legacy/dialog components already in that style.
- Feature code lives under `apps/desktop/src/features/<feature>/`.
- Shared renderer UI lives under `apps/desktop/src/components`.
- Host IPC facades live under `apps/desktop/src/ipc`.
- Electron host code lives under `apps/desktop/electron`.
- Cross-feature state lives under `apps/desktop/src/state` or
  `apps/desktop/src/stores`.

## State

- Prefer one monolithic Zustand store per feature.
- Use slice composition only when the feature is already split that way, such
  as the post-production editor store.
- TanStack Query wrappers should stay in `src/ipc/*.ts` with stable query-key
  factories and explicit invalidation.

## IPC

- Renderer code may continue using `@tauri-apps/api` and plugin packages while
  the compatibility layer exists.
- New host behavior should be implemented in `apps/desktop/electron/ipc.ts` and
  exposed through existing IPC wrapper patterns.
- Long-running operations should use the existing channel/event shim patterns
  instead of introducing a second streaming abstraction.

## UI

- Base UI compound components are the default primitive foundation.
- Variants use CVA in `components/ui`.
- Icons come from `lucide-react`.
- Motion uses `motion/react`.
- Use tokens from `@storycapture/ui/tokens.css`; avoid hardcoded colors and
  spacing unless the surrounding file already requires it.

## Testing

- Desktop renderer and host-facing code: Vitest + `happy-dom` +
  `@testing-library/react`.
- UI package: Vitest.
- Web companion: Vitest.
- Build/runtime verification: `pnpm --dir apps/desktop run build`, then launch
  the packaged Electron app when runtime behavior changed.

## Commits

- Format: `type(scope): subject`.
- Common types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `merge`.
- No `Co-Authored-By` trailers.
- Do not use `--no-verify`, `@ts-ignore`, skipped tests, or silence lints to
  make checks pass.

## Lint / Format

- Biome is the single formatter/linter.
- Config: `biome.json`.
- Run `pnpm lint` and `pnpm format` as needed.

## CI

The primary workflow is `.github/workflows/ci.yml`. It installs pnpm/Node,
typechecks, runs desktop/UI/web tests, and builds the Electron desktop package.

## Agent / Contributor Rules

1. Fix root causes; avoid workaround-only patches.
2. Keep edits scoped to the task.
3. Match established local patterns.
4. Report skipped checks and residual risk clearly.
