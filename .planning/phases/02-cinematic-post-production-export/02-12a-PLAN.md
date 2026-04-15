---
phase: 02-cinematic-post-production-export
plan: 12a
type: execute
wave: 4
depends_on: ["02-04", "02-10", "02-11"]
autonomous: true
files_modified:
  - apps/desktop/src/features/post-production/state/store.ts
  - apps/desktop/src/features/post-production/state/timeline-slice.ts
  - apps/desktop/src/features/post-production/state/panels-slice.ts
  - apps/desktop/src/features/post-production/state/selection-slice.ts
  - apps/desktop/src/features/post-production/state/export-slice.ts
  - apps/desktop/src/features/post-production/state/queue-slice.ts
  - apps/desktop/src/features/post-production/state/undo-bridge.ts
  - apps/desktop/src/ipc/export.ts
  - apps/desktop/src/ipc/render.ts
  - apps/desktop/src/ipc/presets.ts
  - apps/desktop/src/ipc/timeline.ts
  - apps/desktop/src/ipc/sound-library.ts
  - apps/desktop/src-tauri/src/commands/preset.rs
  - apps/desktop/src-tauri/src/commands/timeline.rs
  - apps/desktop/src-tauri/src/commands/sound_library.rs
  - apps/desktop/src-tauri/src/commands/mod.rs
  - apps/desktop/package.json
  - apps/desktop/src/features/post-production/__tests__/store.test.ts
requirements:
  - UI-05
tags: [ui, post-production-state, zustand, ipc, tauri-commands, preset, timeline, sound-library, wcag]

must_haves:
  truths:
    - "Zustand store slices exist (D-32): timeline (tracks, playheadMs, snapEnabled, durationMs), panels (pane sizes persisted via zustand/middleware persist), selection (selectedClipId, selectedPresetId, selectedTab), export (modal state, form), queue (active jobs + progress map)"
    - "5 fixed timeline tracks declared in shape: `tracks: { video: Clip[]; cursor: Clip[]; zoom: Clip[]; sound: Clip[]; annotations: Clip[] }` (D-12) — user cannot add/remove tracks"
    - "Magnetic snap ON by default (D-13) in timeline slice; Alt-held flag disables; snap targets computed from playhead + scene boundaries + neighbor clip edges; SNAP_THRESHOLD_PX = 10"
    - "TanStack Query keys declared for: render_list_active, preset list, sound library list (D-32)"
    - "IPC wrappers typed against Plan 10/11 Tauri commands: renderEnqueue, renderCancel, renderListActive, streamRenderProgress (Channel<RenderProgress>), exportRun, exportGetPresets, exportValidateConfig"
    - "New Tauri commands registered and compile: preset_list / preset_import / preset_export / timeline_load / timeline_save / sound_library_list — each wraps Plan 03 repo functions with CommandError mapping"
    - "Undo bridge (placeholder hook for Plan 13): `undo-bridge.ts` exposes `dispatchUndoable(action)` that P13 will wire into the history buffer; P12a ships the interface with a no-op implementation so P12b UI code can call it without circular dependency"
    - "Vitest store tests cover: setPlayhead, moveClip snap within 10 px threshold, Alt-held disables snap, toggleSnap flips flag, addSoundClip targets Sound track only"
    - "tsc --noEmit passes for all new state + IPC + command surfaces"
  artifacts:
    - path: "apps/desktop/src/features/post-production/state/store.ts"
      provides: "Zustand store composing 5 slices + undo bridge"
    - path: "apps/desktop/src/features/post-production/state/timeline-slice.ts"
      provides: "5-track + snap + playhead state and actions"
    - path: "apps/desktop/src/features/post-production/state/panels-slice.ts"
      provides: "Pane sizes + drawer/modal flags persisted to localStorage"
    - path: "apps/desktop/src/features/post-production/state/selection-slice.ts"
      provides: "selectedClipId / selectedPresetId / selectedTab"
    - path: "apps/desktop/src/features/post-production/state/export-slice.ts"
      provides: "Export modal state (formats, resolution, fps, quality, outFolder)"
    - path: "apps/desktop/src/features/post-production/state/queue-slice.ts"
      provides: "Active jobs + progress map"
    - path: "apps/desktop/src/features/post-production/state/undo-bridge.ts"
      provides: "dispatchUndoable stub (P13 wires real history)"
    - path: "apps/desktop/src/ipc/export.ts"
      provides: "Typed wrappers for export_run / export_get_presets / export_validate_config"
    - path: "apps/desktop/src/ipc/render.ts"
      provides: "Typed wrappers for render_enqueue / render_cancel / render_list_active / stream_render_progress"
    - path: "apps/desktop/src-tauri/src/commands/preset.rs"
      provides: "Preset CRUD + import/export Tauri commands"
    - path: "apps/desktop/src-tauri/src/commands/timeline.rs"
      provides: "timeline_load / timeline_save"
    - path: "apps/desktop/src-tauri/src/commands/sound_library.rs"
      provides: "sound_library_list by category"
  key_links:
    - from: "apps/desktop/src/ipc/export.ts"
      to: "crates/encoder/src/export/orchestrator.rs (Plan 11)"
      via: "tauri invoke('export_run', request)"
      pattern: "exportRun"
    - from: "apps/desktop/src-tauri/src/commands/preset.rs"
      to: "crates/storage/src/repos/preset_repo.rs (Plan 03)"
      via: "preset_repo CRUD + import/export wrappers"
      pattern: "preset_repo"
