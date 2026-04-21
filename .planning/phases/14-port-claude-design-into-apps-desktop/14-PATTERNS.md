# Phase 14: Port Claude Design into apps/desktop — Pattern Map

**Mapped:** 2026-04-21
**Files analyzed:** 31 new/modified files
**Analogs found:** 28 / 31

## File Classification

### packages/ui — shared primitives

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/ui/src/claude-design/primitives/sc-button.tsx` | component (primitive) | request-response (event) | `apps/desktop/src/components/ui/button.tsx` | exact (same class: CVA-style variant + forwardRef + token classes) |
| `packages/ui/src/claude-design/primitives/sc-input.tsx` | component (primitive) | request-response (event) | `apps/desktop/src/components/ui/input.tsx` | exact |
| `packages/ui/src/claude-design/primitives/sc-switch.tsx` | component (primitive) | request-response | `apps/desktop/src/components/ui/toggle-group.tsx` | role-match (Base UI controlled-toggle pattern) |
| `packages/ui/src/claude-design/primitives/sc-badge.tsx` | component (primitive) | render-only | `apps/desktop/src/components/ui/button.tsx` (variant shape) | role-match |
| `packages/ui/src/claude-design/primitives/sc-card.tsx` | component (primitive) | render-only | `apps/desktop/src/components/ui/accordion.tsx` (item wrapper) | role-match |
| `packages/ui/src/claude-design/primitives/sc-kbd.tsx` | component (primitive) | render-only | — | no analog (trivial `<kbd>` span) |
| `packages/ui/src/claude-design/primitives/sc-slider.tsx` | component (primitive) | request-response | `apps/desktop/src/components/ui/slider.tsx` | exact |
| `packages/ui/src/claude-design/primitives/sc-select.tsx` | component (primitive) | request-response | `apps/desktop/src/components/ui/select.tsx` | exact |
| `packages/ui/src/claude-design/primitives/sc-segmented.tsx` | component (primitive) | request-response | `apps/desktop/src/components/ui/toggle-group.tsx` | exact |
| `packages/ui/src/claude-design/primitives/index.ts` | barrel | — | `apps/desktop/src/features/post-production/export-modal/index.ts` or any barrel | role-match |
| `packages/ui/src/claude-design/index.ts` | barrel | — | `packages/ui/src/index.ts` (stub) | role-match |
| `packages/ui/src/tokens.css` **DELETE** | config (CSS tokens) | — | current `packages/ui/src/tokens.css` | exact (deletion / stub rewrite) |
| `packages/ui/src/claude-design/tokens.css` | config (CSS tokens) | — | already staged | exact |
| `packages/ui/src/claude-design/app.css` | config (CSS primitives) | — | already staged | exact |

### apps/desktop — shell + overlays + lib

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/desktop/src/components/sc-shell/sc-shell.tsx` | component (layout) | render-only | `apps/desktop/src/components/title-bar.tsx` (`AppLayout` + `FullscreenLayout`) | exact |
| `apps/desktop/src/components/sc-shell/sc-title-bar.tsx` | component (platform chrome) | request-response (window controls) | `apps/desktop/src/components/title-bar.tsx` | role-match (replaces it entirely) |
| `apps/desktop/src/components/sc-shell/sc-side-nav.tsx` | component (nav) | request-response (routing) | `apps/desktop/src/components/sidebar.tsx` | exact |
| `apps/desktop/src/components/command-palette/command-palette.tsx` | component (overlay) | request-response (keyboard + navigation) | `apps/desktop/src/features/post-production/export-modal/export-modal.tsx` (Base UI Dialog pattern) | role-match |
| `apps/desktop/src/components/recording-indicator.tsx` | component (overlay) | subscription (Zustand selector) | `apps/desktop/src/components/status-bar.tsx` | role-match |
| `apps/desktop/src/components/tweaks-panel.tsx` | component (overlay, dev-only) | request-response + persistence | `apps/desktop/src/components/sidebar.tsx` theme-toggle block | role-match |
| `apps/desktop/src/stores/tweaks-store.ts` | state (Zustand + plugin-store) | event (hydrate + persist) | `apps/desktop/src/lib/output-prefs-persist.ts` + `apps/desktop/src/state/output-prefs.ts` | exact |
| `apps/desktop/src/lib/theme.ts` **REWRITE** | utility | event (hydrate) | existing `apps/desktop/src/lib/theme.ts` | exact |
| `apps/desktop/src/lib/platform.ts` | utility | event (boot) | `apps/desktop/src/main.tsx` (initialization hooks) | role-match |
| `apps/desktop/src/main.tsx` **MODIFY** | entry | event | current `main.tsx` | exact |
| `apps/desktop/src/App.tsx` **MODIFY** | entry | render-only | current `App.tsx` | exact |
| `apps/desktop/src/styles.css` **MODIFY** | config | — | current `styles.css` | exact |

