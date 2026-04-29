# Phase 22 — Cinematic Editing UI

**Status:** PROPOSED
**Date drafted:** 2026-04-28
**Depends on:** Phase 19-01 (typed Clip union)
**Blocker level:** 🟡 UX gap — without this, post-prod is "video pass-through + cursor" only

## Why this exists

After Phase 19-03, the timeline auto-populates `video` + `cursor`. But the editor exposes NO way for users to add zoom keyframes, text annotations, custom backgrounds, or scene transitions. Effects crate ships all 4 capabilities, computeGraph emits them correctly when present in store — the gap is purely UI.

Without this phase, the editor's value over a plain MP4 export is limited to "play back recording + cursor overlay (after Phase 20)". The cinematic story is hollow.

## Goal

User can manually add zoom keyframes, text annotations, customize the background, and pick scene transitions. Each addition flows into computeGraph → rendered output.

## Acceptance criteria

1. **AC1** — User selects a ZoomClip on timeline → inspector shows form with `target` picker (cursor/element/region), `scale` slider (1.0-3.0), `center` (x, y vec2), `preset` dropdown (DYNAMIC/CALM/SUBTLE). Edits dispatch `set-effect-param` undo actions.
2. **AC2** — Toolbar has "+ Zoom" button. Click creates a ZoomClip at the playhead with default values. Selectable + editable.
3. **AC3** — Toolbar has "+ Text" button. Creates AnnotationClip with default text ("Title"), pos (0.5, 0.9), size 24pt. Inspector form for text + position + size + color.
4. **AC4** — Sidebar / inspector tab has Background panel: gradient picker (2-stop), solid color picker, transparent toggle. Writes to `_undoExtras.background` and dispatches `change-background` undo action.
5. **AC5** — Between video clips on timeline, user can click a "+" affordance to insert a transition. Picker offers fade / dissolve / wipe-left / wipe-right / circle. Stored as TransitionClip variant or as transition metadata on adjacent video clips.
6. **AC6** — Each addition round-trips through computeGraph and shows in graph_json. Export with these effects produces a visibly different output than baseline.
7. **AC7** — Undo/redo (Cmd+Z) round-trips every addition.
8. **AC8** — `pnpm typecheck` + post-prod vitest suite green. New tests for each form.

## Plan breakdown — 4 plans

These are **largely independent** and can parallelize. Sequence matters only when integrating with shared inspector layout.

### Plan 22-01 — Zoom keyframe inspector + toolbar action

**Files:**
- EDIT `apps/desktop/src/features/post-production/inspector/effect-params.tsx` — when selected clip is `ZoomClip`, render a typed sub-form (target picker, scale slider, center vec2 inputs, preset dropdown). Re-use existing `set-effect-param` action with typed dot-paths (e.g. `tracks.zoom[<idx>].scale`).
- EDIT `apps/desktop/src/features/post-production/editor-shell.tsx` — add "+ Zoom" toolbar button. Calls `addZoomClip` (Phase 19-01 setter) with playhead-derived `startMs` + 1s default duration + `scale: 1.5` + `center: {x:0.5, y:0.5}` + `preset: "DYNAMIC"` + `target: { kind: "cursor" }`.
- TESTS: update `inspector/__tests__/effect-params.test.tsx` (new) to cover all 4 form fields dispatching the right action shape. Toolbar button click → addZoomClip side effect.

**Estimate:** 2-3h.

### Plan 22-02 — Annotation text inspector + toolbar action

**Files:**
- EDIT `inspector/effect-params.tsx` — when selected clip is `AnnotationClip`, render typed sub-form: text input (multiline), pos vec2, sizePt slider (12-72), color picker (`<input type="color">`).
- EDIT `editor-shell.tsx` — add "+ Text" toolbar button. Calls `addAnnotationClip` with default text, pos, size.
- TESTS: form dispatches set-effect-param. Toolbar adds clip.

**Risk:** Annotation track dragging UX needs to match other tracks. Existing `ClipAffordance` from Phase 18 should work since AnnotationClip is already typed.

**Estimate:** 2-3h.

### Plan 22-03 — Background panel

