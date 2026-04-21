# Phase 15: Editor/Post-Production feature boundary cleanup — Context

**Gathered:** 2026-04-21
**Status:** Ready for planning
**Source:** /gsd-discuss-phase 15 (plus PRE-ANSWERS.md from /gsd-add-phase)

<domain>
## Phase Boundary

Realign the Editor and Post-Production routes with their mental-model roles:
- **Editor** = "does the video *work*?" — DSL authoring, selector validation, dry-runs, recording fitness. Authoring tools + a visual preview.
- **Post-Production** = "does the video *feel right*?" — shot list, timeline, voice/TTS, FX, inspector, export.

Relocate misplaced feature components (VoiceoverCompact), consolidate the preview surface, and add explicit handoff UX between the two routes. Inherit the Phase 14 sc-* visual language unchanged.

Out of scope: new IPC commands, new Rust crates, new DSL verbs, new capabilities, visual re-skin (Phase 14 owns that), rebuilding the 6-slice post-production Zustand store (keep as-is; just stop consuming it from Editor).

</domain>

<decisions>
## Implementation Decisions

### Workflow + reachability (PRE-ANSWERS Q1–Q3)
- **D-01 (Q1):** Editor authoring-time validation uses **BOTH** typed feedback (LSP + DryRun + SelectorValidator) **AND** a visual preview. Neither replaces the other.
- **D-02 (Q2):** Editor exposes an **explicit "Send to Post-Production"** affordance. Not implicit / auto-navigation after recording.
- **D-03 (Q3):** Post-Production is reachable at any time with an **empty-state** when no recordings exist. Workflow is **freeform** — no strict linear gating.

### Preview consolidation
- **D-04:** One shared `PreviewSurface` component with a `mode` prop (`"recording" | "composited"`). Both routes consume it:
  - Editor uses `mode="recording"` — shows the most recent recording for the current project, scrubbable.
  - Post-Production uses `mode="composited"` — full WebGPU-composited timeline preview (existing behavior).
  - Mode-specific logic lives inside the component; consumers just pick a mode.
  - Location: `apps/desktop/src/components/preview-surface/preview-surface.tsx` (or the closest sensible feature folder — planner picks, but the component is shared across features so `components/` is fine).

### Recorder route
- **D-05:** Keep `/recorder/:projectId` as a **standalone full-screen route**. Editor's Record button navigates there. After recording completes, Recorder route returns to Editor (existing navigation behavior preserved).