---

<objective>
Deliver the Post-Production Editor's **state + IPC foundation** (Plan 12a of a 12a/12b split): Zustand store with 5 slices + undo bridge, typed IPC wrappers around Plan 10's render queue commands and Plan 11's export commands, and new Tauri commands for preset / timeline / sound_library backed by Plan 03 repos. No React UI components in this plan — those ship in Plan 12b.

Purpose: Splitting state/IPC from UI components allows 12a to be fully autonomous (no human-verify needed) and lets 12b's UI work depend on compiled, tested contracts. State management is fully specified in D-32/D-33; layout + components ship in 12b (D-12/D-13/D-14).

Output: ~18 files: 7 state slices/bridge + 5 IPC wrappers + 4 Tauri commands + package.json deps + store Vitest tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/02-cinematic-post-production-export/02-CONTEXT.md
@.planning/phases/02-cinematic-post-production-export/02-RESEARCH.md
@.planning/phases/02-cinematic-post-production-export/02-04-PLAN.md
@.planning/phases/02-cinematic-post-production-export/02-10-PLAN.md
@.planning/phases/02-cinematic-post-production-export/02-11-PLAN.md
@.planning/phases/01-foundation-dsl-automation-capture-encode/01-09-PLAN.md

<interfaces>
From Plan 04: `PreviewEngine`, `PreviewRenderPlan`, `withVideoFrame`.
From Plan 10 Tauri commands: `render_enqueue`, `render_cancel`, `render_list_active`, `stream_render_progress`.
From Plan 11 Tauri commands: `export_run`, `export_get_presets`, `export_validate_config`.

