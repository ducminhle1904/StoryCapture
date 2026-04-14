---
phase: 01-foundation-dsl-automation-capture-encode
plan: 03b
type: execute
wave: 2
depends_on: ["01-03"]
files_modified:
  - apps/desktop/package.json
  - apps/desktop/vite.config.ts
  - apps/desktop/tsconfig.json
  - apps/desktop/index.html
  - apps/desktop/src/main.tsx
  - apps/desktop/src/App.tsx
  - apps/desktop/src/styles.css
  - apps/desktop/src/ipc/index.ts
  - apps/desktop/src/ipc/query-client.ts
  - apps/desktop/src/lib/fonts.ts
  - apps/desktop/src/components/panic-modal.tsx
  - apps/desktop/src/components/ui/button.tsx
  - apps/desktop/components.json
  - packages/ui/src/index.ts
  - packages/shared-types/src/index.ts
autonomous: true
requirements:
  - UI-09
tags: [react, vite, tailwind, shadcn, base-ui, motion, fonts, lucide, typed-ipc]

must_haves:
  truths:
    - "`pnpm dev` runs the React app standalone at localhost:1420"
    - "`pnpm tauri dev` launches the React app inside the Tauri v2 window from Plan 03a; the root component calls `invoke('ping')` via the typed wrapper and displays `pong from storycapture`"
    - "JetBrains Mono is loaded and rendered on code surfaces (verified by computed-style probe); Geist Sans is the default UI font; Lucide icons render; `motion/react` (NOT `framer-motion`) is used for every animation (UI-09)"
    - "`framer-motion` does not appear anywhere in `apps/desktop/package.json`"
    - "Panic modal listens to the `app:panic` event emitted by Plan 03a's panic hook and renders a Dialog with message + log path + Copy + Restart"
    - "TanStack Query v5 provider wraps the tree; desktop-tuned defaults (`staleTime: 30_000`, `refetchOnWindowFocus: false`, `retry: 1`)"
    - "Tailwind v4 CSS-first config via `@theme` block in `styles.css`; dark-first theme; placeholder token blend (Plan 09 finalizes via getdesign)"
    - "shadcn/ui initialized with Base UI (`@base-ui-components/react`) registry — NOT Radix — per D-32; `Button` installed to prove pipeline"
  artifacts:
    - path: "apps/desktop/package.json"
      provides: "Frontend deps: React 19, Vite 6, Tailwind v4, TanStack Query, Base UI, motion, Lucide, Geist, JetBrains Mono"
      contains: "motion"
    - path: "apps/desktop/src/App.tsx"
      provides: "React 19 root with typed IPC round-trip + motion/react fade-in + PanicModal"
      contains: "motion/react"
    - path: "apps/desktop/src/ipc/index.ts"
      provides: "Typed wrappers around `invoke` using generated `@storycapture/shared-types/ipc` types"
      contains: "invoke"
    - path: "apps/desktop/src/components/panic-modal.tsx"
      provides: "Base UI Dialog bound to `app:panic` event"
    - path: "apps/desktop/components.json"
      provides: "shadcn config with Base UI registry"
      contains: "base-ui"
    - path: "apps/desktop/src/styles.css"
      provides: "Tailwind v4 `@theme` placeholder tokens; JetBrains Mono + Geist Sans registration"
      contains: "JetBrains Mono"
  key_links:
    - from: "apps/desktop/src/App.tsx"
      to: "@tauri-apps/api/core invoke + packages/shared-types"
      via: "typed IPC helper in src/ipc/index.ts"
      pattern: "invoke\\("
    - from: "apps/desktop/src/components/panic-modal.tsx"
      to: "tauri event `app:panic` emitted by Plan 03a panic hook"
      via: "listen<PanicPayload>('app:panic', ...)"
      pattern: "app:panic"
---

<objective>
Deliver the React 19 + Vite 6 + Tailwind v4 + shadcn/Base UI frontend that pairs with Plan 03a's Tauri host. Wire typed IPC (consuming the auto-generated `packages/shared-types/src/ipc.ts` from Plan 03a), mount `motion/react` for animations, register JetBrains Mono + Geist Sans + Lucide, and implement the `app:panic` modal that listens to the host's panic event.

