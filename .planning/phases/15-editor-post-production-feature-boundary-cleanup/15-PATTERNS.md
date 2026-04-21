# Phase 15: Editor/Post-Production feature boundary cleanup — Pattern Map

**Mapped:** 2026-04-21
**Files analyzed:** 7 new/modified
**Analogs found:** 7 / 7 (all have strong in-repo analogs)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/desktop/src/features/post-production/voiceover-compact/voiceover-compact.tsx` (moved from `routes/editor.tsx`) | feature-component | event-driven (Zustand + IPC) | (itself — lines 132-455 of `routes/editor.tsx`) | exact (same code, relocated) |
| `apps/desktop/src/components/preview-surface/preview-surface.tsx` (new, `mode` prop) | shared-component | streaming / request-response | `features/post-production/preview/preview-player.tsx` (composited) + `features/editor/preview-panel.tsx` (static stage) | exact composite |
| `apps/desktop/src/routes/post-production-landing.tsx` (new, empty-state landing) | route | CRUD (list projects) | `routes/dashboard.tsx` | exact — project-picker grid |
| `apps/desktop/src/routes/editor.tsx` — "Send to Post-Production" toolbar button | route-modification | request-response | existing `Dry run` + `Record` cluster in `editor.tsx` L685-709 | exact (same action cluster) |
| `apps/desktop/src/routes/editor.tsx` — read-only scene-list rail | route-modification | derived state from Zustand | `features/editor/scene-list-panel.tsx` (already exists) | **exact — component already exists and is already wired** |
| `apps/desktop/src/routes/index.tsx` — landing route entry | config | request-response | existing `{ path: "/post-production/:storyId", ... }` entry | exact |
| `apps/desktop/src/components/sidebar.tsx` — Post-Production `matchPattern` | config | n/a | existing `matchPattern: /^\/post-production(\/|$)/` (already covers both) | exact — **no change needed** |

---

## Pattern Assignments

### `features/post-production/voiceover-compact/voiceover-compact.tsx` (feature-component, event-driven)

**Analog:** itself, currently inlined at `apps/desktop/src/routes/editor.tsx` lines 132–455.

**Move source:** `routes/editor.tsx` lines 46–126 (voiceover helper types/functions: `VoiceoverStep`, `summariseScript`, `describeTarget`, `buildSuggestedScript`, `buildVoiceoverSteps`, `findSceneIndexForOffset`) + lines 130–455 (`VoiceoverCompact` component).

**External deps the component already imports (keep verbatim per D-11):**
```typescript
import { invoke } from "@tauri-apps/api/core";
import { Mic2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TtsClipInspector } from "@/features/voiceover/TtsClipInspector";
import { TtsScriptEditor } from "@/features/voiceover/TtsScriptEditor";
import { useVoiceoverStore } from "@/features/voiceover/voiceoverStore";
import type { Command, SelectorOrText, Story } from "@/ipc/parse";
```

**Call sites removed by the move (Editor side):**
- `routes/editor.tsx` L31-34 — drop `TtsClipInspector`, `TtsScriptEditor`, `VoiceCatalogDialog`, `useVoiceoverStore` imports.
- `routes/editor.tsx` L10,12 — drop `Mic2`, `Sparkles` from `lucide-react`.
- `routes/editor.tsx` L128 — drop `type RailTab = "preview" | "voiceover";`.
- `routes/editor.tsx` L457-495 — drop `RailTabButton` (only used by voiceover rail).
- `routes/editor.tsx` L505 — drop `const [railTab, setRailTab] = useState<RailTab>("preview");`.
- `routes/editor.tsx` L852-952 — collapse the tabbed right rail into a single preview rail (no tabs).
- `routes/editor.tsx` L967 — drop `<VoiceCatalogDialog projectId={projectId} />`.

**Post-move Post-Production consumer:** `EditorShell` mounts `VoiceoverCompact` directly or via `InspectorPanel` — planner picks; the Voiceover tab sits alongside the existing `Mic` icon in `editor-shell.tsx` L199-202 which is currently a disabled placeholder.

**Test migration:** No existing `VoiceoverCompact.test.tsx` — tests for `TtsScriptEditor`/`VoiceCatalogDialog` already live in `features/voiceover/` and stay put. Add a new smoke test colocated: `features/post-production/voiceover-compact/voiceover-compact.test.tsx` only if behavior changes; per D-11 behavior does not change → skip.

---

### `components/preview-surface/preview-surface.tsx` (shared-component, streaming | request-response)

**Analog (composited mode):** `features/post-production/preview/preview-player.tsx` — full WebGPU+`<video>` engine at lines 1–223. The `mode="composited"` branch is a thin wrapper that forwards `{storyId, videoSrc, width, height}` into this existing component.

**Analog (recording mode):** `features/editor/preview-panel.tsx` — viewport-switcher + thumbnail stage at lines 23–159. The `mode="recording"` branch reuses this layout but swaps the static `thumbnailPath` for the latest recording frame/video via `fetchProjectFolder(projectId).exports_dir`.

**Imports pattern (composited mode, from preview-player L17-25):**
```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Film } from "lucide-react";
import { useEditorStore } from "../state/store";
import { PreviewEngine } from "./preview-engine";
import { TransportControls } from "./transport-controls";
```

**WebGPU lifecycle pattern (preview-player.tsx L65-97) — CRITICAL to preserve per D-11:**
```typescript
// Single GPU context per mount — D-33.
useEffect(() => {
  const canvas = canvasRef.current;
  const video = videoRef.current;
  if (!canvas || !video) return;
  let disposed = false;
  const engine = new PreviewEngine({ canvas, videoElement: video, outputWidth: width, outputHeight: height });
  engine.init().then(() => {
    if (disposed) { engine.dispose(); return; }
    engineRef.current = engine;
    setReady(true);
  });
  return () => {
    disposed = true;
    engineRef.current?.dispose();
    engineRef.current = null;
    setReady(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```
Mount this hook inside `PreviewSurface` **only when `mode === "composited"`** so Editor's recording-mode mount does not warm a GPU context it won't use. Route-change remount is fine — the existing `<PageContentTransition>` wrapper already keys by route.

**Recording-mode resolved-src pattern (adapted from preview-player L140-144):**
```typescript
const resolvedSrc = videoSrc
  ? videoSrc.startsWith("asset:") || videoSrc.startsWith("http")
    ? videoSrc
    : convertFileSrc(videoSrc)
  : undefined;
```

**Props shape suggestion:**
```typescript
export interface PreviewSurfaceProps {
  mode: "recording" | "composited";
  projectId?: string;          // required for recording mode
  storyId?: string;            // required for composited mode
  videoSrc?: string;
  width?: number;
  height?: number;
}
```

---

### `routes/post-production-landing.tsx` (route, CRUD)

**Analog:** `routes/dashboard.tsx` lines 1–326 — same role (project picker + empty-state).

**Imports pattern (dashboard.tsx L1-12):**
```typescript
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import { ScButton, ScCard, ScInput } from "@storycapture/ui";
import { useProjects, type Project } from "@/ipc/projects";
import { PageContentTransition } from "@/components/page-content-transition";
import { ProjectGrid } from "@/features/dashboard/project-grid";
```

**Data hook (already exists) — `ipc/projects.ts` L36-41:**
```typescript
export function useProjects() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: () => invoke<Project[]>("list_projects"),
  });
}
```
Reuse directly. Per D-06 Claude's Discretion: the landing route MAY reuse `ProjectGrid` from `features/dashboard/project-grid.tsx` with a different `onOpen` handler that navigates to `/post-production/${id}` instead of `/editor/${id}` (dashboard.tsx L146: `const openProject = (id: string) => navigate("/editor/${id}");`).

**Empty-state pattern (dashboard.tsx L43-130):** Use this exact `EmptyDashboard` structure — headline, subline, CTA row, `⌘K` hint — but reword copy for "No recordings yet. Record a story to start post-production." per D-06.

**Toolbar shell (dashboard.tsx L183-222):** Same `sc-toolbar` → title/meta → `sc-spacer` → search + actions layout. Post-Production landing may omit `New Story` since it's not the project-creation surface.

**"Recording exists" filter (new — uses existing data):**
```typescript
// ProjectFolderInfo.session_count from ipc/projects.ts L28 is the signal.
// Landing can split projects into "with recordings" (session_count > 0) and
// "no recordings yet" groups. Requires per-project fetchProjectFolder() OR
// a new lightweight batched probe — planner picks.
```
Per `14-03a-SUMMARY.md` L68: `session_count` is only available via `open_project`, not `list_projects` → causes N+1. Planner should either (a) accept the N+1 with Suspense per card, (b) defer the split and show all projects, or (c) add a batched read — **(b) is the safe default for this phase**.

---

### `routes/editor.tsx` — "Send to Post-Production" toolbar button (route-modification, request-response)

**Analog:** existing `Dry run` + `Record` action cluster at `routes/editor.tsx` lines 685–709:
```typescript
<div style={{ display: "flex", gap: 4, alignItems: "center" }}>
  {ready && errorCount === 0 && warningCount === 0 && (
    <ScBadge tone="muted" icon={<Check size={10} aria-hidden="true" />}>
      Lint clean
    </ScBadge>
  )}
  {projectId && (
    <>
      <div style={{ width: 1, height: 18, background: "var(--sc-border)", margin: "0 4px" }} />
      <ScButton size="sm" icon={<Terminal size={12} aria-hidden="true" />}>
        Dry run
      </ScButton>
      <Link to={`/recorder/${projectId}`} className="sc-btn primary sm">
        <Video size={12} aria-hidden="true" />
        Record
      </Link>
    </>
  )}
</div>
```

**Pattern to copy:** Add a `<Link to={`/post-production/${projectId}`}>` or `<ScButton>` sibling using the same `sc-btn` / `ScButton size="sm"` shape. Use `Scissors` from `lucide-react` (already used in `sidebar.tsx` L7 and `editor-shell.tsx` L31 for Post-Production) for visual parity.

**Disabled-state check (D-07) — reuse `ProjectFolderInfo.session_count`:**
```typescript
// Already loaded in editor.tsx L502 (`folder: ProjectFolderInfo | null`) via
// fetchProjectFolder(projectId) at L530. No new IPC needed.
const canSendToPostProd = (folder?.session_count ?? 0) > 0;
```
When `canSendToPostProd` is false: render `<ScButton disabled>` instead of `<Link>` (Link can't be disabled; pattern already diverges in the Dry run vs Record pair above).

**Enabled-pulse hook (D-07, subtle accent pulse after first recording):** Store a boolean in `useDashboardStore` (already flagged in CONTEXT.md code_context: "`useDashboardStore` is already wired for palette open + new-project-request flags — if a small UI-state flag is needed for 'just recorded' → handoff pulse, reuse this store."). Reference pattern: `state/projects.ts` consume/request pair used at dashboard.tsx L136-137, L150-154.

---

### `routes/editor.tsx` — read-only scene-list rail (route-modification, derived state)

**KEY FINDING:** `features/editor/scene-list-panel.tsx` **already exists** (130 lines), **already derives scenes from the parser AST via `useEditorStore((s) => s.lastParse?.ast)`** (L32), and **is already wired into Editor's left panel** at `routes/editor.tsx` L730-739:
```typescript
{sceneCount > 0 && (
  <>
    <Panel defaultSize={12} minSize={8} maxSize={18}>
      <SceneListPanel
        activeSceneIndex={activeSceneIndex}
        onSelectScene={handleSelectScene}
      />
    </Panel>
    <PanelResizeHandle ... />
  </>
)}
```

**Implication for D-08:** The "new read-only scene-list rail" is essentially already shipped. Phase 15's work reduces to:
1. **Parse-error fallback** (D-08 second half): show last-valid scene set with muted "parse error — showing last known" note. Current `SceneListPanel` clears when `ast` is null. Pattern to add: cache last non-null `ast` in local state or a new Zustand selector, render it muted when `lastParse.diagnostics.some((d) => d.severity === "error")`.
2. **Unhide when `sceneCount === 0`**: current L730 gates the panel behind `sceneCount > 0` — remove that guard so the empty/parse-error state is visible.

**Diagnostics source (already in editor.tsx L515-516):**
```typescript
const diagnostics = useEditorStore((s) => s.lastParse?.diagnostics) ?? EMPTY_DIAGNOSTICS;
```

**Muted error-treatment pattern** — match Phase 14 `sc-*` error treatment (from editor.tsx L674-677):
```typescript
<ScBadge tone="record">  // or "warn" for softer treatment
  {errorCount} {errorCount === 1 ? "error" : "errors"}
</ScBadge>
```
Apply inside `SceneListPanel` header as a small chip when showing a stale tree.

---

### `routes/index.tsx` — router entry for `/post-production` landing (config)

**Analog:** existing route entry at `routes/index.tsx` L25:
```typescript
{ path: "/post-production/:storyId", element: <PostProductionRoute /> },
```

**Pattern to copy:** add a sibling entry `{ path: "/post-production", element: <PostProductionLandingRoute /> }` **before** the param route so React Router v7 data-router precedence works — actually precedence is order-agnostic for static vs param routes in v7, but keeping static first is project convention (see `/` before `/editor/:projectId`).

**Layout placement (D-06):** The landing is a dashboard-style page → it belongs under `AppLayout` (with sidebar chrome) just like `DashboardRoute`:
```typescript
{
  element: <AppLayout />,
  children: [
    { path: "/", element: <DashboardRoute /> },
    { path: "/post-production", element: <PostProductionLandingRoute /> },  // NEW
    { path: "/settings", element: <SettingsRoute /> },
  ],
},
```
The story-specific `/post-production/:storyId` currently sits under `FullscreenLayout` (L21-26). Keep that — the landing and the workspace have different chrome needs.

---

### `components/sidebar.tsx` — Post-Production nav entry (config)

**Analog:** existing entry at `sidebar.tsx` L43-48:
```typescript
{
  id: "post",
  label: "Post-Production",
  icon: Scissors,
  path: "/post-production",
  matchPattern: /^\/post-production(\/|$)/,
},
```

**Finding:** The entry **already points to `/post-production`** (no storyId) and the `matchPattern` **already covers both landing + story routes** (`^\/post-production(\/|$)`). **No change required** beyond verifying the landing route exists — clicking this link today 404s via the `<Navigate to="/" replace />` catch-all at `routes/index.tsx` L32.

---

## Shared Patterns

### Behavior preservation during relocation (D-11)
**Source:** CONTEXT.md D-11 + CLAUDE.md "Agent Working Rules" (no workarounds).
**Apply to:** every file move in Wave 1.

Move components verbatim. Do NOT inline-edit `VoiceoverCompact` during the move — imports, hooks, IPC calls, tests follow the file. If adjustments are needed (path alias resolution, etc.), do them in a follow-up commit in the same wave.

### `sc-toolbar` right-side action cluster
**Source:** `routes/editor.tsx` L685-709, `routes/dashboard.tsx` L183-222, `features/post-production/editor-shell.tsx` L78-129.
**Apply to:** Editor's new Send-to-Post-Prod button + Post-Production landing's toolbar.

Pattern:
```jsx
<div className="sc-toolbar">
  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
    {/* title + breadcrumb + badges */}
  </div>
  <span className="sc-spacer" />
  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
    {/* actions: ScButton size="sm" | Link .sc-btn primary sm */}
  </div>
</div>
```

### TanStack Query wrapping IPC (docs/CONVENTIONS.md)
**Source:** `ipc/projects.ts` L10, L36-41.
**Apply to:** any new "recording exists" query surface if N+1 mitigation requires one.

```typescript
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

export function useXxx() {
  return useQuery({ queryKey: ["xxx"] as const, queryFn: () => invoke<T>("cmd_name") });
}
```

### Motion/react transitions (CLAUDE.md — no raw CSS transitions)
**Source:** `routes/editor.tsx` L16, L473-494 (`RailTabButton` with `layoutId` pill), L893-950 (cross-fade rail tabs), `features/editor/scene-list-panel.tsx` L9, L86-95 (`layoutId="scene-list-active-pill"`).
**Apply to:** any animated state transitions in the new Send-to-Post-Prod pulse or landing-route empty-state.

Use `motion/react` imports; respect `useReducedMotion()` for fallback timings.

### Error-state chip (Phase 14 sc-* treatment)
**Source:** `routes/editor.tsx` L674-682, L608-623.
**Apply to:** scene-list parse-error chip (D-08), landing-route error surfaces.

```jsx
{errorCount > 0 && <ScBadge tone="record">{errorCount} errors</ScBadge>}
{warningCount > 0 && <ScBadge tone="warn">{warningCount} warnings</ScBadge>}
```

### Kebab-case file names (docs/CONVENTIONS.md)
**Apply to:** all new files.
- `voiceover-compact/voiceover-compact.tsx` (not `VoiceoverCompact.tsx`). Note: existing `features/voiceover/*.tsx` uses PascalCase — that's legacy; new files under `features/post-production/` follow kebab-case per the 6-slice store convention already visible there (`preview-player.tsx`, `editor-shell.tsx`, `sound-drawer.tsx`, etc.).
- `preview-surface/preview-surface.tsx`.
- `post-production-landing.tsx`.

---

## No Analog Found

None. Every file in scope has a strong in-repo analog.

---

## Key Findings for Planner

1. **`SceneListPanel` already exists and is already wired.** D-08 is mostly "remove the `sceneCount > 0` gate + add a parse-error fallback branch." Not a new component.
2. **`ProjectFolderInfo.session_count` is the "recording exists" signal.** No new IPC needed for D-07's disabled-state check. Editor already fetches `ProjectFolderInfo` on mount.
3. **Sidebar link already points to `/post-production` (not `/:storyId`) and its `matchPattern` already covers both routes.** No sidebar change needed beyond verifying the new landing route renders.
4. **`VoiceoverCompact` lives inline in `routes/editor.tsx` L132-455.** The relocation target `features/post-production/voiceover-compact/` does not yet exist. Helper functions at L46-126 + `RailTabButton` at L457-495 move with it (or the latter gets deleted if the post-prod consumer doesn't tab between views).
5. **`VoiceCatalogDialog` at `routes/editor.tsx` L967** is still mounted at the route root — must move to Post-Production route when `VoiceoverCompact` moves, since it's `VoiceoverCompact`'s catalog modal.
6. **`PreviewSurface` composited mode is a pure wrapper** around the existing `PreviewPlayer`. The Editor-facing `recording` mode is the real new code — wrap `features/editor/preview-panel.tsx`'s viewport-switcher over the latest recording file (resolve via `exports_dir` + listing or a new lightweight helper).

---

## Metadata

**Analog search scope:**
- `apps/desktop/src/routes/`
- `apps/desktop/src/features/editor/`
- `apps/desktop/src/features/post-production/`
- `apps/desktop/src/features/voiceover/`
- `apps/desktop/src/features/dashboard/`
- `apps/desktop/src/features/recorder/`
- `apps/desktop/src/components/` (sidebar, command-palette)
- `apps/desktop/src/ipc/`

**Files read:** 11 source files + 3 context files
**Pattern extraction date:** 2026-04-21