### apps/desktop — routes ported

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/desktop/src/routes/dashboard.tsx` **REWRITE** | route | request-response (useProjects + navigate) | existing `routes/dashboard.tsx` | exact (visual-only restyle) |
| `apps/desktop/src/routes/editor.tsx` **RESTYLE** | route | streaming (LSP/CM/preview) | existing `routes/editor.tsx` | exact |
| `apps/desktop/src/routes/post-production.tsx` **RESTYLE** | route | streaming (6-slice store) | existing `routes/post-production.tsx` + `features/post-production/editor-shell.tsx` | exact |
| `apps/desktop/src/routes/settings.tsx` **REWRITE** | route | CRUD (settings + theme toggle) | existing `routes/settings.tsx` | exact |
| `apps/desktop/src/routes/_design-system/tokens.tsx` | route (hidden) | render-only | existing `routes/settings.tsx` (simple content route) | role-match |
| `apps/desktop/src/routes/_design-system/components.tsx` | route (hidden) | render-only | existing `routes/settings.tsx` | role-match |
| `apps/desktop/src/features/export/export-modal.tsx` **RESTYLE** (note: actual path `features/post-production/export-modal/export-modal.tsx`) | component (dialog) | CRUD (output-prefs store + IPC) | existing `features/post-production/export-modal/export-modal.tsx` | exact (visual-only) |

### apps/desktop — Tauri shell config

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/desktop/src-tauri/tauri.conf.json` **MODIFY** | config | — | current `tauri.conf.json` | exact (flip decorations + titleBarStyle + hiddenTitle) |
| `apps/desktop/package.json` **MODIFY** (font deps) | config | — | current `package.json` deps | exact (swap fontsource entries) |

---

## Pattern Assignments

### `packages/ui/src/claude-design/primitives/sc-button.tsx` (primitive)

**Analog:** `apps/desktop/src/components/ui/button.tsx` (63 lines, fully in scope)

**Imports pattern** (lines 14-17):
```tsx
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";
```

**Core pattern** — CVA + forwardRef + token-based classes (lines 19-61):
```tsx
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-default)] text-sm font-normal transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: { default: "...", outline: "...", ghost: "...", destructive: "...", pill: "..." },
      size: { default: "h-9 px-4 py-2", sm: "h-8 rounded-md px-3 text-xs", lg: "...", icon: "h-9 w-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
```

**Apply to `sc-button.tsx`:** keep CVA shape; replace token vars with `sc-*` (e.g., `rounded-[var(--sc-r-md)]`, `bg-[var(--sc-surface)]`); map variants `default | primary | ghost | danger | success` from claude-design's `.sc-btn` classes. Import path `@storycapture/ui` side has no `cn` helper — either colocate a `cn.ts` in `packages/ui/src/` or rely on `clsx` directly (RESEARCH Pattern 1 example uses raw `clsx`).

---

### `packages/ui/src/claude-design/primitives/sc-input.tsx` (primitive)

**Analog:** `apps/desktop/src/components/ui/input.tsx` (33 lines)

**Core pattern** (lines 8-31):
```tsx
import { Input as BaseInput } from "@base-ui-components/react/input";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  React.ElementRef<typeof BaseInput>,
  React.ComponentPropsWithoutRef<typeof BaseInput>
>(({ className, type, ...props }, ref) => (
  <BaseInput
    ref={ref}
    type={type}
    className={cn(
      "h-9 w-full min-w-0 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-2.5 py-1 text-xs text-[var(--color-fg-primary)] outline-none transition-colors",
      "placeholder:text-[var(--color-fg-muted)]",
      "hover:bg-[var(--color-surface-300)]",
      "focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "aria-[invalid=true]:border-[var(--color-danger)]",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
```

