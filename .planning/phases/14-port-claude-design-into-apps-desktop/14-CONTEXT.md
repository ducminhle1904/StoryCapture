# Phase 14: Port Claude Design into apps/desktop — Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Port the Claude Design handoff bundle (`.planning/design/storycapture-claude-design/`, mirrored into `packages/ui/src/claude-design/`) into the running Tauri desktop app as a **visual re-skin**: replace the existing Cursor-warm-light token system with the `sc-*` dark-first system, ship Claude Design's custom window chrome + overlays, and restyle the four primary routes (Dashboard, Editor, Post-production, Settings) plus the Export dialog to match the mocked screens — while preserving 100% of existing behavior (IPC channels, Zustand stores, CodeMirror/LSP, WebGPU preview, motion/react transitions, Phase 13 output-prefs, keyboard shortcuts, every wired feature).

Out of scope: new capabilities, new IPC commands, new Rust code (except Tauri window-config changes required for custom chrome), behavioral rewrites, or screens not in the handoff bundle.

</domain>

<decisions>
## Implementation Decisions

### Token System
- **D-01:** `sc-*` (Claude Design) becomes the single, canonical token system. The existing Cursor-warm-light tokens in `packages/ui/src/tokens.css` are retired — every screen re-themes to `sc-*`. No dual-namespace coexistence. Existing features that referenced the old tokens (cream canvas, warm-brown borders, Lora serif) must migrate.
- **D-02:** Both `data-theme="dark"` and `data-theme="light"` are supported and tested. **Dark is the default.** User-facing theme toggle lives in Settings (wired through the persistence path of D-08's TweaksPanel state). Both themes must pass WCAG 2.1 AA contrast checks for all ported screens.
- **D-11:** Font stack collapses to **Inter + JetBrains Mono only**. Drop `@fontsource/lora` and `@fontsource-variable/outfit` imports from `apps/desktop/src/styles.css`. Any existing Lora/Outfit-specific styling (editorial body copy, brand wordmark) migrates to Inter weights during the route-by-route port.

### Primitives
- **D-04:** The `.sc-*` CSS classes (`.sc-btn`, `.sc-input`, `.sc-badge`, `.sc-switch`, `.sc-card`, `.sc-kbd`, `.sc-slider`) are wrapped as typed React components under `packages/ui/src/claude-design/` (e.g. `ScButton`, `ScInput`, `ScBadge`, `ScSwitch`, `ScCard`, `ScKbd`, `ScSlider`). Ported screens consume the React components; raw classNames are not used in ported JSX. Existing shadcn+Base UI components stay in place for features that have not been ported — no shadcn churn this phase. Committed stack (`shadcn/ui + Base UI`, not Radix) is unchanged.

### Window Chrome
- **D-03:** Adopt Claude Design's custom titlebar. Flip `tauri.conf.json` → `decorations: false` on both macOS and Windows. Port `chrome.jsx` to React: drag region, macOS traffic-light cluster (red/yellow/green with hover + focus states), Windows caption buttons (min/max/close), `data-platform` attribute driven by `@tauri-apps/plugin-os` at boot. Side-nav + toolbar shell that every screen composes inside lives in this same component. Wire window-control handlers via `@tauri-apps/api/window`.

### Screen Scope (routes ported this phase)
- **D-05a:** `apps/desktop/src/routes/dashboard.tsx` ← `project/screens/dashboard.jsx`
- **D-05b:** `apps/desktop/src/routes/editor.tsx` ← `project/screens/editor.jsx`
- **D-05c:** `apps/desktop/src/routes/post-production.tsx` ← `project/screens/postprod.jsx`
- **D-05d:** `apps/desktop/src/routes/settings.tsx` ← `project/screens/settings.jsx`
- **D-05e:** `apps/desktop/src/routes/recorder.tsx` and `apps/desktop/src/routes/index.tsx` — **not explicitly mocked** by Claude Design. They inherit the new chrome + primitives + tokens but retain their current layout. Cosmetic consistency pass only; no screen redesign.

### Overlays (shipped this phase)
- **D-06a:** `chrome.jsx` — titlebar + side-nav + toolbar shell. Wraps every route.
- **D-06b:** `CommandPalette` (Cmd/Ctrl-K) — ported into `apps/desktop/src/components/` (or appropriate feature location), wired to the existing route surface.
- **D-06c:** `ToastStack` — replace any existing toast infra (likely `sonner`) with Claude Design's `ToastStack`, OR keep `sonner` skinned to look like Claude Design's — planner's discretion based on what `sonner` exposes. Ship a single toast system.
- **D-06d:** `RecordingIndicator` — floating badge shown during active recording. Wires to existing recorder state.
- **D-06e:** `TweaksPanel` — see D-08.
- **D-06f:** `tokens.jsx` + `components.jsx` — design-system showcase screens ported to a **hidden `/_design-system` route**, reachable via dev shortcut only, not linked from the side nav.

### Export Flow
- **D-07:** Visual port of `project/screens/export.jsx` into `apps/desktop/src/features/export/export-modal.tsx` (restyle only). All Phase 13 wiring preserved: `AdvancedOutputOptions` disclosure, `EncoderOptionsDto` sub-DTOs, the output-prefs Zustand store, per-project IO, ENC-12..ENC-19 surfaces. No IPC or backend changes. Phase 13 acceptance criteria (ENC-12..ENC-19) must continue to pass after the restyle.

### TweaksPanel
- **D-08:** TweaksPanel ships **dev-only**, gated behind a debug flag (`import.meta.env.DEV` plus a keyboard shortcut — planner picks a non-conflicting combo, e.g. `Cmd/Ctrl+Shift+.`). Not visible to end users. Bindings (theme, accent hue, density, radius) persist to `tauri-plugin-store` so dev toggles survive reloads but end-user state is controlled solely via Settings → Appearance (which exposes a subset: theme + accent hue; density and radius are dev-only). Any keybindings chosen must not collide with existing shortcuts (`Cmd/Ctrl-Z` undo, `Cmd/Ctrl-K` palette, existing post-production shortcuts from Phase 2-12b).

### Behavior Preservation
- **D-09:** **Visual-only port.** Every IPC call, Zustand selector, event handler, keyboard shortcut, motion transition, CodeMirror extension, LSP bridge, WebGPU lifecycle, and Tauri channel MUST be preserved exactly. Plans restyle JSX and classNames and hoist layout primitives — they do **not** delete or refactor behavior. If a Claude Design mock shows a control the app does not yet implement, that control is **deferred** (captured in this phase's Deferred Ideas), not invented. If a Claude Design mock omits a control the app currently has, that control is **retained** (verify in the planner's must_haves list), not removed. Any proposed deviation surfaces in the plan deviation log and halts the wave for user approval.

### Rollout Strategy
- **D-10:** **Big-bang per wave.** Each wave ships one self-contained layer of the port:
  - Wave 1: Token replacement + font stack migration + `sc-*` React primitives in `packages/ui/src/claude-design/` (foundation; no routes change visually yet, primitives just available).
  - Wave 2: Window chrome (`decorations: false`, titlebar, platform plumbing) + side-nav shell.
  - Wave 3: Routes — Dashboard → Editor → Post-production → Settings (parallel plans, each deletes old route when the new one lands).
  - Wave 4: Overlays (CommandPalette, ToastStack, RecordingIndicator) + Export restyle.
  - Wave 5: TweaksPanel (dev) + `/_design-system` showcase + Settings → Appearance user-facing theme toggle.
  - No feature flag; no long-lived side-by-side old/new. Each wave must ship a working app. Old route files are deleted in the same commit that introduces the new one.

### Claude's Discretion
- Component naming inside `packages/ui/src/claude-design/` (e.g. `ScButton` vs `Button` — but must not collide with shadcn). Planner picks.
- Toast system mechanics (replace `sonner` vs skin `sonner`) — planner picks based on API fit.
- Exact dev-only TweaksPanel keyboard shortcut, as long as it does not collide with existing bindings.
- Motion token + transition mapping between Claude Design CSS transitions and `motion/react` — use `motion/react` (per CLAUDE.md; not raw CSS transitions) for any animated re-skin.
- WCAG AA verification methodology (axe-core? manual? `@axe-core/react` in tests?) — planner picks.
- Whether `dashboard.tsx` and any not-explicitly-mocked routes get a light visual refresh or a strict minimum styling pass to match new tokens.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Handoff Bundle (source of truth for visuals)
- `.planning/design/storycapture-claude-design/README.md` — bundle-reader instructions (chats first, then `project/index.html`, follow imports)
- `.planning/design/storycapture-claude-design/chats/chat1.md` — full design conversation, intent behind choices
- `.planning/design/storycapture-claude-design/project/index.html` — entry point; shows all screen + component + style imports
- `.planning/design/storycapture-claude-design/project/app.jsx` — root React tree, theme/platform/density/radius wiring
- `.planning/design/storycapture-claude-design/project/styles/tokens.css` — canonical `sc-*` token definitions
- `.planning/design/storycapture-claude-design/project/styles/app.css` — primitive CSS (`.sc-btn`, `.sc-input`, etc.)
- `.planning/design/storycapture-claude-design/project/components/chrome.jsx` — titlebar + side nav + toolbar shell (required for D-03)
- `.planning/design/storycapture-claude-design/project/components/primitives.jsx` — React forms of `.sc-*` (reference implementation for D-04)
- `.planning/design/storycapture-claude-design/project/components/overlays.jsx` — CommandPalette, ToastStack, RecordingIndicator, TweaksPanel (D-06)
- `.planning/design/storycapture-claude-design/project/components/icons.jsx` — icon set used across screens
- `.planning/design/storycapture-claude-design/project/components/macos-window.jsx` — macOS chrome reference
- `.planning/design/storycapture-claude-design/project/screens/{dashboard,editor,postprod,export,settings,tokens,components}.jsx` — each port target (D-05, D-07)

### Staged Work Already in Repo
- `packages/ui/src/claude-design/README.md` — notes reconciliation decision (now D-01)
- `packages/ui/src/claude-design/tokens.css` — already-mirrored `sc-*` tokens
- `packages/ui/src/claude-design/app.css` — already-mirrored primitive CSS

### Existing Codebase (must be preserved per D-09)
- `apps/desktop/src/styles.css` — current font + token imports (migrate per D-11)
- `apps/desktop/src/routes/{dashboard,editor,post-production,settings,recorder,index}.tsx` — current routes
- `apps/desktop/src/features/*` — every feature's wiring (IPC, stores, components) must survive the visual port
- `apps/desktop/src/features/export/export-modal.tsx` — Phase 13 advanced options (D-07)
- `apps/desktop/src/features/post-production/state/` — Zustand slices, must survive (D-09)
- `packages/ui/src/tokens.css` — retired this phase (D-01)
- `packages/ui/src/index.ts` — re-exports; new `sc-*` primitives land here

### Project Standards
- `CLAUDE.md` — committed stack (shadcn+Base UI, `motion/react`, not Radix); D-04 preserves this
- `docs/CONVENTIONS.md` — kebab-case files, feature-folder layout, Zustand conventions, Base UI primitives
- `docs/ARCHITECTURE.md` — four trait boundaries (unchanged this phase)
- `.planning/PROJECT.md` + `.planning/REQUIREMENTS.md` — WCAG 2.1 AA is a v1 constraint; applies to D-02 and every ported screen
- `.planning/STATE.md` — active state, Phase 13 just landed; ENC-12..ENC-19 must continue to pass (D-07)

### Tauri Window Chrome (for D-03)
- `apps/desktop/src-tauri/tauri.conf.json` — `decorations`, window size/position defaults
- `apps/desktop/src-tauri/capabilities/` — window-control capability scopes
- `@tauri-apps/api/window` + `@tauri-apps/plugin-os` — runtime platform detection + window controls

### Persistence (for D-02 theme toggle + D-08 TweaksPanel dev persistence)
- `apps/desktop/src/stores/` — existing Zustand stores (Phase 13 pattern for tauri-plugin-store persistence)
- `apps/desktop/src/features/settings/` — existing Settings surface (D-02 theme toggle lands here)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`tauri-plugin-store`** — already wired (Phase 13). Reuse for theme + TweaksPanel persistence.
- **`@tauri-apps/plugin-os`** — already a dependency. Used for `data-platform` at boot (D-03).
- **Zustand pattern (`features/post-production/state/`)** — 6-slice composed store; model for any new Claude-Design state (theme store, tweaks store).
- **`motion/react`** — committed transition library per CLAUDE.md. Any Claude-Design CSS transitions map onto this.
- **`sonner`** — currently installed for toasts. Either skin or replace per D-06c.
- **`cmdk`** — already installed. CommandPalette port (D-06b) uses `cmdk` internally.
- **Tailwind v4 `@theme` directive** — existing `packages/ui/src/tokens.css` uses it. Claude Design's `tokens.css` uses raw `:root` CSS variables. Planner must decide whether to rewrite `sc-*` tokens as `@theme` or keep raw vars (both work; `@theme` gives Tailwind utility classes for free).

### Established Patterns
- **Route-per-file under `src/routes/`** — React Router v7 data router; each route is a top-level component.
- **Feature folders under `src/features/`** — each feature owns its IPC, store, components. Preserve this.
- **Tauri command registration via `ipc_spec.rs`** — no new commands this phase, but any window-control additions (if not already in the window plugin) land here.
- **Kebab-case file names** — per `docs/CONVENTIONS.md`. Applies to new `claude-design/` files.

### Integration Points
- **`apps/desktop/src/App.tsx` / `main.tsx`** — root mount; `data-theme` / `data-platform` / `data-density` / `data-radius` attributes set here at boot.
- **`apps/desktop/src/styles.css`** — single `@import` graph; `sc-*` tokens land here, Lora/Outfit removed (D-11).
- **`packages/ui/src/index.ts`** — primitive re-exports; `ScButton` & friends surface here.
- **`tauri.conf.json`** — `decorations: false` flip (D-03) is a single-line change, but every platform QA surface regresses until chrome is ported.
- **Router + side-nav link graph** — `chrome.jsx`'s side-nav must map to existing routes (`/dashboard`, `/editor`, `/post-production`, `/settings`, `/recorder`). `/_design-system` is a new hidden route (D-06f).

</code_context>

<specifics>
## Specific Ideas

- Claude Design's tokens file sets `--sc-accent-h: 78` in CSS but `window.SC_TWEAKS.accentHue = 22` in `index.html`. These disagree intentionally — the HTML-level tweak is meant to overwrite the CSS default at runtime via `root.style.setProperty("--sc-accent-h", tweaks.accentHue)`. Planner must preserve this pattern: CSS holds the fallback, runtime sets the real value.
- Claude Design persists state to `localStorage` (`sc-screen`, `sc-tweaks`). In the Tauri port, persistence goes through `tauri-plugin-store`, not `localStorage`. The `window.parent.postMessage` calls in `app.jsx` (lines ~22, ~51) are part of the Claude Design edit-mode contract with the design-tool host — they are **not** needed in the desktop port and must be stripped.
- Keyboard shortcuts in `app.jsx`'s global `onKey` handler must be audited against existing desktop shortcuts before porting. Any collision (e.g. Cmd-K palette vs an existing binding) surfaces in the plan and is resolved in user's favor of the existing binding unless explicitly overridden.
- The Claude Design screens use `<script src="https://unpkg.com/react@18.3.1/…">` — this is prototype-only. The real app already runs React 19 via Vite. Planner drops all `<script>` and `<link rel="stylesheet">` tags during the port; JSX files are transpiled via the existing Vite pipeline.
- Claude Design uses Babel standalone for JSX transpilation (prototype only). Port targets Vite's React SWC/TSX pipeline; `.jsx` sources become `.tsx` with proper types against the existing feature props.

</specifics>

<deferred>
## Deferred Ideas

- **Light-mode refinement pass.** D-02 says light is supported, but the ported screens will ship with "works, passes WCAG AA" rather than a dedicated light-mode design polish pass. A follow-up phase can tighten light-mode visual hierarchy after user feedback.
- **Routes not explicitly mocked by Claude Design (`recorder.tsx`, `index.tsx`, any modal not in the handoff).** They get token + chrome + primitive consistency but not a redesign. A follow-up phase can commission Claude Design mocks for them.
- **Controls shown in Claude Design mocks that the app does not yet have** (per D-09) — captured here, not implemented this phase. Expect the planner to enumerate these during research.
- **Density + radius user-facing controls.** TweaksPanel exposes them (dev-only, D-08). Exposing end-user density/radius in Settings is deferred to a follow-up so we don't expand Settings scope during a visual port.
- **Storybook / full design-system site.** `/_design-system` route ships a lightweight showcase of tokens + components (ports of `tokens.jsx` and `components.jsx`). A real Storybook setup is out of scope.
- **Removal of `packages/ui/src/tokens.css`.** The file is retired (D-01) but the planner may keep a transitional stub that re-exports `sc-*` tokens under the old variable names for any stray consumer not caught during migration. Stub is deleted in the final wave's cleanup plan.
- **Replacing shadcn/Base UI globally.** Not this phase. `sc-*` primitives coexist with shadcn; ported screens use `sc-*`, everything else keeps shadcn.

</deferred>

---

*Phase: 14-port-claude-design-into-apps-desktop*
*Context gathered: 2026-04-21*