Purpose: Plan 03a unblocked backend plans (P04/P05/P06/P07/P08) to register commands in parallel with this frontend work. Splitting the frontend into 03b lets the React bootstrap happen alongside the Rust crates without serializing the whole phase.

Output: `pnpm tauri dev` launches a window showing `pong from storycapture` (via typed `invoke`) with a motion/react fade-in; panic modal opens when `trigger_panic` is invoked in debug.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/01-foundation-dsl-automation-capture-encode/01-CONTEXT.md
@.planning/phases/01-foundation-dsl-automation-capture-encode/01-RESEARCH.md
@.planning/research/STACK.md
@.planning/phases/01-foundation-dsl-automation-capture-encode/01-01-PLAN.md
@.planning/phases/01-foundation-dsl-automation-capture-encode/01-03-PLAN.md

<interfaces>
Consumes from Plan 03a:
- `packages/shared-types/src/ipc.ts` — generated `ping`, `app_info`, `store_secret`, `load_secret`, `trigger_panic` command types + `AppError`, `AppInfo` types
- Tauri event `app:panic` with payload `{ message: string, thread: string }`
- Tauri v2 shell + capability manifest (main window allowed to invoke above commands)

Emits for downstream plans:
- `apps/desktop/src/ipc/index.ts` — typed invoke helpers; P09 extends for domain commands
- `apps/desktop/src/styles.css` — Tailwind v4 `@theme` block; P09 refines token palette via getdesign
- `apps/desktop/components.json` — shadcn/Base UI registry, P09 adds more components
- `packages/ui/src/index.ts` — empty barrel file; P09 populates with shared tokens/components
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: React 19 + Vite 6 frontend with Tailwind v4, shadcn/Base UI, motion/react, fonts, typed IPC wrapper, panic modal</name>
  <files>
    apps/desktop/package.json,
    apps/desktop/vite.config.ts,
    apps/desktop/tsconfig.json,
    apps/desktop/index.html,
    apps/desktop/src/main.tsx,
    apps/desktop/src/App.tsx,
    apps/desktop/src/styles.css,
    apps/desktop/src/ipc/index.ts,
    apps/desktop/src/ipc/query-client.ts,
    apps/desktop/src/lib/fonts.ts,
    apps/desktop/src/components/panic-modal.tsx,
    apps/desktop/src/components/ui/button.tsx,
    apps/desktop/components.json,
    packages/ui/src/index.ts,
    packages/shared-types/src/index.ts
  </files>
  <read_first>
    - .planning/phases/01-foundation-dsl-automation-capture-encode/01-CONTEXT.md (D-32, D-33, D-34, D-35, D-39)
    - .planning/research/STACK.md (Frontend — Desktop table)
    - Output of Plan 03a: generated `packages/shared-types/src/ipc.ts`
    - Plan 03a `apps/desktop/src-tauri/tauri.conf.json` (window config, capabilities)
  </read_first>
  <behavior>
    - `pnpm dev` (runs `vite`) launches the React app standalone at localhost:1420
    - `pnpm tauri dev` launches the React app inside the Tauri window
    - Root component mounts, calls `invoke('ping')` via typed wrapper, displays `pong from storycapture`
    - TanStack Query v5 provider wraps the tree; `QueryClient` defaults: `staleTime: 30_000`, `refetchOnWindowFocus: false`, `retry: 1`
    - Panic modal: subscribes to `app:panic` Tauri event; shows `<Dialog>` with "Unexpected error. Restart?" + log path + Copy button + Restart button (uses `@tauri-apps/plugin-process::relaunch`)
    - Typography: `<body>` uses Geist Sans; `<code>`, `<pre>`, any `.font-mono` class uses JetBrains Mono
    - Lucide icons imported from `lucide-react`
    - Animation via `import { motion } from 'motion/react'` — prove with a fade-in on App mount (UI-09)
    - Tailwind v4 CSS-first config in `styles.css` via `@theme` block; dark-first; placeholder color blend (Plan 09 refines)
    - shadcn/ui initialized with Base UI registry (`@base-ui-components/react`), `new-york` / `vega` style; `components.json` configured; one component (`Button`) installed to prove the pipeline
    - `@storycapture/shared-types` re-exports from `./ipc.ts` (auto-generated by Plan 03a)
    - Tauri v2 capability permissions respected — no raw `fetch` calls to backend commands
  </behavior>
  <action>
    **`apps/desktop/package.json`** dependencies (concrete versions from STACK.md):
    ```json
    {
      "name": "@storycapture/desktop",
      "private": true,
      "type": "module",
      "scripts": {
        "dev": "vite",
        "build": "tsc -b && vite build",
        "preview": "vite preview",
        "tauri": "tauri",
        "tauri:dev": "tauri dev",
        "tauri:build": "tauri build",
        "typecheck": "tsc -b --noEmit"
      },
      "dependencies": {
        "@storycapture/shared-types": "workspace:*",
        "@storycapture/ui": "workspace:*",
        "@tauri-apps/api": "^2.0.0",
        "@tauri-apps/plugin-log": "^2.0.0",
        "@tauri-apps/plugin-keyring": "^0.1.0",
        "@tauri-apps/plugin-fs": "^2.0.0",
        "@tauri-apps/plugin-dialog": "^2.0.0",
        "@tauri-apps/plugin-updater": "^2.0.0",
        "@tauri-apps/plugin-window-state": "^2.0.0",
        "@tauri-apps/plugin-shell": "^2.0.0",
        "@tauri-apps/plugin-os": "^2.0.0",
        "@tauri-apps/plugin-process": "^2.0.0",
        "@base-ui-components/react": "^1.0.0",
        "@tanstack/react-query": "^5.62.0",
        "@tanstack/react-query-devtools": "^5.62.0",
        "zustand": "^5.0.0",
        "react": "^19.0.0",
        "react-dom": "^19.0.0",
        "motion": "^12.0.0",
        "lucide-react": "^0.460.0",
        "tailwind-merge": "^2.5.0",
        "clsx": "^2.1.1",
        "sonner": "^1.7.0",
        "cmdk": "^1.0.0",
        "geist": "^1.3.1",
        "class-variance-authority": "^0.7.1"
      },
      "devDependencies": {
        "@tauri-apps/cli": "^2.0.0",
        "@vitejs/plugin-react": "^4.3.4",
        "@tailwindcss/vite": "^4.0.0",
        "tailwindcss": "^4.0.0",
        "typescript": "^5.7.2",
        "vite": "^6.0.0",
        "@types/react": "^19.0.0",
        "@types/react-dom": "^19.0.0",
        "shadcn": "^2.1.0"
      }
    }
    ```
    JetBrains Mono loaded from `@fontsource/jetbrains-mono` or via CSS `@font-face` from ttf — executor chooses; document choice in `src/lib/fonts.ts` comment.

    **`apps/desktop/vite.config.ts`**: vite config with `@vitejs/plugin-react`, `@tailwindcss/vite`, server port 1420 (Tauri default), clearScreen false, envPrefix `['VITE_', 'TAURI_']`, path aliases `@` → `./src`, `@shared-types` → `../../packages/shared-types/src`.

    **`apps/desktop/tsconfig.json`**: extends `@storycapture/config/tsconfig.base.json` (from Plan 01), paths matching vite.

    **`apps/desktop/index.html`**: standard Vite template pointing to `/src/main.tsx`, loads JetBrains Mono + Geist Sans via `<link>` or inlined; sets `<html lang="en" data-theme="dark">`.

    **`apps/desktop/src/styles.css`**: Tailwind v4 CSS-first config:
    ```css
    @import "tailwindcss";
    @theme {
      --font-sans: "Geist Sans", system-ui, sans-serif;
      --font-mono: "JetBrains Mono", "Menlo", monospace;
      --color-bg: #0a0a0b;
      --color-fg: #e4e4e7;
      /* Runway + Linear + ElevenLabs placeholder blend — Plan 09 refines with getdesign */
      --color-accent: #6366f1;
      --color-accent-muted: #4338ca;
    }
    :root[data-theme="dark"] body { background: var(--color-bg); color: var(--color-fg); font-family: var(--font-sans); }
    .font-mono, code, pre { font-family: var(--font-mono); }
    ```

    **`apps/desktop/src/main.tsx`**: React 19 entry with `<StrictMode>`, `<QueryClientProvider>`, `<App>`. Imports `./styles.css`.

    **`apps/desktop/src/ipc/query-client.ts`**: exports `queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } } })`.

    **`apps/desktop/src/ipc/index.ts`**: typed wrapper around `@tauri-apps/api/core::invoke` using generated types from `@storycapture/shared-types/ipc`. Exports:
    ```ts
    import { invoke } from '@tauri-apps/api/core';
    import type { AppInfo } from '@storycapture/shared-types';
    export const ping = () => invoke<string>('ping');
    export const appInfo = () => invoke<AppInfo>('app_info');
    export const storeSecret = (service: string, key: string, value: string) => invoke<void>('store_secret', { service, key, value });
    export const loadSecret = (service: string, key: string) => invoke<string>('load_secret', { service, key });
    ```
    Also exports `onPanic(cb)` using `@tauri-apps/api/event::listen<PanicPayload>('app:panic', ...)`.

    **`apps/desktop/src/components/panic-modal.tsx`**: Base UI `Dialog` primitive + shadcn style. Subscribes `app:panic`, displays message + log path + "Copy" (`navigator.clipboard.writeText`) + "Restart" (`@tauri-apps/plugin-process::relaunch`).

    **`apps/desktop/src/App.tsx`**:
    ```tsx
    import { motion } from 'motion/react';
    import { useQuery } from '@tanstack/react-query';
    import { ping, appInfo } from '@/ipc';
    import { PanicModal } from '@/components/panic-modal';
    import { Activity } from 'lucide-react';

    export default function App() {
      const { data: pong } = useQuery({ queryKey: ['ping'], queryFn: ping });
      const { data: info } = useQuery({ queryKey: ['app_info'], queryFn: appInfo });
      return (
        <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="min-h-screen p-8">
          <PanicModal />
          <header className="flex items-center gap-2"><Activity /> <h1>StoryCapture</h1></header>
          <pre className="font-mono text-sm mt-4">{pong ?? '...'}{'\n'}{JSON.stringify(info, null, 2)}</pre>
        </motion.main>
      );
    }
    ```

    **`apps/desktop/components.json`** (shadcn config): `{ "style": "new-york", "rsc": false, "tsx": true, "tailwind": { "config": "", "css": "src/styles.css", "baseColor": "zinc", "cssVariables": true }, "aliases": { "components": "@/components", "ui": "@/components/ui", "lib": "@/lib", "utils": "@/lib/utils" }, "registries": ["@base-ui"] }`. Registry: `base-ui` (NOT Radix) per D-32.

    Run `npx shadcn@latest add button` to install the Base UI button to `src/components/ui/button.tsx`. If `base-ui` registry isn't shadcn-compatible at execution time, fall back to hand-writing the button using `@base-ui-components/react` primitives + `class-variance-authority` — document the fallback choice in a comment at the top of `button.tsx`.

    **`packages/shared-types/src/index.ts`**: `export * from './ipc';` (the file Plan 03a auto-generates).

    **`packages/ui/src/index.ts`**: `export {};` (Plan 09 populates).

    Run `pnpm install` then `pnpm tauri dev` to verify the full stack boots and `pong from storycapture` appears. Manually invoke `trigger_panic` via DevTools and confirm the panic modal opens.
  </action>
  <verify>
    <automated>test -f apps/desktop/package.json && grep -q '"motion"' apps/desktop/package.json && grep -q '"@base-ui-components/react"' apps/desktop/package.json && ! grep -q '"framer-motion"' apps/desktop/package.json && grep -q '"@tanstack/react-query"' apps/desktop/package.json && test -f apps/desktop/src/App.tsx && grep -q "motion/react" apps/desktop/src/App.tsx && test -f apps/desktop/src/ipc/index.ts && test -f apps/desktop/components.json && grep -q "base-ui" apps/desktop/components.json && test -f apps/desktop/src/styles.css && grep -q "JetBrains Mono" apps/desktop/src/styles.css && grep -q "Geist Sans" apps/desktop/src/styles.css && test -f apps/desktop/src/components/panic-modal.tsx && grep -q "app:panic" apps/desktop/src/components/panic-modal.tsx && pnpm --filter @storycapture/desktop typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `apps/desktop/package.json` lists `motion` (NOT `framer-motion`), `@base-ui-components/react`, `@tanstack/react-query@^5`, `lucide-react`, `react@^19`
    - `framer-motion` MUST NOT appear anywhere in package.json
    - `App.tsx` imports from `motion/react` literally
    - `components.json` has `registries` including `base-ui`; shadcn/New-York (vega) style selected
    - `styles.css` references both `JetBrains Mono` and `Geist Sans` literal strings
    - `pnpm tauri dev` boots; window displays `pong from storycapture`
    - Panic modal test: invoking `trigger_panic` (debug only) causes the panic modal to open
    - TypeScript check passes: `pnpm --filter @storycapture/desktop typecheck` exits 0
  </acceptance_criteria>
  <done>React 19 + Vite 6 frontend boots inside Tauri v2 shell with Tailwind v4, shadcn + Base UI, TanStack Query, motion/react, Lucide, JetBrains Mono + Geist Sans all wired. Typed IPC round-trips against Plan 03a's commands. Panic modal responds to `app:panic` event.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Renderer → Tauri host | Typed `invoke` is the only path; capability manifest from Plan 03a enforces allow-list. |