**Apply:** reuse Base UI `Input`; swap every `--color-*` for `--sc-*` equivalents per claude-design `app.css` `.sc-input` rules.

---

### `packages/ui/src/claude-design/primitives/sc-slider.tsx` (primitive)

**Analog:** `apps/desktop/src/components/ui/slider.tsx` (39 lines — exact Base UI Slider wrap)

**Core pattern:** Base UI `Slider.Root / Control / Track / Indicator / Thumb` with token classes. Replace `--color-surface-400`, `--color-accent-primary`, `--color-border-strong` with `--sc-surface-3`, `--sc-accent-500`, `--sc-border-strong`.

---

### `packages/ui/src/claude-design/primitives/sc-select.tsx` (primitive)

**Analog:** `apps/desktop/src/components/ui/select.tsx` (lines 1-50 read)

**Core pattern** (lines 12-43):
```tsx
import { Select as BaseSelect } from "@base-ui-components/react/select";
import { Check, ChevronDown } from "lucide-react";

export const Select = BaseSelect.Root;
export const SelectValue = BaseSelect.Value;
export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof BaseSelect.Trigger>,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Trigger ref={ref} className={cn("inline-flex w-full items-center justify-between ...", className)} {...props}>
    {children}
    <BaseSelect.Icon><ChevronDown size={13} /></BaseSelect.Icon>
  </BaseSelect.Trigger>
));
```

**Apply:** same decomposition; retoken.

---

### `apps/desktop/src/components/sc-shell/sc-title-bar.tsx` (component, platform chrome)

**Analog:** `apps/desktop/src/components/title-bar.tsx` (AppLayout/FullscreenLayout — tiny file; replaced wholesale)

**New imports (no analog — from RESEARCH Pattern 2 + Example 2):**
```tsx
import { getCurrentWindow } from "@tauri-apps/api/window";
```

**Drag region pattern (RESEARCH Pitfall 4 + Pattern 4):** put `data-tauri-drag-region` on the outer `<div>`; interactive children (traffic lights, caption buttons) inherit `no-drag` implicitly.

**Window controls** (from RESEARCH Example 2):
```tsx
const win = getCurrentWindow();
const onMin = () => void win.minimize();
const onMax = () => void win.toggleMaximize();
const onClose = () => void win.close();
```

**Platform attribute driven from `<html data-platform="mac|win">`** set by boot-time `platform.ts` (see below). Component reads it via `document.documentElement.dataset.platform` or accepts `platform` prop.

---

### `apps/desktop/src/components/sc-shell/sc-side-nav.tsx` (component, nav)

**Analog:** `apps/desktop/src/components/sidebar.tsx` (255 lines — FULL port target)

**Imports pattern** (lines 1-15):
```tsx
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Home, FileText, Film, Video, Settings, PanelLeftClose, PanelLeft, Sun, Moon } from "lucide-react";
import { BrandMark } from "@/components/brand";
import { getTheme, toggleTheme, type Theme } from "@/lib/theme";
```

**Nav-items data shape** (lines 28-60):
```tsx
interface NavItem {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  path: string;
  contextual?: boolean;
  matchPattern?: RegExp;
}
const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", icon: Home, path: "/" },
  { label: "Editor", icon: FileText, path: "/editor", contextual: true, matchPattern: /^\/editor\// },
  { label: "Post-Production", icon: Film, path: "/post-production", contextual: true, matchPattern: /^\/post-production\// },
  { label: "Recorder", icon: Video, path: "/recorder", contextual: true, matchPattern: /^\/recorder\// },
  { label: "Settings", icon: Settings, path: "/settings" },
];
```

**Active-state + collapsed UI pattern** (lines 105-175): preserve the `isActive` + `isVisible` helpers + grid-cols collapse animation. Retoken classes — `--color-surface-*` → `--sc-surface-*`, `--color-accent-primary` → `--sc-accent-500`, etc.

