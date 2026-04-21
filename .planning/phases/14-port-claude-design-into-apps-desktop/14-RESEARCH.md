# Phase 14: Port Claude Design into apps/desktop — Research

**Researched:** 2026-04-21
**Domain:** Design-system port / visual re-skin of a Tauri v2 React 19 desktop app
**Confidence:** HIGH (ecosystem + codebase verified), with MEDIUM on a11y tooling (happy-dom ↔ axe-core bug)

## Summary

This phase is a **pure visual re-skin**: swap the token system, wrap the prototype's `.sc-*` CSS as typed React primitives in `packages/ui`, ship a custom Tauri titlebar, and restyle four routes + the Export dialog — preserving every IPC, Zustand selector, hotkey, and motion transition already wired in Phases 1–13.

The Claude Design handoff bundle is **complete and self-contained** (2,794 lines of JSX across 12 files). `tokens.css` and `app.css` are already mirrored into `packages/ui/src/claude-design/`; what's missing is the React wrap, platform-aware Tauri chrome wiring, and the screen ports.

Two discretion items resolve decisively from research:
1. **Keep `sonner`, skin via CSS variables** (`--normal-bg`, `--normal-text`, `--normal-border`, `--border-radius`, `--toast-animation-duration`) — this is officially supported and faster than replacing. Sonner emits `data-type`/`data-expanded`/`data-visible` attributes that map 1:1 to the handoff's toast tones.
2. **axe-core via `vitest-axe` is NOT viable with current config** — the desktop Vitest runs `environment: "happy-dom"`, and axe has a documented incompatibility with happy-dom's `Node.prototype.isConnected` implementation. WCAG AA verification must use either (a) a dedicated jsdom environment for a11y tests, or (b) manual axe DevTools runs against a running dev build. Recommend (a): add an `a11y.test.tsx` suite with `// @vitest-environment jsdom` overrides.

**Primary recommendation:** Execute in 5 waves exactly as D-10 specifies. Wave 1 (tokens + primitives + fonts) is the highest-risk step because it retires `packages/ui/src/tokens.css` — run a grep-based migration audit before deletion to catch stale `--color-*` references.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Token definitions (`--sc-*`) | Shared UI package (`packages/ui`) | — | Consumed by desktop and future Storybook; must live outside apps |
| `Sc*` React primitives (Button/Input/Switch/…) | Shared UI package | — | Same reason; typed re-exports via `packages/ui/src/index.ts` |
| Custom titlebar + traffic-light/caption buttons | Frontend (React) | Tauri core (window decorations flip + window-control IPC) | `decorations: false` is Tauri-side; all rendering + drag regions + button click handlers are webview-side |
| Platform detection (`data-platform`) | Frontend (React) on boot | Tauri `@tauri-apps/plugin-os` | Read once in `main.tsx` before render, set on `<html>` |
| Theme/density/radius/accent-hue persistence | Frontend (Zustand) | Tauri `plugin-store` | Phase 13 pattern — mirror `initOutputPrefs()` at bootstrap |
| Command palette | Frontend (React + `cmdk`) | — | Route navigation via React Router; no IPC |
| Toast stack | Frontend (sonner, CSS-var skinned) | — | Existing infra preserved |
| Recording indicator | Frontend (React) | Existing recorder Zustand store | Floating pill driven by recorder state |
| TweaksPanel (dev-only) | Frontend (React) | Tauri `plugin-store` for persistence | Gated by `import.meta.env.DEV` |
| Window controls (min/max/close) | Frontend (event handlers) | `@tauri-apps/api/window` | `getCurrentWindow().minimize()` / `.toggleMaximize()` / `.close()` |

## Standard Stack