| `app:panic` event → UI | Payload comes from the host panic hook; UI treats as display-only (no code execution from payload). |
| Third-party NPM deps | `motion`, `@base-ui-components/react`, `lucide-react`, `geist`, etc. loaded into the renderer. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03b-01 | Tampering | Supply-chain compromise of renderer deps | mitigate | Lockfile pinned (`pnpm-lock.yaml`); CI audits via `pnpm audit` nightly; renovate or dependabot weekly; no postinstall scripts unless reviewed. |
| T-03b-02 | Information Disclosure | Panic payload leaks PII to renderer | mitigate | Plan 03a host sanitizes before emit; renderer displays only `{ message, thread }`; Copy button copies literal rendered text only. |
| T-03b-03 | Spoofing | Malicious `app:panic` payload from renderer extensions | accept | Tauri event bus is internal; only host emits `app:panic`. No external origin. |
| T-03b-04 | Denial of Service | Large panic payload freezes modal | mitigate | Renderer truncates message to 4 KB; "Copy" copies truncated text. |
| T-03b-05 | Elevation of Privilege | React code calling unlisted commands | mitigate | Capabilities manifest in Plan 03a whitelists only declared commands; `invoke` on unknown command returns error. |
</threat_model>

<verification>
- `pnpm tauri dev` launches window on macOS + Windows; `pong from storycapture` visible
- `framer-motion` absent from `pnpm-lock.yaml` and `apps/desktop/package.json`
- Panic modal opens when `trigger_panic` invoked in debug build
- `pnpm --filter @storycapture/desktop typecheck` exits 0
</verification>

<success_criteria>
- UI-09 requirement satisfied: JetBrains Mono + Geist Sans + Lucide + motion/react all loaded and verifiable
- Typed IPC round-trip from React → Rust host → React with generated types (no `any`)
- Panic modal proves end-to-end: host panic → `app:panic` event → Base UI Dialog
- shadcn/Base UI pipeline proven by Button component
</success_criteria>

<output>
After completion, create `.planning/phases/01-foundation-dsl-automation-capture-encode/01-03b-SUMMARY.md` documenting: the font loading strategy chosen, shadcn Base UI registry compatibility verdict, any deviation in the Button install path, and the typed IPC wrapper shape used by downstream plans.
</output>