### Empty-state routing for Post-Production
- **D-06:** Add a new **landing route** `/post-production` (no param). Renders when the user hits the route without a projectId — shows a project picker + a "No recordings yet — record a story to start post-production" CTA.
- Existing `/post-production/:storyId` keeps current behavior (opens that story's post-prod workspace).
- Sidebar "Post-Production" entry links to `/post-production` (landing); in-route navigation from a project card links to `/post-production/:storyId`.

### Send-to-Post-Production UX
- **D-07:** **Toolbar button in the Editor top bar**, always visible, **disabled** until a recording exists for the current project. Click navigates to `/post-production/:projectId`.
- Placement: Editor's existing `sc-toolbar` right-side action cluster (near the current Dry run + Record buttons).
- Enabled-state indicator: subtle accent pulse or simple color shift when first-time enabled after a successful recording (planner picks; not a decoration-heavy animation).
- NO toast on recording completion; the toolbar button is the single surface. Keep UI quiet.

### Scene list in Editor
- **D-08:** Editor's **left rail gains a read-only derived scene list** parsed from the current DSL. Click jumps the CodeMirror cursor to that scene's line. Reorder / rename / add / delete are **not** here — those live in Post-Prod's existing scene list.
- Derivation source: existing story-parser AST via the existing LSP bridge (no new IPC).
- If DSL fails to parse, rail shows the last-valid scene set with a muted "parse error — showing last known" note.

### Toolbar
- **D-09:** **Keep bespoke toolbars per route.** No shared `ProjectToolbar` abstraction this phase. Each route's `sc-toolbar` stays its own JSX. Reason: the two toolbars' needs diverge enough (Editor = fitness + send, Post-Prod = transport + export) that a shared component adds more indirection than reuse.

### VoiceoverCompact relocation
- **D-10:** **Remove `VoiceoverCompact` from the Editor route entirely.** Voice UX lives only in Post-Production (which already has the full TTS editor, voice catalog, inspector).
- Editor's right rail freed up for authoring tools (first candidates: DSL quickstart / lint summary / target-reference sidebar — planner picks which to surface, or leaves rail empty as a TBD slot).

### Behavior preservation (D-09 echo from Phase 14)
- **D-11:** Every Zustand selector, IPC call, hotkey, CodeMirror extension, LSP bridge, WebGPU lifecycle, motion transition, Tauri channel must be preserved across relocations. Moving `VoiceoverCompact` means its imports, hooks, and tests follow it into `features/post-production/`. No inline behavior edits during the move.

### Phase 14 preservation
- **D-12:** The Phase 14 re-skin stays intact: sc-* tokens, Sc* primitives, existing legacy AppLayout / title-bar / sidebar chrome, CommandPalette store wiring, Phase 13 export wiring. Phase 15 only moves boundary-bearing components; it does not re-style.

### Rollout strategy
- **D-13:** **Sequential waves, atomic commits per move.** No feature flag. Each wave leaves the app green (typecheck + build + existing tests pass).
- Wave 1 — Component moves: relocate `VoiceoverCompact` into `features/post-production/`; update imports, tests, prop types.
- Wave 2 — Shared preview: create `PreviewSurface` with mode prop; migrate Post-Production's existing preview to use it; introduce Editor's recording-preview consumer.
- Wave 3 — Post-Production landing: new `/post-production` route + empty-state page + router wiring + sidebar link update.
- Wave 4 — Editor additions: "Send to Post-Production" toolbar button (with disabled/enabled state bound to recording presence) + read-only scene-list rail.
- Wave 5 — Polish + tests: regression pass, accessibility spot-check, SUMMARY.

### Claude's Discretion
- Exact slot where the new left-rail scene list renders in Editor (there's existing JSX; planner picks minimal intrusion path).
- Visual treatment of the enabled `Send to Post-Production` button — subtle accent vs a proper call-to-action weight.
- Whether `/post-production` landing reuses the dashboard's project grid component or introduces its own narrower list.
- Implementation of "recording exists" check for the Send-to-Post-Prod button (probably via existing recording-query hook; planner audits).
- What replaces `VoiceoverCompact`'s footprint in Editor's right rail (may be empty for now, or a simple lint summary — planner picks).

</decisions>

<canonical_refs>
## Canonical References

Downstream agents MUST read these before planning or implementing.

### Current routes + features (subjects of this phase)
- `apps/desktop/src/routes/editor.tsx` (860+ lines; contains the DSL editor + panels; subject of relocation)
- `apps/desktop/src/routes/post-production.tsx` (thin URL-param wrapper → EditorShell)
- `apps/desktop/src/features/post-production/editor-shell.tsx` (main post-prod shell; hosts 6-slice Zustand)
- `apps/desktop/src/features/post-production/state/` (6-slice Zustand store — preserve verbatim)
- `apps/desktop/src/routes/recorder.tsx` (standalone recorder, stays)

### Components being moved or created
- `apps/desktop/src/features/post-production/voiceover-compact/` (current `VoiceoverCompact` — relocation target from editor)
  - Locate via `grep -r "VoiceoverCompact" apps/desktop/src`
- New: `apps/desktop/src/components/preview-surface/preview-surface.tsx` (shared preview component — D-04)
- New: `apps/desktop/src/routes/post-production-landing.tsx` (or equivalent — D-06)

### Data sources for Editor's derived scene list (D-08)
- `apps/desktop/src/ipc/lsp-bridge.ts` or equivalent — current LSP plumbing for parsed AST
- `crates/story-parser/` (Rust) — AST shape reference (no changes)

### Phase 14 context that stays intact
- `.planning/phases/14-port-claude-design-into-apps-desktop/14-CONTEXT.md` (D-03/D-06a dropped; legacy chrome preserved; sc-* canonical)
- `.planning/phases/14-port-claude-design-into-apps-desktop/14-03a..d-SUMMARY.md` (route restyle final shape)
- `packages/ui/src/claude-design/` (primitives + tokens; unchanged here)

### Project standards
- `CLAUDE.md` — no workarounds, no Co-Authored-By, concise comments, Base UI not Radix, kebab-case, motion/react
- `docs/CONVENTIONS.md` — feature-folder layout, Zustand patterns, testing
- `docs/ARCHITECTURE.md` — trait boundaries (unchanged this phase)
- `.planning/PROJECT.md` + `.planning/REQUIREMENTS.md`
- `.planning/STATE.md`

### Router + routing
- `apps/desktop/src/routes/index.tsx` — router definition; new landing route lands here
- `apps/desktop/src/components/sidebar.tsx` — nav link updates for the new landing route
- `apps/desktop/src/components/command-palette/command-palette.tsx` — palette items may gain a "Go to Post-Production (empty state)" or just repoint

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable assets
- Existing Post-Production preview (WebGPU compositor) is the basis for the composited mode of `PreviewSurface` — extract, don't rebuild.
- Existing `features/recorder/` captures the "recording" data source; Editor's preview consumer reads from the same store / IPC.
- Existing LSP bridge parses the DSL on every keystroke — tap its AST for the Editor scene list, no new parsing.
- `useDashboardStore` is already wired for palette open + new-project-request flags — if a small UI-state flag is needed for "just recorded" → handoff pulse, reuse this store.

### Patterns
- Feature folders under `features/<name>/`. `VoiceoverCompact` moves from `features/editor/...` (current) to `features/post-production/voiceover-compact/`.
- Route-per-file under `routes/`. The new `post-production` landing is a new file, likely `routes/post-production.tsx` becoming the landing and `routes/post-production-story.tsx` becoming the story-specific view — OR landing lives in `features/post-production/landing/`. Planner decides.

### Integration points
- `routes/index.tsx` — add the landing route; existing `/post-production/:storyId` stays.
- `sidebar.tsx` — "Post-Production" link points to `/post-production` (landing). Active-state `matchPattern` updates to cover both landing + story routes.
- `editor.tsx` toolbar — add `Send to Post-Production` button in the existing action cluster.
- Command palette — palette items for "Go to Post-Production" navigate to `/post-production` (landing) now; keep the shortcut label.

### Risks
- `VoiceoverCompact` likely has deep imports from Editor-side helpers. Audit during Wave 1.
- WebGPU lifecycle (context create/teardown) must not break during preview consolidation — the shared `PreviewSurface` must manage the single WebGPU context cleanly across route changes. Worth a focused test pass in Wave 2.
- Editor's left rail is already populated; adding a scene list means finding the minimal intrusion point (D-08 Claude's Discretion).

</code_context>

<specifics>
## Specific Ideas

- The "recording exists" check for `Send to Post-Production` button probably maps to a TanStack Query hook already in use by the recorder feature. Reuse; do not add a new IPC.
- If the Editor scene list shows a parse error, render the last-valid list muted + a small "parse error" chip at the top — match Phase 14 sc-* error treatment (muted record-accent).
- `/post-production` landing should use the sc-* token + Sc* primitives + existing ScCard grid — keep stylistic consistency with the Phase 14 dashboard.
- Deferred `VoiceoverCompact` surfaces (any Editor-specific features that existed in the inline version) — enumerate during Wave 1 and decide per-feature: merge into Post-Prod's existing TTS editor, or defer to a future enhancement.

</specifics>

<deferred>
## Deferred Ideas

- **Shared `ProjectToolbar` component** (D-09 rejected this phase). Revisit if a third route grows a similar toolbar.
- **Drag-reorder / multi-select in Editor's scene list** (D-08 says read-only only).
- **Automatic handoff from recording-complete → Post-Production** (D-02 rules this out in favor of an explicit button).
- **Strict workflow gating** (D-03 rules this out — empty-state access is always allowed).
- **Right-rail content for Editor after removing VoiceoverCompact** — may start empty; lint / target-reference / quickstart are candidate fillers, picked by planner or deferred.
- **Scrubbable playback of the latest recording in `PreviewSurface` mode="recording"** — deferred because no latest-recording signal exists in IPC this phase (`ProjectFolderInfo` has only `session_count`, no recordings path) and CONTEXT.md "Out of scope" forbids new IPC. Phase 15 ships the empty-state only; a future phase adds an IPC like `list_project_recordings` and wires real playback.

</deferred>

---

## Amendment log

- **2026-04-21** — Promoted **docs/ARCHITECTURE.md cross-phase sync** out of Deferred Ideas into Plan 05 (Wave 5) scope. Rationale: CLAUDE.md "MANDATORY — Keep Agent Docs In Sync After Impactful Changes" makes Editor/Post-Production boundary realignment non-deferrable — the boundary description in `docs/ARCHITECTURE.md` must land in the same phase that changes the boundary. Plan 05 Task 3 owns this sync.

---

*Phase: 15-editor-post-production-feature-boundary-cleanup*
*Context gathered: 2026-04-21*