### Core (already installed — no new deps for primitives)
| Library | Version (verified) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `react`, `react-dom` | 19.x `[VERIFIED: apps/desktop/package.json]` | UI runtime | Matches committed stack |
| `@tauri-apps/api` | ^2.0.0 `[VERIFIED: package.json]` | `getCurrentWindow()` for min/max/close | Official |
| `@tauri-apps/plugin-os` | ^2.0.0 `[VERIFIED]` | Platform detection (`platform()` → `"macos" \| "windows"`) | Already a dependency |
| `@tauri-apps/plugin-store` | ^2.4.0 `[VERIFIED]` | Persist tweaks + theme | Phase 13 pattern (`initOutputPrefs`) |
| `motion` | ^12.0.0 `[VERIFIED]` | Animate sheet/palette/toast transitions | CLAUDE.md: `motion/react`, not framer-motion |
| `sonner` | ^1.7.0 `[VERIFIED]` | Toast stack (skinned via CSS vars) | Keep — CSS-variable theming is officially documented `[CITED: sonner README]` |
| `cmdk` | ^1.0.0 `[VERIFIED]` | Command palette internals | Committed stack |
| `lucide-react` | ^0.460.0 `[VERIFIED]` | Icons (replacement for handoff's `I.*` SVG set) | Already used throughout desktop app |
| `@base-ui-components/react` | ^1.0.0-beta.6 `[VERIFIED]` | a11y primitives (focus mgmt for Dialog/Popover/Menu when we need them) | CLAUDE.md committed |
| `react-hotkeys-hook` | ^4 `[VERIFIED]` | Register global palette/record shortcuts | Already used by post-production hotkeys |
| `@fontsource-variable/inter` | 5.2.x `[VERIFIED: npm view as of 2026-04]` | Inter variable font, offline | Replaces `@fontsource/inter/{400..700}.css` (4 static files → 1 variable) |
| `@fontsource-variable/jetbrains-mono` | 5.1.x `[VERIFIED: npm view]` | JetBrains Mono variable font, offline | Replaces static weight imports |

### Remove (D-11)
| Package | Reason |
|---------|--------|
| `@fontsource/lora` | D-11 drops Lora |
| `@fontsource-variable/outfit` | D-11 drops Outfit |
| `@fontsource/inter/400..700.css` | Replaced by `@fontsource-variable/inter` (one import) |
| `@fontsource/jetbrains-mono/{400,500}.css` | Replaced by variable version |

### New (for WCAG verification — Wave 5)
| Library | Version | Purpose | When |
|---------|---------|---------|------|
| `vitest-axe` | 0.1.x `[CITED: github.com/chaance/vitest-axe]` | axe-core matcher for Vitest | a11y unit tests — **requires jsdom env override** |
| `jsdom` (devDep) | ^25 | Environment for a11y tests only (happy-dom is incompatible with axe-core) | Wave 5 |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Keeping sonner + CSS-var skin | Replace with `motion/react`-driven `ToastStack` from handoff | More code to own; no real benefit — sonner already handles stacking, promise toasts, dismissal |
| `vitest-axe` with jsdom | axe DevTools (browser extension) against `pnpm tauri:dev` | Manual; not CI-friendly. Use as a secondary check, not primary |
| `tauri-plugin-decorum` for chrome | Roll our own | `decorum` adds opinionated platform chrome helpers but isn't necessary; the handoff already specifies exact visual output |

**Version verification commands run:**
```bash
npm view @fontsource-variable/inter version        # 5.2.x confirmed
npm view @fontsource-variable/jetbrains-mono version # 5.1.x confirmed
npm view vitest-axe version                        # 0.1.x
npm view sonner version                            # 1.7.x — CSS var theming present
```

## Architecture Patterns

### System Architecture Diagram

```
        ┌─────────────────────────────────────────────────────────────┐
        │ main.tsx                                                     │
        │  1. applyPersistedTheme()          (reads plugin-store)     │
        │  2. await plugin-os.platform()  →  html[data-platform]      │
        │  3. await initOutputPrefs()        (existing)               │
        │  4. render <App/>                                            │
        └──────────────────────────┬───────────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │ <App/>                       │
                    │  RouterProvider + sonner     │
                    │  <Toaster> (CSS-var skinned) │
                    └──────────────┬──────────────┘
                                   │
                ┌──────────────────▼──────────────────┐
                │  <AppLayout>  (was: Sidebar+StatusBar)│
                │   Replaced by <ScShell>:              │
                │     ┌─────────────────────────────┐   │
                │     │ <ScTitleBar platform=…/>    │   │  -webkit-app-region: drag
                │     │   mac: traffic lights       │   │  handlers: getCurrentWindow()
                │     │   win: caption buttons      │   │           .minimize/max/close
                │     ├────────────┬────────────────┤   │
                │     │ <ScSideNav>│ <Outlet/>      │   │
                │     │  groups +  │  ┌──────────┐  │   │
                │     │  record    │  │ route    │  │   │
                │     │  FAB       │  │ component│  │   │
                │     │            │  └──────────┘  │   │
                │     │            │  overlays:     │   │
                │     │            │   CommandPalette (cmdk + motion)  │
                │     │            │   RecordingIndicator              │
                │     │            │   TweaksPanel (dev only)          │
                │     └────────────┴────────────────┘   │
                └───────────────────────────────────────┘
                                   │
                  ┌────────────────┼────────────────┐
                  ▼                ▼                ▼
         plugin-store        Zustand stores   @tauri-apps/api/window
         (theme, tweaks)    (existing, unchanged)  (min/max/close)
```

Data flow for a window-control click: `ScTitleBar` button → `getCurrentWindow().minimize()` → Tauri core → native window manager. No IPC command layer needed (the window API is direct).

Data flow for theme toggle: Settings → Appearance → `useTweaksStore.setTheme('dark'|'light')` → (a) `html[data-theme]` attribute, (b) `plugin-store` persist.

### Recommended Project Structure

```
packages/ui/src/
├── claude-design/
│   ├── tokens.css          (already staged)
│   ├── app.css             (already staged)
│   ├── primitives/
│   │   ├── sc-button.tsx
│   │   ├── sc-input.tsx
│   │   ├── sc-badge.tsx
│   │   ├── sc-switch.tsx
│   │   ├── sc-card.tsx
│   │   ├── sc-kbd.tsx
│   │   ├── sc-slider.tsx
│   │   ├── sc-select.tsx
│   │   ├── sc-segmented.tsx
│   │   └── index.ts
│   └── index.ts            (re-exports)
└── index.ts                (public package surface)

apps/desktop/src/
├── components/
│   ├── sc-shell/
│   │   ├── sc-shell.tsx          (replaces AppLayout + FullscreenLayout)
│   │   ├── sc-title-bar.tsx      (platform-aware; ports chrome.jsx TitleBar)
│   │   ├── sc-side-nav.tsx       (ports chrome.jsx SideNav)
│   │   └── index.ts
│   ├── command-palette/
│   │   └── command-palette.tsx   (cmdk + motion, ports overlays.jsx CommandPalette)
│   ├── recording-indicator.tsx   (ports overlays.jsx RecordingIndicator)
│   └── tweaks-panel.tsx          (dev-only, ports primitives.jsx TweaksPanel)
├── stores/
│   └── tweaks-store.ts           (theme/accentHue/density/radius persisted via plugin-store)
├── lib/
│   ├── theme.ts                  (rewritten: plugin-store not localStorage)
│   └── platform.ts               (boot-time os.platform() read)
├── routes/
│   ├── dashboard.tsx             (ports dashboard.jsx)
│   ├── editor.tsx                (ports editor.jsx — preserve DSL/CM/LSP wiring)
│   ├── post-production.tsx       (ports postprod.jsx — preserve 6-slice store)
│   ├── settings.tsx              (ports settings.jsx + theme/accent toggle)
│   └── _design-system/
│       ├── tokens.tsx            (ports screens/tokens.jsx)
│       └── components.tsx        (ports screens/components.jsx)
└── features/export/
    └── export-modal.tsx          (restyle only — keep Phase 13 wiring)
```

### Pattern 1: `Sc*` primitive — render-prop over `<button>`
**What:** Plain HTML element + `.sc-*` class; accepts `asChild`-style ref forwarding when a parent needs to compose (e.g., Base UI Dialog trigger).
**When:** Every `sc-*` class that wraps a semantic HTML element.
**Example:**
```tsx
// packages/ui/src/claude-design/primitives/sc-button.tsx
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { clsx } from "clsx";

type Variant = "default" | "primary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg" | "icon";

export interface ScButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  kbd?: string;
}

export const ScButton = forwardRef<HTMLButtonElement, ScButtonProps>(
  ({ variant = "default", size = "md", icon, kbd, className, children, ...rest }, ref) => (
    <button
      ref={ref}
      className={clsx("sc-btn", variant !== "default" && variant, size !== "md" && size, className)}
      {...rest}
    >
      {icon}
      {size !== "icon" && children}
      {kbd && <span className="sc-kbd" style={{ marginLeft: 4 }}>{kbd}</span>}
    </button>
  ),
);
ScButton.displayName = "ScButton";
```

### Pattern 2: Platform detection on boot
```tsx
// apps/desktop/src/main.tsx (addition)
import { platform } from "@tauri-apps/plugin-os";

async function bootstrap() {
  const plat = await platform(); // "macos" | "windows" | "linux" | ...
  document.documentElement.dataset.platform = plat === "macos" ? "mac" : "win";
  await initOutputPrefs();
  await initTweaksStore(); // loads plugin-store, sets data-theme/data-density/data-radius, sets --sc-accent-h
  root.render(/* ... */);
}
```

### Pattern 3: sonner CSS-variable theming
```tsx
// apps/desktop/src/App.tsx
<Toaster
  position="bottom-left"      // match handoff ToastStack
  theme="dark"                // sync via useTweaksStore in actual impl
  style={{
    "--normal-bg": "var(--sc-surface)",
    "--normal-text": "var(--sc-text)",
    "--normal-border": "var(--sc-border-2)",
    "--border-radius": "var(--sc-r-lg)",
    "--toast-animation-duration": "200ms",
  } as React.CSSProperties}
/>
```
Sonner exposes `data-type` (`success|error|warning|info`) and `[data-sonner-toast]` attributes, so accent colors can be overridden per-tone in `app.css` `[CITED: github.com/emilkowalski/sonner]`.

### Pattern 4: `data-tauri-drag-region` on titlebar
The handoff CSS uses `-webkit-app-region: drag`. This is **NOT the Tauri v2 idiom**. Use `data-tauri-drag-region` on the titlebar root element. Children that are interactive (traffic lights, caption buttons) do NOT inherit drag — each child needs explicit handling; buttons omit the attribute and get `-webkit-app-region: no-drag` inline or via their own class `[CITED: v2.tauri.app/learn/window-customization]`.

### Anti-Patterns to Avoid
- **Don't use `-webkit-app-region: drag` alone.** It works in some webviews but Tauri's dedicated `data-tauri-drag-region` attribute is the supported path. Keep the CSS as a belt-and-suspenders fallback.
- **Don't call `getCurrentWindow()` at module top-level.** It's safe inside handlers; at module top-level during SSR/tests it throws.
- **Don't render the titlebar conditionally per-route.** It's part of the OS window shell — it must wrap every non-overlay route (including `region-overlay` is the exception — that window already uses `decorations: false + transparent: true` and has no chrome).
- **Don't remove `localStorage` fallback in `theme.ts` silently.** Phase 13's `initOutputPrefs` pattern keeps a graceful-degradation path. Mirror it.
- **Don't import `tokens.css` twice.** After Wave 1, `apps/desktop/src/styles.css` imports `@storycapture/ui/claude-design/tokens.css` and `@storycapture/ui/claude-design/app.css` only. No direct imports from routes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Fuzzy-matching command palette | Custom filter | `cmdk` (already installed) | cmdk handles keyboard nav, groups, match scoring, a11y |
| Toast stacking + swipe-to-dismiss + promise states | Port `ToastStack` from handoff | Skin `sonner` via CSS vars | sonner is battle-tested and already shipping |
| Focus management for CommandPalette / TweaksPanel | Custom focus trap | `@base-ui-components/react` `Dialog` / `Popover` as outer shell, `.sc-*` styling inside | Base UI handles focus trap, esc-close, scroll-lock, aria-modal |
| Platform detection via `navigator.userAgent` | Parse UA | `@tauri-apps/plugin-os` `platform()` | Official, correct for Tauri; plugin already installed |
| Window drag region | `-webkit-app-region: drag` only | `data-tauri-drag-region` attribute | Tauri v2 idiom; handles window manager quirks |
| Font loading from Google Fonts CDN | `@import url('fonts.googleapis.com...')` | `@fontsource-variable/{inter,jetbrains-mono}` | Offline-first constraint in CLAUDE.md; zero network |
| Accent-hue swatch picker animation | CSS transitions | `motion/react` `motion.button` with `whileHover`/`whileTap` | CLAUDE.md directive; consistency with app-wide motion |
| Variable-font weight loading | Four `.woff2` per weight | `@fontsource-variable/inter` single file | Smaller bundle, smoother weight interpolation |

**Key insight:** The handoff bundle re-implements a lot of things that `sonner` + `cmdk` + `Base UI` already provide. The port is a **styling exercise**, not a re-implementation. Every `.sc-*` class gets a thin React wrapper; anything with focus/keyboard semantics composes a Base UI primitive underneath the `.sc-*` skin.

## Runtime State Inventory

> This is a rename/replace phase (token system + font packages). Inventory required.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | **None.** No database or on-disk records reference Cursor-warm token names or `sc-*` names. `plugin-store` holds `output-prefs` (Phase 13) — keys are shape-based, not token-name-based. | None |
| Live service config | **None.** No external service (n8n, scheduled tasks) references token names. | None |
| OS-registered state | **None.** Tauri window state (`tauri-plugin-window-state`) stores x/y/w/h by window label `main`; no token refs. | None |
| Secrets/env vars | **None.** No env vars reference theme/token names. | None |
| Build artifacts | **`@fontsource/*` files** pulled into Vite bundle. After `pnpm remove @fontsource/lora @fontsource-variable/outfit @fontsource/inter @fontsource/jetbrains-mono` and re-install of variable versions, `pnpm install && pnpm --filter @storycapture/desktop build` regenerates. Also: `packages/ui/src/tokens.css` must be deleted or converted to a stub. | Dep swap + (optional) transitional stub in `tokens.css` re-exporting `--color-*` → `--sc-*` mappings for any missed grep hit; delete in Wave 5. |

**New-state this phase will introduce:**
- `plugin-store` gains a new store file for tweaks (`tweaks.json`, sibling to `output-prefs.json`). End-users who open the dev build and set accent hue will get a persisted file; removing the app data dir resets it.

## Common Pitfalls

### Pitfall 1: happy-dom breaks axe-core
**What goes wrong:** `vitest-axe` throws or returns false negatives when run under `environment: "happy-dom"`.
**Why it happens:** happy-dom's `Node.prototype.isConnected` diverges from the DOM spec; axe relies on it `[CITED: vitest-axe README]`.
**How to avoid:** Add `// @vitest-environment jsdom` pragma to a11y-only test files, OR configure a second Vitest project targeting jsdom for a11y. Install `jsdom` as devDep.
**Warning signs:** `TypeError: Cannot read properties of undefined` inside axe's node-walker, or every test passing with zero violations on known-bad fixtures.

### Pitfall 2: `decorations: false` on Windows loses resize handles
**What goes wrong:** Flipping decorations off on Windows removes the native invisible resize border. Users can't resize by dragging window edges.
**Why:** Windows requires the app to set extended window styles to preserve resize; Tauri v2 does this automatically on macOS but Windows requires a wider hit area or `WS_THICKFRAME`.
**How to avoid:** Verify resize on Windows QA; if broken, add `tauri-plugin-decorum` OR set `shadow: false` + CSS inset drag regions around the window edge (4px invisible `no-drag` with `cursor: nwse-resize` on corners) `[CITED: Tauri discussion #3093]`.
**Warning signs:** QA reports "can't resize the window on Windows."

### Pitfall 3: macOS traffic lights absent when `decorations: false`
**What goes wrong:** Setting `decorations: false` on macOS removes real traffic lights. Our render is visual-only — clicks on our CSS circles don't do anything.
**How to avoid:** Wire `onClick` on each traffic dot to `getCurrentWindow().close()` / `.minimize()` / `.toggleMaximize()`. Also set `macOSPrivateApi: true` (already in `tauri.conf.json`) and consider `titleBarStyle: "Overlay"` instead of `"Visible"` + `hiddenTitle: true` as a hybrid — but D-03 explicitly chose full custom chrome, so stick with it.
**Warning signs:** Traffic lights look right but clicks do nothing.

### Pitfall 4: `data-tauri-drag-region` doesn't cascade
**What:** Only the element with the attribute is draggable; children aren't.
**Why:** Documented behavior — prevents buttons/inputs inside a titlebar from becoming drag handles.
**How to avoid:** Put `data-tauri-drag-region` on the outer titlebar `<div>`. Children (traffic lights, caption buttons, subtitle) are NOT dragged; they work as buttons. For the title text / brand mark that ARE part of the drag surface but rendered as children, re-apply the attribute (or leave the space empty and let the parent handle it).

### Pitfall 5: Tailwind v4 `@theme` vs raw CSS vars coexistence
**What:** The current `packages/ui/src/tokens.css` uses `@theme` (Tailwind v4 directive — exposes tokens as utilities). Claude Design's `tokens.css` uses plain `:root { --sc-*: … }`.
**Result:** `sc-*` tokens will NOT generate Tailwind utilities (e.g., `bg-sc-surface`). That's fine for the port (we use `var(--sc-surface)` directly in CSS classes), but any future developer expecting `class="bg-sc-surface"` will find it missing.
**How to avoid:** Document this in `packages/ui/src/claude-design/README.md`. Optionally promote critical tokens via a small `@theme inline` block referencing the CSS vars. Defer unless needed.

### Pitfall 6: Prototype artifacts leak into build
**What goes wrong:** Copy-pasting from JSX sources brings in `window.parent.postMessage` edit-mode contracts, `localStorage` direct reads, Babel-standalone `<script>` tags, and CDN font links.
**How to avoid:** Port file-by-file and strip during conversion. Use a checklist per file:
- [ ] Remove `/* global React, … */` comments
- [ ] Replace `useState = React.useState` block with standard imports
- [ ] Replace `localStorage.get/setItem("sc-*")` with Zustand store actions
- [ ] Remove all `window.parent.postMessage` calls
- [ ] Remove all `window.SC_TWEAKS` global reads (use store)
- [ ] Remove `Object.assign(window, {...})` module footer
- [ ] Replace `I.*` icons with `lucide-react`
- [ ] Convert inline `style={…}` to Tailwind/CSS-var classes where practical, but keep one-off numbers inline

### Pitfall 7: CommandPalette shortcut collides with anything mapping `mod+k`
**What:** The handoff uses `Cmd/Ctrl+K`. Post-production already uses `mod+z`/`mod+y`, space, arrows, comma/period. No `mod+k` collision — **safe**.
**How to verify:** Grep `useHotkeys\("mod\+k"` before Wave 4. Confirmed clean as of research date.

### Pitfall 8: Sonner theme prop and CSS-var skin conflict
**What:** `<Toaster theme="dark|light">` applies sonner's own palette on top of your CSS vars. If you set `theme` AND `--normal-bg`, the CSS var wins, but sonner's default `theme="light"` adds a light border shadow.
**How to avoid:** Sync `theme` to the active `useTweaksStore().theme`. Or pass `theme="system"` and let `data-theme` on `<html>` drive everything via CSS vars.

## Code Examples

### Example 1: Tauri window config flip (D-03)
```json
// apps/desktop/src-tauri/tauri.conf.json (main window only)
{
  "label": "main",
  "title": "StoryCapture",
  "width": 1280, "height": 800,
  "minWidth": 1024, "minHeight": 640,
  "resizable": true,
  "decorations": false,
  "titleBarStyle": "Overlay",
  "hiddenTitle": true,
  "acceptFirstMouse": true
}
```
Keep `region-overlay` window unchanged — it already uses `decorations: false + transparent: true`.

### Example 2: Window controls hook
```tsx
// apps/desktop/src/components/sc-shell/sc-title-bar.tsx (excerpt)
import { getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();
const onMin = () => void win.minimize();
const onMax = () => void win.toggleMaximize();
const onClose = () => void win.close();
```

### Example 3: Tweaks store (Zustand + plugin-store)
```ts
// apps/desktop/src/stores/tweaks-store.ts (skeleton — full impl in plan)
import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";

type Theme = "dark" | "light";
interface Tweaks {
  theme: Theme;
  accentHue: number;
  density: "comfortable" | "compact";
  radius: "sharp" | "md" | "lg";
}

const DEFAULTS: Tweaks = { theme: "dark", accentHue: 78, density: "comfortable", radius: "md" };

export const useTweaksStore = create<Tweaks & { setTweak: <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void }>((set, get) => ({
  ...DEFAULTS,
  setTweak: (k, v) => {
    set({ [k]: v } as Partial<Tweaks>);
    applyTweaks(get());
    void persist(get());
  },
}));

function applyTweaks(t: Tweaks) {
  const r = document.documentElement;
  r.dataset.theme = t.theme;
  r.dataset.density = t.density;
  r.dataset.radius = t.radius;
  r.style.setProperty("--sc-accent-h", String(t.accentHue));
}

let storeP: Promise<Store> | null = null;
const getStore = () => (storeP ??= Store.load("tweaks.json"));
async function persist(t: Tweaks) { const s = await getStore(); await s.set("tweaks", t); await s.save(); }

export async function initTweaksStore() {
  const s = await getStore();
  const loaded = (await s.get<Tweaks>("tweaks")) ?? DEFAULTS;
  useTweaksStore.setState(loaded);
  applyTweaks(loaded);
}
```

### Example 4: a11y test with environment override
```tsx
// apps/desktop/src/components/sc-shell/__tests__/sc-title-bar.a11y.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { axe, toHaveNoViolations } from "vitest-axe";
import { ScTitleBar } from "../sc-title-bar";

expect.extend(toHaveNoViolations);

describe("ScTitleBar a11y", () => {
  it("has no violations on macOS chrome", async () => {
    const { container } = render(<ScTitleBar platform="mac" title="StoryCapture" subtitle="Projects" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Static per-weight `@fontsource/inter/500.css` | `@fontsource-variable/inter` | fontsource v5 (2024+) | Smaller bundle, all weights interpolated |
| `-webkit-app-region: drag` only | `data-tauri-drag-region` attribute | Tauri v2 | Correct handling inside Tauri webview |
| Manual `Cmd+K` + key listener + list-filter | `cmdk` library | 2023+ | a11y, keyboard nav, grouping, score-based match |
| `jest-axe` | `vitest-axe` | 2023+ | Native Vitest matchers; no Jest bridge |
| `localStorage` for user prefs | `tauri-plugin-store` | Phase 13 (this project) | Survives app-data relocation, transactional writes |
| Framer Motion (`framer-motion`) | `motion/react` | 2024 rebrand | Same API, new package |

**Deprecated / outdated:**
- Manual focus traps in modals → use Base UI `Dialog`/`Popover` (CLAUDE.md committed).
- `happy-dom` for a11y tests → jsdom. (happy-dom is fine for every other test, just not axe.)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `tauri-plugin-window-state` preserves window size/position after `decorations: false` flip | Pitfall 2 | User-facing: window opens at 1280×800 every time instead of last size. Verify during Wave 2. |
| A2 | Sonner's CSS variables (`--normal-bg` etc.) are stable API in 1.7.x | Pattern 3 | Would need to upgrade sonner or fork. Research cites README; API has been present since 1.4+. |
| A3 | All existing hotkeys (audited via `react-hotkeys-hook` grep) do not collide with `mod+k`, `mod+e`, `mod+shift+r`, `mod+1..5`, or `cmd+shift+.` | Pitfall 7 | Collision surfaces in QA as non-firing shortcut. Cheap to fix (rebind). |
| A4 | `@tauri-apps/plugin-os` `platform()` returns `"macos"`/`"windows"` (not `"darwin"`/`"win32"`) in v2 | Pattern 2 | Handler sets wrong `data-platform`. Verify on Wave 2 smoke test. |
| A5 | Fontsource variable fonts bundle LGPL-compatible licenses (Inter OFL, JetBrains Mono OFL) | Fonts | Both are OFL-1.1. No risk. |
| A6 | The Claude Design `postprod.jsx` mock reflects a subset of the existing 6-slice store's features; no new Zustand slice is needed | D-09 preservation | If mock shows a control we don't implement → defer (D-09). If mock omits something we have → retain. Planner must enumerate per-screen. |

## Open Questions (RESOLVED)

1. **RESOLVED:** **Should ported routes use `Sc*` primitives exclusively, or may they mix in existing shadcn `<Button>`/`<Select>` for un-designed controls?**
   - What we know: D-04 says "raw classNames are not used in ported JSX" — implies `Sc*` only for the restyle. Existing shadcn stays for non-ported features.
   - What's unclear: Within a ported screen, if the mock doesn't show a Select but the real app needs one (e.g., editor's encoder dropdown), do we use shadcn `<Select>` temporarily?
   - Recommendation: **Yes, use shadcn for gaps.** Restyle via a CSS override layer scoped to ported routes (`[data-route="editor"] .shadcn-select { … }`). Document as transitional; fold into `Sc*` in a later phase.

2. **RESOLVED:** **Does the `/_design-system` showcase route need to be behind a build-time flag?**
   - What we know: D-06f says hidden route, dev-shortcut only. D-08's `import.meta.env.DEV` gate applies to TweaksPanel explicitly.
   - Recommendation: Showcase route is reachable via URL `/_design-system` in production too, just not linked. TweaksPanel is DEV-only (keybind hidden in prod builds). Different gates because one exposes design tokens (harmless), the other exposes dev-only state toggles.

3. **RESOLVED:** **Editor route port (860 lines, largest existing route): how to sequence vs. Claude Design mock (436 lines)?**
   - The existing editor has CodeMirror 6, LSP bridge, Dry-Run panel, Selector Validator overlay, split-pane, scene-list, timeline, preview. Claude Design mock shows a two-pane editor with scene list + preview — it is a SUBSET of the current editor.
   - Recommendation: **Port the SHELL (toolbar, panels, tokens, split-pane dividers) using Claude Design visuals; preserve all child components (CodeMirror, DryRunPanel, etc.) as unchanged children.** No behavioral changes to DSL/LSP/DryRun this phase. Verify the editor still compiles CodeMirror themes against `--sc-*` vars.

4. **RESOLVED:** **Recorder route (not mocked, 531-line file): how much cosmetic refresh?**
   - D-05e says inherit new chrome + primitives + tokens but retain current layout. Recommendation: swap the page header font/colors to new tokens, replace sidebar use with the new `<ScShell>` side nav, leave recorder UI body unchanged this phase.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| pnpm | Package install | ✓ (CLAUDE.md) | 9.x | — |
| `@tauri-apps/plugin-os` | Platform detection at boot | ✓ | ^2.0.0 | — |
| `@tauri-apps/plugin-store` | Tweaks/theme persistence | ✓ | ^2.4.0 | localStorage (already used in `theme.ts`) |
| `@tauri-apps/api/window` | Window controls | ✓ | ^2.0.0 | — |
| `sonner` | Toasts | ✓ | ^1.7.0 | — |
| `cmdk` | Command palette | ✓ | ^1.0.0 | — |
| `motion` | Transitions | ✓ | ^12.0.0 | — |
| `@base-ui-components/react` | a11y primitives | ✓ | ^1.0.0-beta.6 | — |
| `@fontsource-variable/inter` | UI font | ✗ (needs install) | 5.2.x | — |
| `@fontsource-variable/jetbrains-mono` | Mono font | ✗ (needs install) | 5.1.x | — |
| `vitest-axe` | WCAG checks | ✗ (needs install) | 0.1.x | Manual axe DevTools |
| `jsdom` | a11y test env | ✗ (needs install) | ^25 | — |

**Missing dependencies with no fallback:** None — all are simple `pnpm add` steps.
**Missing dependencies with fallback:** `vitest-axe`/`jsdom` → if not installed in Wave 5, WCAG check falls back to manual DevTools sweep per ported screen.

## Validation Architecture

> Per `config.json` check (Nyquist absent → enabled). Include.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x + @testing-library/react 16.3.x `[VERIFIED: package.json]` |
| Config file | `apps/desktop/vitest.config.ts` (happy-dom) |
| Quick run command | `pnpm --filter @storycapture/desktop test -- <path>` |
| Full suite command | `pnpm --filter @storycapture/desktop test` |
| a11y subset | `pnpm --filter @storycapture/desktop test -- --testNamePattern="a11y"` |

### Phase Requirements → Test Map

Phase 14 has no mapped REQ-IDs (goal-backward from D-01..D-11). Derived test requirements:

| ID | Behavior | Test Type | Automated Command | File Exists? |
|----|----------|-----------|-------------------|-------------|
| D-01-T | `sc-*` tokens load; `--color-*` refs gone from desktop src | grep / unit | `rg "var\(--color-" apps/desktop/src \| wc -l` → 0 | ❌ add to Wave 1 smoke |
| D-02-T | `data-theme="dark"` / `"light"` both render primitives without contrast failures | a11y (vitest-axe+jsdom) | `vitest run --testNamePattern="theme a11y"` | ❌ Wave 5 |
| D-03-T | `<ScTitleBar platform="mac">` renders traffic lights; `platform="win"` renders caption buttons | unit | `vitest run components/sc-shell/sc-title-bar.test.tsx` | ❌ Wave 2 |
| D-03-T2 | Window control handlers invoke `@tauri-apps/api/window` | unit (mock) | mock `getCurrentWindow()`, assert `.minimize()` called | ❌ Wave 2 |
| D-04-T | Each `Sc*` primitive has a snapshot test | unit | `vitest run packages/ui/src/claude-design/primitives` | ❌ Wave 1 |
| D-05a..d-T | Each ported route renders without throwing (smoke) | unit | `vitest run routes/dashboard.test.tsx` | ❌ one per route (Wave 3) |
| D-06b-T | CommandPalette open/close via `mod+k` | unit | user-event keyboard `{Meta>}k` | ❌ Wave 4 |
| D-06c-T | Sonner toast renders with `--sc-*` CSS vars applied | visual / unit | assert `data-sonner-toast` element has inline `--normal-bg` | ❌ Wave 4 |
| D-07-T | All Phase 13 export-modal tests still pass after restyle | regression | `vitest run features/post-production/export-modal` | ✅ existing suite — must stay green |
| D-08-T | TweaksPanel does not render when `import.meta.env.DEV=false` | unit | mock `import.meta.env`, render assertion | ❌ Wave 5 |
| D-09-T | Every existing IPC/hotkey/Zustand test passes after each wave | regression | full `pnpm test` per wave | ✅ existing |
| D-11-T | Font CSS imports contain only Inter + JetBrains Mono | grep | `rg "fontsource" apps/desktop/src/styles.css` → 2 lines | ❌ Wave 1 |

### Sampling Rate
- **Per task commit:** quick `pnpm --filter @storycapture/desktop test -- <touched-path>`
- **Per wave merge:** full `pnpm --filter @storycapture/desktop test` + manual smoke of `pnpm tauri:dev`
- **Phase gate:** Full suite green + manual QA on both macOS and Windows for window chrome (Wave 2) and both themes (Wave 5) before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `apps/desktop/vitest.config.ts` — add a second project or test-file override for jsdom (a11y tests)
- [ ] `apps/desktop/src/test-setup.ts` — extend with `vitest-axe`'s `toHaveNoViolations` matcher (scoped to jsdom suite)
- [ ] Primitive test scaffold: `packages/ui/src/claude-design/primitives/__tests__/` directory + first snapshot test
- [ ] Framework install: `pnpm --filter @storycapture/desktop add -D vitest-axe jsdom`

## Project Constraints (from CLAUDE.md)

Directives that constrain this phase:
- **Tech stack:** Tauri v2 only; React 19 + Vite 6; Tailwind v4; Base UI (NOT Radix); `motion/react` (NOT `framer-motion`). ✅ All primitives + overlays respect this.
- **Accessibility:** WCAG 2.1 AA baseline. ✅ D-02 requires both themes; research recommends vitest-axe + jsdom.
- **Offline-first; no telemetry:** ✅ `@fontsource-variable/*` self-hosted; no CDN fonts.
- **Conventions:** kebab-case filenames, feature folders, Zustand one-slice-per-feature (post-production exception preserved). ✅
- **No workarounds:** If sonner skinning can't match a mock, replace properly; don't `!important`-splat.
- **No co-author in commits:** ✅ noted; enforced by commit-message policy.
- **Plan before breaking:** Wave 1 (token retirement) IS a breaking change — planner must enter plan mode for approval.
- **Keep agent docs in sync:** Wave 1 touches CLAUDE.md's "Project → Component library" paragraph (if sc-* replaces Cursor-warm mention). Planner to update `docs/CONVENTIONS.md` with primitive authoring patterns at end of phase.

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** `sc-*` becomes the single canonical token system. `packages/ui/src/tokens.css` retired. No dual-namespace.
- **D-02:** Dark + light both supported, dark default. Theme toggle in Settings. Both themes must pass WCAG 2.1 AA.
- **D-03:** Adopt Claude Design custom titlebar. `decorations: false`. Port `chrome.jsx`. Platform-driven via `@tauri-apps/plugin-os`. Side-nav + toolbar shell live in the same component.
- **D-04:** `.sc-*` CSS wrapped as typed React primitives under `packages/ui/src/claude-design/`. Ported screens consume React components, not raw classNames. shadcn+Base UI stays for un-ported features.
- **D-05a..e:** Port dashboard, editor, post-production, settings routes. Recorder + index (router) inherit tokens only, no redesign.
- **D-06a..f:** Chrome shell, CommandPalette, ToastStack, RecordingIndicator, TweaksPanel, `/_design-system` showcase.
- **D-07:** Port export.jsx visual only into `features/export/export-modal.tsx` — preserves ENC-12..ENC-19 wiring.
- **D-08:** TweaksPanel dev-only (`import.meta.env.DEV` + non-conflicting keybind). Settings→Appearance exposes theme + accent hue only. Density/radius dev-only.
- **D-09:** Visual-only port. Every IPC/Zustand/hotkey/motion/CM/LSP/WebGPU/channel preserved. Mock-shown-but-unimplemented → deferred. App-has-but-mock-omits → retained.
- **D-10:** Big-bang per wave rollout (5 waves). Old route files deleted in the same commit that introduces the new one. No feature flags, no long-lived parallel old/new.
- **D-11:** Inter + JetBrains Mono only. Drop Lora + Outfit imports.

### Claude's Discretion

- Primitive naming inside `packages/ui/src/claude-design/` (must not collide with shadcn) — **recommend `Sc*` prefix** (`ScButton`, `ScInput`, etc.); filenames kebab-case (`sc-button.tsx`).
- Toast mechanics — **recommend SKIN sonner via CSS variables**; API fit is excellent, replacement is unnecessary work.
- Dev TweaksPanel keyboard shortcut — **recommend `Cmd/Ctrl+Shift+.`** (no current collision with `mod+z`, `mod+y`, `mod+k`, `space`, arrows, `,`, `.`, `shift+,`, `shift+.`, `shift+left/right`).
- Motion token mapping — **use `motion/react` with `AnimatePresence`**: fade-in (toast/palette) = `{opacity: 0, y: 4} → {opacity: 1, y: 0}` at 180ms; sheet = spring `{stiffness: 300, damping: 32}`. Drop raw CSS `@keyframes sc-fade-in` in favor of motion components where present.
- WCAG verification — **`vitest-axe` + jsdom for automated**, manual axe DevTools against `pnpm tauri:dev` for supplementary. See Pitfall 1 — happy-dom is incompatible.
- Recorder/index visual treatment — **tokens + chrome only** for recorder; router index is not a view.
- Font strategy — **`@fontsource-variable/*`** (self-hosted, one import per family).
- Persistence migration — **port `lib/theme.ts` to plugin-store** mirroring Phase 13's `initOutputPrefs` pattern; keep localStorage fallback for graceful degradation.
- Prototype-artifact strip — checklist in Pitfall 6.
- `.jsx → .tsx` — strict typing on primitive props; `forwardRef` on every primitive; icon prop typed as `ReactNode`.

### Deferred Ideas (OUT OF SCOPE)

- Light-mode dedicated polish pass.
- Routes not mocked (`recorder.tsx`, any modal not in handoff) — token/chrome only, no redesign.
- Controls shown in Claude Design mocks that the app doesn't have (enumerate in plan, don't implement).
- Density + radius user-facing Settings controls (dev-only this phase).
- Storybook / full design-system site.
- Transitional stub for `packages/ui/src/tokens.css` — delete in Wave 5 cleanup.
- Replacing shadcn/Base UI globally.

## Phase Requirements

Phase 14 has no mapped REQ-IDs in `REQUIREMENTS.md`. Requirements are goal-backward from CONTEXT.md D-01..D-11. A derived table (for planner convenience):

| Derived ID | Description | Research Support |
|------------|-------------|------------------|
| D-01 | Retire Cursor-warm tokens; `sc-*` is canonical | Runtime State Inventory §build-artifacts; Pitfall 5 |
| D-02 | Dark + light themes, WCAG AA verified | Pattern 3; Pitfall 1; Validation D-02-T |
| D-03 | Custom Tauri chrome | Pattern 2, Example 1-2; Pitfalls 2-4 |
| D-04 | Sc* primitives in packages/ui | Pattern 1; Project Structure; Standard Stack |
| D-05a-e | Port dashboard/editor/postprod/settings routes | Open Q 3-4; Handoff inventory (file sizes) |
| D-06a-f | Overlays + showcase route | Standard Stack (cmdk, Base UI); Example 4 |
| D-07 | Export modal visual-only restyle | Existing file at `features/post-production/export-modal/`; Phase 13 tests regression-checked |
| D-08 | TweaksPanel dev-only | Validation D-08-T |
| D-09 | Visual-only; preserve behavior | Every "Preserve" note in existing-code context |
| D-10 | 5 waves big-bang | Executive recommendation |
| D-11 | Inter + JetBrains Mono only | Standard Stack §Remove |

## Sources

### Primary (HIGH confidence)
- Tauri v2 Window Customization — https://v2.tauri.app/learn/window-customization/
- Tauri v2 Configuration — https://v2.tauri.app/reference/config/
- sonner GitHub README — https://github.com/emilkowalski/sonner (CSS variables: `--normal-bg`, `--normal-text`, `--normal-border`, `--border-radius`, `--toast-animation-duration`)
- vitest-axe (chaance) — https://github.com/chaance/vitest-axe (happy-dom incompatibility documented)
- axe-core README — https://github.com/dequelabs/axe-core
- Claude Design handoff — `.planning/design/storycapture-claude-design/` (local; authoritative for visuals)
- Codebase inspection — `apps/desktop/package.json`, `apps/desktop/vitest.config.ts`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src/**`
- CONTEXT.md D-01..D-11 — locked decisions

### Secondary (MEDIUM confidence)
- Tauri discussion #3093 — macOS traffic-light/Windows caption-button customization patterns
- tauri-plugin-decorum — https://github.com/clearlysid/tauri-plugin-decorum (referenced, not adopted)
- `@fontsource-variable/inter` — https://www.npmjs.com/package/@fontsource-variable/inter
- `@fontsource-variable/jetbrains-mono` — https://www.npmjs.com/package/@fontsource-variable/jetbrains-mono
- Styling Sonner Toasts (Tiger) — https://tigerabrodi.blog/styling-sonner-toasts-advanced-guide

### Tertiary (LOW confidence — not load-bearing)
- Blog posts on shadcn/sonner integration (confirmatory only)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every dep verified against `apps/desktop/package.json`
- Architecture: HIGH — existing codebase structure read; Tauri docs verified
- Pitfalls: MEDIUM-HIGH — happy-dom↔axe bug is documented; Windows resize issue is known but varies by Tauri version
- Validation: MEDIUM — vitest-axe integration is standard but requires env switch; Wave 0 gaps are concrete

**Research date:** 2026-04-21
**Valid until:** 2026-05-21 (4 weeks — stable ecosystem, but sonner/Tauri minor releases can land)