**Files:**
- NEW `apps/desktop/src/features/post-production/inspector/background-panel.tsx` — own component. Gradient (2-stop) editor: 2 color pickers + angle slider. Solid: 1 color picker. Transparent: toggle. Outputs `BackgroundKind` payload matching effects crate's `Background` AST node.
- EDIT `inspector/inspector.tsx` (or wherever the inspector tabs live — check existing structure) — add "Background" tab next to existing tabs.
- EDIT `state/store.ts` — surface `background` from `_undoExtras` as a typed reader (currently it's an opaque bag).
- EDIT `state/compute-graph.ts` — emit a `background` VideoNode when `_undoExtras.background.kind !== "transparent"`. Insert in canonical order (after Source, before ZoomPan).
- TESTS: panel dispatches `change-background`. computeGraph emits Background node when set.

**Risk:** Background AST shape in Rust effects crate needs verification before TS emit. Check `crates/effects/src/ast/video.rs` for BackgroundNode variants.

**Estimate:** 2.5-3h.

### Plan 22-04 — Transition picker between video clips

**Files:**
- EDIT `apps/desktop/src/features/post-production/timeline/timeline.tsx` (or `track.tsx`) — render "+" affordance between adjacent VideoClips on the video track. Click opens picker popover (fade / dissolve / wipe-left / wipe-right / circle).
- DECIDE: where to store transition? Options:
  - **A**: New `TransitionClip` variant in Clip union (Phase 19-01 didn't include this).
  - **B**: Field on adjacent VideoClip: `outgoingTransition?: { kind, durationMs }`.
  - **C**: Separate `transitions: Transition[]` slice in store, not on a track.
- Recommend **A** (TransitionClip variant) — consistent with existing variants, computeGraph can emit per-clip. Requires extending Phase 19-01 schema.
- EDIT `state/timeline-slice.ts` — add `TransitionClip` variant (between which two clip ids, kind, durationMs). Add `addTransitionClip` setter. Update `Clip` union (note: not on a 5-track grid — transitions are between video clips. Maybe a 6th implicit "track" or special-case).
- EDIT `state/compute-graph.ts` — emit `Transition` VideoNode for each TransitionClip.
- TESTS: picker dispatches add. Graph contains Transition node.

**Risk:** Phase 19-01's discriminated union assumed 5 fixed tracks. TransitionClip doesn't fit that grid. Either extend the union with a non-track-bound variant, or store on VideoClip as proposed Option B. Reconsider in early planning.

**Estimate:** 3-4h (highest of the 4 plans).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Background AST shape on Rust side differs from assumption | Medium | rework | Audit `crates/effects/src/ast/` first, write stub TS types before implementation |
| TransitionClip schema extension breaks Phase 19-01 invariants | Medium | regress | Plan 22-04 may pivot to Option B (field on VideoClip) if (A) is too invasive |
| Inspector layout becomes cluttered with 4 typed forms | High | UX | Use tabbed inspector pattern (existing Presets/Effects/Sound tabs); add Zoom/Annotation/Background tabs |
| Color picker UX on Tauri (native vs HTML input) | Low | minor visual | Use `<input type="color">`; revisit if operators complain |

## Sequencing

22-01, 22-02, 22-03, 22-04 are largely independent. Execute in any order or in parallel waves. Recommended order:
1. **Wave 1**: 22-01 + 22-02 in parallel (similar inspector patterns, low overlap).
2. **Wave 2**: 22-03 (background panel — touches inspector tabs).
3. **Wave 3**: 22-04 (transitions — schema extension; do after others stabilize).

## Out of scope

- Smart presets ("Cinematic Pack", "YouTube Pack"). Future phase if demand.
- Batch effect application (apply same zoom config to all clips).
- Real-time preview of zoom/annotation while editing — current preview engine renders frames; live effect preview is a Phase 23+ concern.
- Animated text (slide-in, fade-out beyond hardcoded `anim_in: "fade"`).
- Custom font upload — bundled fonts only.

## Estimated total

- 22-01: 2-3h
- 22-02: 2-3h
- 22-03: 2.5-3h
- 22-04: 3-4h
- **Total: 9.5-13h** (parallelize 1+2 → save ~2h wall time)