**Collapse persistence** (lines 76-94): already uses `localStorage` — migrate to `tauri-plugin-store` for consistency OR leave as-is (low-value persistence; RESEARCH doesn't mandate).

---

### `apps/desktop/src/stores/tweaks-store.ts` (state, Zustand + plugin-store)

**Analog:** `apps/desktop/src/lib/output-prefs-persist.ts` + `apps/desktop/src/state/output-prefs.ts` (Phase 13 pattern)

**Imports pattern** (output-prefs-persist.ts lines 1-12):
```ts
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { LATEST_VERSION, STORE_KEY, getStore } from "@/ipc/output-prefs";
```

**Core hydrate pattern** (lines 70-82):
```ts
export async function initOutputPrefs(): Promise<void> {
  let hydrated: PersistShape = { ...SEED };
  try {
    const store = await getStore();
    const raw = await store.get<PersistShape>(STORE_KEY);
    hydrated = migrate(raw);
    if (!raw || raw.version !== LATEST_VERSION) {
      await store.set(STORE_KEY, hydrated);
      await store.save();
    }
  } catch { /* graceful degradation */ }
}
```

**Apply:** mirror this for `tweaks.json`. Full skeleton given in RESEARCH §Code Examples 3 (lines 364-407 of RESEARCH.md). Store shape: `{ theme, accentHue, density, radius }`. `applyTweaks()` writes `data-theme` / `data-density` / `data-radius` on `<html>` and sets `--sc-accent-h` via `style.setProperty`.

---

### `apps/desktop/src/lib/theme.ts` **REWRITE** (utility)

**Analog:** existing `apps/desktop/src/lib/theme.ts` (40 lines — exact file being rewritten)

**Current pattern** (lines 14-39):
```ts
export function getTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "dark" ? "dark" : "light";
}
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try { window.localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
}
export function toggleTheme(): Theme { ... }
export function applyPersistedTheme(): void { setTheme(getTheme()); }
```

**Apply:** replace `localStorage` with `tauri-plugin-store` via `tweaks-store.ts`. Keep `localStorage` fallback path (RESEARCH Anti-Pattern: "don't remove silently"). Dark becomes the new default (was `"light"`). Re-export `toggleTheme` for the existing sidebar call sites until they're replaced.

---

### `apps/desktop/src/App.tsx` **MODIFY**

**Analog:** current `apps/desktop/src/App.tsx` (19 lines — exact file)

**Current pattern:**
```tsx
export default function App() {
  return (
    <>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <PanicModal />
      <RouterProvider router={router} />
      <Toaster position="bottom-right" theme="dark" richColors />
    </>
  );
}
```

**Apply:** swap `<Toaster>` props per RESEARCH §Pattern 3 — CSS-var skin:
```tsx
<Toaster
  position="bottom-left"
  theme={theme}  // from useTweaksStore()
  style={{
    "--normal-bg": "var(--sc-surface)",
    "--normal-text": "var(--sc-text)",
    "--normal-border": "var(--sc-border-2)",
    "--border-radius": "var(--sc-r-lg)",
    "--toast-animation-duration": "200ms",
  } as React.CSSProperties}
/>
```

---

### `apps/desktop/src/main.tsx` **MODIFY**

**Analog:** current `apps/desktop/src/main.tsx` (31 lines)

**Current bootstrap** (lines 19-28):
```tsx
async function bootstrap() {
  await initOutputPrefs();
  root.render(<StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>);
}
void bootstrap();
```

**Apply:** add platform + tweaks init before render (RESEARCH Pattern 2):
```tsx
import { platform } from "@tauri-apps/plugin-os";
import { initTweaksStore } from "./stores/tweaks-store";
// ...
async function bootstrap() {
  const plat = await platform();
  document.documentElement.dataset.platform = plat === "macos" ? "mac" : "win";
  await initTweaksStore();
  await initOutputPrefs();
  root.render(/* ... */);
}
```
Remove `applyPersistedTheme()` call — tweaks-store handles it.

---

### `apps/desktop/src/routes/dashboard.tsx` **REWRITE**

**Analog:** current `apps/desktop/src/routes/dashboard.tsx` (header lines 44-64 + scrollable body)

**Preserve verbatim** (D-09):
```tsx
const { data: projects, isLoading, error } = useProjects();
const { searchQuery, sortMode } = useDashboardStore();
const openProject = (id: string) => navigate(`/editor/${id}`);
```

**Header skeleton pattern** (lines 45-64) — restyle only, keep DOM structure:
```tsx
<main id="main-content" className="flex h-full flex-col">
  <header className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-6 py-3">
    <h1 className="text-sm font-semibold text-[var(--color-fg-primary)]">Projects</h1>
    <button onClick={() => setDialogOpen(true)} className="brand-button ...">
      <Plus size={14} /> New Project
    </button>
  </header>
  <PageContentTransition className="min-h-0 flex-1 overflow-y-auto">...</PageContentTransition>
</main>
```

**Apply:** replace `brand-button` with `<ScButton variant="primary">`; retoken borders/bg; compose body with `<ScCard>` for the project grid container. Keep `useProjects`, `useDashboardStore`, `PageContentTransition`, sub-features (`ProjectGrid`, `ProjectFilters`, `NewProjectDialog`) UNCHANGED.

---

### `apps/desktop/src/routes/editor.tsx` **RESTYLE**

**Analog:** current `apps/desktop/src/routes/editor.tsx` (860+ lines per Open Q 3)

**Imports top** (lines 1-36):
```tsx
import { invoke } from "@tauri-apps/api/core";
import { motion, useReducedMotion } from "motion/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { StoryEditor, type EditorJumpTarget } from "@/features/editor/story-editor";
import { PreviewPanel, SceneListPanel, TimelinePanel } from "@/features/editor/*";
import { TtsClipInspector, TtsScriptEditor, VoiceCatalogDialog } from "@/features/voiceover/*";
import { parseStory } from "@/ipc/parse";
// ... all existing children preserved
```

**Apply (per Open Q 3):** port SHELL only — toolbar background, split-pane divider colors, panel headers/borders use `--sc-*` tokens. Every child (`StoryEditor`, `PreviewPanel`, `SceneListPanel`, `TimelinePanel`, `TtsClipInspector`, `TtsScriptEditor`, DryRun, SelectorValidator) is left alone. CodeMirror theme may need `--sc-*` token mapping.

---

### `apps/desktop/src/routes/post-production.tsx` **RESTYLE**

**Analog:** current `apps/desktop/src/routes/post-production.tsx` (17 lines — thin wrapper; real work in `features/post-production/editor-shell.tsx`)

**Preserve verbatim:**
```tsx
import { EditorShell } from "@/features/post-production/editor-shell";
export default function PostProductionRoute() {
  const { storyId } = useParams<{ storyId: string }>();
  if (!storyId) return <div role="alert">Missing storyId in URL.</div>;
  return <EditorShell storyId={storyId} />;
}
```

**Apply:** no route-level changes. Restyling lives inside `editor-shell.tsx` children. 6-slice Zustand store (`export-slice`, `panels-slice`, `queue-slice`, `selection-slice`, `timeline-slice`, `undo-slice`) UNCHANGED per D-09.

---

### `apps/desktop/src/routes/settings.tsx` **REWRITE**

**Analog:** current `apps/desktop/src/routes/settings.tsx` (20 lines)

**Current pattern:**
```tsx
<main id="main-content" className="flex h-full flex-col">
  <header className="flex shrink-0 items-center border-b ...">
    <h1 className="text-sm font-semibold ...">Settings</h1>
  </header>
  <PageContentTransition>
    <div className="mx-auto max-w-5xl px-8 py-8">
      <AccountsPage />
    </div>
  </PageContentTransition>
</main>
```

**Apply:** retoken chrome; add Appearance section with `<ScSegmented>` (theme) and accent-hue slider/swatch picker reading `useTweaksStore`. Keep existing `<AccountsPage />` wiring.

---

### `apps/desktop/src/features/post-production/export-modal/export-modal.tsx` **RESTYLE** (D-07)

**Analog:** current file (lines 17-80 read — this IS the target; restyle in place)

**Preserve verbatim** (D-07 + D-09):
```tsx
import { Dialog } from "@base-ui-components/react/dialog";
import type { EncoderOptionsDto, HardwareEncoderDto } from "@storycapture/shared-types";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { AiDisclosureModal } from "@/features/export/AiDisclosureModal";
import { useVoiceoverStore } from "@/features/voiceover/voiceoverStore";
import { type ExportOutput, exportRun, exportValidateConfig } from "@/ipc/export";
import { type ExportKnobs, useOutputPrefsStore } from "@/state/output-prefs";
import { AdvancedOutputOptions } from "./advanced-output-options";
import { FormatCheckboxes } from "./format-checkboxes";
import { ResolutionPicker } from "./resolution-picker";
```

**Apply:** swap `Button` → `ScButton`, retoken Dialog surfaces; leave `AdvancedOutputOptions`, `FormatCheckboxes`, `ResolutionPicker`, all IPC & store wiring (`exportRun`, `exportValidateConfig`, `useOutputPrefsStore`, `HW_UI_TO_DTO`, `buildEncoderOptions`) untouched. Phase 13 tests (`features/post-production/__tests__/export-modal.test.tsx`) must stay green.

---

### `apps/desktop/src-tauri/tauri.conf.json` **MODIFY**

**Analog:** current `tauri.conf.json` (main window block lines 14-27)

**Current:**
```json
{
  "label": "main",
  "title": "StoryCapture",
  "width": 1280, "height": 800,
  "minWidth": 1024, "minHeight": 640,
  "resizable": true,
  "decorations": true,
  "titleBarStyle": "Visible",
  "acceptFirstMouse": true,
  "hiddenTitle": false
}
```

**Apply** (RESEARCH §Code Example 1):
```json
"decorations": false,
"titleBarStyle": "Overlay",
"hiddenTitle": true
```

**macOS-private-API** (`"macOSPrivateApi": true` at line 13) already set — keep.
**Do NOT touch** `region-overlay` window (already headless-transparent).

---

### `apps/desktop/package.json` **MODIFY** (font deps)

**Analog:** current deps (lines 24-28):
```json
"@fontsource-variable/outfit": "^5.2.8",
"@fontsource/inter": "^5.2.8",
"@fontsource/jetbrains-mono": "^5.1.0",
"@fontsource/lora": "^5.2.8",
```

**Apply (D-11):** remove Lora + Outfit + static Inter + static JetBrains; add variable versions:
```json
"@fontsource-variable/inter": "^5.2.0",
"@fontsource-variable/jetbrains-mono": "^5.1.0"
```

And in `apps/desktop/src/styles.css` replace the 10-line fontsource block with:
```css
@import "@fontsource-variable/inter";
@import "@fontsource-variable/jetbrains-mono";
```

---

## Shared Patterns

### Base UI + CVA primitive composition (`Sc*` primitives)

**Source:** `apps/desktop/src/components/ui/button.tsx` + `slider.tsx` + `select.tsx` + `accordion.tsx`
**Apply to:** every file in `packages/ui/src/claude-design/primitives/*.tsx`

Common skeleton:
```tsx
import { <Primitive> as Base<Primitive> } from "@base-ui-components/react/<primitive>";
import * as React from "react";
import { cn } from "<helper>"; // or clsx directly

export const ScXxx = React.forwardRef<
  React.ElementRef<typeof Base<Primitive>>,
  React.ComponentPropsWithoutRef<typeof Base<Primitive>>
>(({ className, ...props }, ref) => (
  <Base<Primitive>
    ref={ref}
    className={cn("... sc-* token classes ...", className)}
    {...props}
  />
));
ScXxx.displayName = "ScXxx";
```

**Notes:**
- `packages/ui/` does not currently expose `cn`. Either (a) copy `cn` into `packages/ui/src/lib/utils.ts`, or (b) use `clsx` + `tailwind-merge` directly per primitive. RESEARCH Pattern 1 example uses raw `clsx`.
- Every primitive `forwardRef` + `displayName` (required for React devtools and Base UI composition).

### Tauri plugin-store hydration (Phase 13 pattern)

**Source:** `apps/desktop/src/lib/output-prefs-persist.ts` (lines 70-95) + `apps/desktop/src/state/output-prefs.ts`
**Apply to:** `apps/desktop/src/stores/tweaks-store.ts`

```ts
// 1. Zustand store with shape + actions
export const useTweaksStore = create<Tweaks & Actions>((set, get) => ({ ...DEFAULTS, setTweak: (k, v) => { set({ [k]: v }); applyTweaks(get()); void persist(get()); } }));

// 2. Boot-time hydrate called from main.tsx
export async function initTweaksStore() {
  const s = await getStore();
  const loaded = (await s.get<Tweaks>("tweaks")) ?? DEFAULTS;
  useTweaksStore.setState(loaded);
  applyTweaks(loaded);
}

// 3. Side-effect apply to <html> dataset + CSS var
function applyTweaks(t: Tweaks) {
  const r = document.documentElement;
  r.dataset.theme = t.theme;
  r.dataset.density = t.density;
  r.dataset.radius = t.radius;
  r.style.setProperty("--sc-accent-h", String(t.accentHue));
}
```

### Route shell (header + PageContentTransition + body)

**Source:** `apps/desktop/src/routes/dashboard.tsx` (lines 45-80) + `apps/desktop/src/routes/settings.tsx` (full)
**Apply to:** all ported routes

```tsx
<main id="main-content" className="flex h-full flex-col">
  <header className="flex shrink-0 items-center justify-between border-b border-[var(--sc-border-2)] bg-[var(--sc-surface)] px-6 py-3">
    <h1 className="text-sm font-semibold text-[var(--sc-text)]">{title}</h1>
    {headerActions}
  </header>
  <PageContentTransition className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto max-w-5xl px-8 py-8">{content}</div>
  </PageContentTransition>
</main>
```

`PageContentTransition` from `@/components/page-content-transition` is kept — it already uses `motion/react` (the committed transition library).

### Sonner CSS-variable skin

**Source:** RESEARCH Pattern 3 + `apps/desktop/src/App.tsx` line 15
**Apply to:** `App.tsx` Toaster

Already covered above — single site of change.

### `data-tauri-drag-region` placement

**Source:** RESEARCH Pitfall 4 + Anti-Patterns
**Apply to:** `sc-title-bar.tsx` outer `<div>`

Children that are interactive (traffic lights, caption buttons, nav crumbs) do NOT get the attribute; they get normal `onClick` handlers that call `getCurrentWindow().minimize() | .toggleMaximize() | .close()`.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/desktop/src/components/sc-shell/sc-title-bar.tsx` platform-specific chrome | component (chrome) | — | No existing custom-decoration titlebar in the codebase; current `title-bar.tsx` is just layout. Use RESEARCH §Pattern 4 + Example 2 as source of truth. |
| `apps/desktop/src/components/command-palette/command-palette.tsx` | overlay (cmdk + motion) | — | `cmdk` is installed but not used anywhere yet. Reference `.planning/design/storycapture-claude-design/project/components/overlays.jsx` for visual; use `cmdk` + Base UI `Dialog` for behavior. |
| `apps/desktop/src/lib/platform.ts` | utility (boot-time os probe) | — | No current boot-time platform probe. New file; pattern fully captured in RESEARCH §Pattern 2. |

For these three files, planner should reference RESEARCH.md Patterns/Examples directly rather than hunting for analogs.

---

## Metadata

**Analog search scope:**
- `apps/desktop/src/components/`
- `apps/desktop/src/components/ui/` (Base UI + CVA primitives)
- `apps/desktop/src/routes/`
- `apps/desktop/src/features/post-production/export-modal/`
- `apps/desktop/src/lib/`
- `apps/desktop/src/stores/` + `apps/desktop/src/state/`
- `packages/ui/src/`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/package.json`

**Files scanned:** ~30 (targeted reads of button/input/slider/select/accordion + sidebar + title-bar + routes dashboard/settings/editor/post-production + export-modal header + output-prefs-persist + theme.ts + main/App/styles/package/tauri.conf + claude-design staged assets)

**Pattern extraction date:** 2026-04-21