This plan ALSO introduces these Tauri commands (wrapping Plan 03's repos):
```rust
#[tauri::command] pub async fn preset_list(scope: Scope, state: State<'_, AppState>) -> Result<Vec<EffectPreset>, CommandError>;
#[tauri::command] pub async fn preset_import(path: PathBuf, scope: Scope, state: State<'_, AppState>) -> Result<Uuid, CommandError>;
#[tauri::command] pub async fn preset_export(id: Uuid, out: PathBuf, state: State<'_, AppState>) -> Result<(), CommandError>;
#[tauri::command] pub async fn timeline_load(story_id: Uuid, state: State<'_, AppState>) -> Result<Option<TimelineState>, CommandError>;
#[tauri::command] pub async fn timeline_save(story_id: Uuid, layout_json: String, state: State<'_, AppState>) -> Result<(), CommandError>;
#[tauri::command] pub async fn sound_library_list(category: SoundCategory, state: State<'_, AppState>) -> Result<Vec<SoundLibraryEntry>, CommandError>;
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Zustand store + Tauri commands for preset/timeline/sound library + IPC wrappers</name>
  <read_first>
    - Phase 1 apps/desktop/src/state/ (existing Zustand patterns)
    - Phase 1 apps/desktop/src-tauri/src/commands/ (command registration pattern)
    - crates/storage/src/repos/ (Plan 03 repo functions)
  </read_first>
  <files>
    apps/desktop/src/features/post-production/state/store.ts
    apps/desktop/src/features/post-production/state/timeline-slice.ts
    apps/desktop/src/features/post-production/state/panels-slice.ts
    apps/desktop/src/features/post-production/state/selection-slice.ts
    apps/desktop/src/ipc/export.ts
    apps/desktop/src/ipc/render.ts
    apps/desktop/src/ipc/presets.ts
    apps/desktop/src/ipc/timeline.ts
    apps/desktop/src/ipc/sound-library.ts
    apps/desktop/src-tauri/src/commands/preset.rs
    apps/desktop/src-tauri/src/commands/timeline.rs
    apps/desktop/src-tauri/src/commands/sound_library.rs
    apps/desktop/src-tauri/src/commands/mod.rs
    apps/desktop/src/features/post-production/__tests__/store.test.ts
  </files>
  <action>
    **Zustand store (D-32):**
    ```typescript
    // apps/desktop/src/features/post-production/state/store.ts
    import { create } from 'zustand';
    import { createTimelineSlice, TimelineSlice } from './timeline-slice';
    import { createPanelsSlice, PanelsSlice } from './panels-slice';
    import { createSelectionSlice, SelectionSlice } from './selection-slice';
    export type EditorStore = TimelineSlice & PanelsSlice & SelectionSlice;
    export const useEditorStore = create<EditorStore>()((...a) => ({
      ...createTimelineSlice(...a),
      ...createPanelsSlice(...a),
      ...createSelectionSlice(...a),
    }));
    ```

    **Timeline slice** covers: `tracks: { video: Clip[]; cursor: Clip[]; zoom: Clip[]; sound: Clip[]; annotations: Clip[] }`, `playheadMs: number`, `snapEnabled: boolean`, `durationMs: number`, actions `setPlayhead`, `moveClip(trackId, clipId, newStartMs)`, `trimClip`, `deleteClip`, `addSoundClip`, `toggleSnap`.

    **Panels slice** covers: `timelineHeightPct: 30`, `previewWidthPct: 60`, `inspectorWidthPct: 25`, `soundDrawerOpen: false`, `exportModalOpen: false`, setters. Persist to localStorage via `persist` middleware (zustand/middleware).

    **Selection slice** covers: `selectedClipId: string | null`, `selectedPresetId: string | null`, `selectedTab: 'presets' | 'effects' | 'sound'`.

    **Tauri commands:**
    - `apps/desktop/src-tauri/src/commands/preset.rs` wraps Plan 03 `preset_repo` CRUD + `import_preset` + `export_preset`.
    - `apps/desktop/src-tauri/src/commands/timeline.rs` wraps `timeline_repo::load/save`.
    - `apps/desktop/src-tauri/src/commands/sound_library.rs` wraps `sound_library_repo::list_by_category`.
    - Register all in `commands/mod.rs` and `src-tauri/src/main.rs` invoke_handler list.

    **IPC wrappers:** `apps/desktop/src/ipc/export.ts`, `render.ts`, `presets.ts`, `timeline.ts`, `sound-library.ts` — thin typed wrappers around `invoke`/`listen`/`Channel` generated by `tauri-specta` (Phase 1 D-05 pattern).

    Add `zustand@5`, `@tanstack/react-query@5`, `@tanstack/react-virtual@3`, `wavesurfer.js@7`, `react-hotkeys-hook@4`, `@dnd-kit/core@6` to `apps/desktop/package.json` if not already present.

    Write Vitest tests in `store.test.ts` covering: `setPlayhead`, `moveClip` with snap enabled snaps to nearest neighbour edge within 10 px threshold, `moveClip` with Alt-held (snap disabled) does NOT snap, `toggleSnap` toggles, `addSoundClip` adds to Sound track only.
  </action>
  <verify>
    <automated>pnpm --filter desktop exec vitest run src/features/post-production/__tests__/store.test.ts && pnpm --filter desktop exec tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q "export const useEditorStore" apps/desktop/src/features/post-production/state/store.ts` succeeds.
    - `grep -q "snapEnabled: boolean" apps/desktop/src/features/post-production/state/timeline-slice.ts` succeeds.
    - `grep -q "tracks: { video: Clip\\[\\]; cursor: Clip\\[\\]; zoom: Clip\\[\\]; sound: Clip\\[\\]; annotations: Clip\\[\\]" apps/desktop/src/features/post-production/state/timeline-slice.ts` succeeds (exact 5-track names).
    - `grep -q "#\\[tauri::command\\]" apps/desktop/src-tauri/src/commands/preset.rs` succeeds.
    - `grep -q "sound_library_list" apps/desktop/src-tauri/src/commands/sound_library.rs` succeeds.
    - `grep -q "exportRun" apps/desktop/src/ipc/export.ts` succeeds.
    - `pnpm --filter desktop exec vitest run src/features/post-production/__tests__/store.test.ts` passes.
    - `pnpm --filter desktop exec tsc --noEmit` exits 0.
  </acceptance_criteria>
  <done>Store + Tauri command surfaces + IPC wrappers compile and pass store tests.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Tauri command args (preset id / story id / category enum) -> Plan 03 repos | Uuid + enum args validated at command entry; repo returns typed errors |
| IPC Channel<RenderProgress> payload -> Zustand queue slice | Deserialised via tauri-specta generated types; bounded shape |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-36 | Tampering | preset_import path arg escapes project folder | mitigate | preset.rs command validates path is inside user-home or project-import folder; rejects `..`-escaped paths |
| T-02-37 | Information disclosure | Render queue shows other stories' jobs | accept | render_list_active filters by story_id; desktop is single-user |
| T-02-38 | Denial of service | timeline_save called with huge layout JSON | mitigate | timeline.rs command rejects payloads > 1 MiB |
</threat_model>

<verification>
1. `pnpm --filter desktop exec vitest run src/features/post-production/__tests__/store.test.ts` passes.
2. `pnpm --filter desktop exec tsc --noEmit` exits 0.
3. `cargo check -p desktop-app` (Tauri app) compiles — new commands registered.
</verification>

<success_criteria>
- Store slices + IPC wrappers + new Tauri commands compile and pass store tests (UI-05 foundation; UI-05 fully satisfied in Plan 12b).
- D-32 state management contract implemented.
- Undo bridge stub in place for Plan 13 to wire against.
</success_criteria>

<output>
After completion, create `.planning/phases/02-cinematic-post-production-export/02-12a-SUMMARY.md`.
</output>
