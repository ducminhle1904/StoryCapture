# StoryCapture Design System V2 Specification

## Objective

Create one production design system for the Electron desktop app and Next.js web companion. The selected visual contract is Option 1: cinematic creator studio, dark-first desktop, dominant live media preview, focused script authoring, warm amber primary actions, restrained surfaces, and shared brand DNA across web light/dark presentations.

Primary users are product marketers, developer advocates, founders, customer education teams, and release teams creating repeatable product-demo videos from `.story` scripts.

## Selected visual contract

- Reference: `docs/design-system-v2-story-editor-reference.png`
- Canvas: 1440 × 1024 desktop application viewport.
- Core hierarchy: workspace navigation → story script → live preview → scene timeline.
- Brand: StoryCapture name and Ribbon-S mark; warm amber accent; Geist and Geist Mono.
- Visual behavior: graphite surfaces, bone text, semantic green/blue, subtle amber canvas glow, 1px separators, restrained elevation, clear focus rings, reduced-motion support.
- Product behavior and information architecture remain unchanged.

## Tech stack and structure

- React 19, TypeScript, Base UI, Vite/Electron desktop, Next.js web.
- Shared implementation: `packages/ui`.
- Desktop consumers: `apps/desktop/src`.
- Web consumers: `apps/web/src`.
- Shared component tests: `packages/ui/src/claude-design/primitives/__tests__` during compatibility migration, then canonical test locations.

## Public interfaces

- Canonical CSS: `@storycapture/ui/tokens.css`, `@storycapture/ui/primitives.css`, `@storycapture/ui/desktop-shell.css`.
- Retired compatibility CSS: all runtime consumers now use canonical entrypoints.
- Components keep the `Sc*` API and add Accordion, Dialog, Popover, Tooltip, RadioGroup, and ToggleGroup families.
- Interactive components declare the correct client boundary for Next.js; presentational components remain server-compatible.

## Code style example

```tsx
<ScField label="Project name" htmlFor="project-name">
  <ScInput id="project-name" size="md" />
</ScField>
```

Use semantic tokens and typed variants. Do not add literal colors or spacing when an existing token expresses the same intent.

## Commands

- UI tests: `pnpm --dir packages/ui test`
- UI typecheck: `pnpm --dir packages/ui typecheck`
- UI accessibility: `pnpm --dir packages/ui test:a11y`
- UI boundaries: `pnpm --dir packages/ui test:boundaries`
- UI visual: `pnpm --dir packages/ui test:visual`
- Desktop tests: `pnpm --dir apps/desktop exec vitest run`
- Web tests: `pnpm --dir apps/web test`
- Root typecheck: `pnpm typecheck`
- Root build: `pnpm build`
- Media parity: `pnpm --dir apps/desktop run test:e2e:media`
- Cursor parity: `pnpm --dir apps/desktop run test:e2e:cursor-sync`
- Export parity: `pnpm --dir apps/desktop run test:e2e:export`

## Testing strategy

- Unit tests cover prop forwarding, variants, disabled/loading/error states, keyboard behavior, and accessibility relationships.
- Axe checks reject critical/high violations in representative component states.
- Visual baselines cover dark/light themes, desktop/web density, focus, open, selected, loading, empty, and error states.
- Consumer tests prove no behavioral regression in desktop and web flows.
- Runtime design QA compares equal viewport/state captures against the selected reference.

## Boundaries

- Always: preserve behavior, use Base UI for accessible interactive foundations, use canonical imports, and verify every slice.
- Ask first: schema, IPC, public route, dependency, or CI changes outside this specification.
- Never: edit generated sources, introduce Tauri/Rust assumptions, replace product assets with placeholders, or delete a local primitive while references remain.

## Success criteria

- Desktop and web use canonical tokens; web consumes shared React primitives.
- Matching local Button, Select, Slider, ToggleGroup, RadioGroup, and Accordion implementations reach zero references before removal.
- Every shared primitive has tests, including Tabs.
- Accessibility and visual gates pass in CI.
- `design-qa.md` ends with `final result: passed`.

## Open questions

None. Option 1 and the compatibility-first migration sequence are approved.
