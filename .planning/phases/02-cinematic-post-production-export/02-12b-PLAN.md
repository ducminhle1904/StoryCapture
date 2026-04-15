---
phase: 02-cinematic-post-production-export
plan: 12b
type: execute
wave: 5
depends_on: ["02-04", "02-10", "02-11", "02-12a"]
autonomous: false
files_modified:
  - apps/desktop/src/routes/post-production.tsx
  - apps/desktop/src/features/post-production/editor-shell.tsx
  - apps/desktop/src/features/post-production/timeline/timeline.tsx
  - apps/desktop/src/features/post-production/timeline/track.tsx
  - apps/desktop/src/features/post-production/timeline/clip.tsx
  - apps/desktop/src/features/post-production/timeline/playhead.tsx
  - apps/desktop/src/features/post-production/timeline/time-ruler.tsx
  - apps/desktop/src/features/post-production/timeline/snapping.ts
  - apps/desktop/src/features/post-production/preview/preview-player.tsx
  - apps/desktop/src/features/post-production/preview/transport-controls.tsx
  - apps/desktop/src/features/post-production/inspector/inspector-panel.tsx
  - apps/desktop/src/features/post-production/inspector/preset-picker.tsx
  - apps/desktop/src/features/post-production/inspector/effect-params.tsx
  - apps/desktop/src/features/post-production/sound-browser/sound-drawer.tsx
  - apps/desktop/src/features/post-production/sound-browser/sound-row.tsx
  - apps/desktop/src/features/post-production/export-modal/export-modal.tsx
  - apps/desktop/src/features/post-production/export-modal/format-checkboxes.tsx
  - apps/desktop/src/features/post-production/export-modal/resolution-picker.tsx
  - apps/desktop/src/features/post-production/render-queue/queue-widget.tsx
  - apps/desktop/src/features/post-production/render-queue/job-row.tsx
  - apps/desktop/src/features/post-production/render-queue/progress-bar.tsx
  - apps/desktop/src/features/post-production/hooks/use-preview.ts
  - apps/desktop/src/features/post-production/hooks/use-render-progress.ts
  - apps/desktop/src/features/post-production/hooks/use-hotkeys.ts
  - apps/desktop/src/features/post-production/hooks/use-editor-store.ts
  - apps/desktop/src/features/post-production/layer-tracks/video-track.tsx
  - apps/desktop/src/features/post-production/layer-tracks/cursor-track.tsx
  - apps/desktop/src/features/post-production/layer-tracks/zoom-track.tsx
  - apps/desktop/src/features/post-production/layer-tracks/sound-track.tsx
  - apps/desktop/src/features/post-production/layer-tracks/annotations-track.tsx
  - apps/desktop/src/App.tsx
  - apps/desktop/src/features/post-production/__tests__/timeline.test.tsx
  - apps/desktop/src/features/post-production/__tests__/export-modal.test.tsx
  - apps/desktop/src/features/post-production/__tests__/preview-player.test.tsx
requirements:
  - UI-05
tags: [ui, post-production, react, timeline, 5-track, preview-player, inspector, sound-browser, export-modal, render-queue, wavesurfer, dnd-kit, shadcn, wcag]

must_haves:
  truths:
    - "Post-Production Editor route /post-production/<story_id> renders 4-pane layout (D-14): Timeline bottom ~30%, Preview top-left 60%, Inspector top-right 25%, Sound browser left drawer, Export right drawer/modal"
    - "5 fixed timeline tracks rendered (D-12): Video, Cursor, Zoom, Sound, Annotations — each with its own layer-track component reading from Plan 12a's timeline slice"
    - "Magnetic snap ON by default (D-13); Alt-hold disables via hotkey bound to timeline slice"
    - "Preview player wraps Plan 04 PreviewEngine; renderFrame driven by requestAnimationFrame + currentTime; scrub updates `<video>`.currentTime synchronously"
    - "Transport controls: play/pause (space), seek (arrow keys + 5s jump with shift), frame-step forward/back (period/comma)"
    - "Inspector panel tabs: Presets | Effects | Sound; preset grid from Plan 03 via `presetList`; effect-params form edits VideoNode attributes + emits AST patches via Plan 12a store actions + calls debounced IPC to persist"
    - "Sound library drawer (left slide-out) shows SFX + BGM categories with wavesurfer.js static waveform + duration; drag-to-timeline adds a clip to the Sound track"
    - "Export modal (right drawer): format checkboxes MP4/WebM/GIF + per-format resolution + FPS + quality + output folder picker (tauri-plugin-dialog) + Export button -> calls exportRun (Plan 11 via 12a IPC)"
    - "Render queue widget (top-bar dropdown): shows active jobs from renderListActive, live progress from stream_render_progress Channel<RenderProgress>, cancel button per job"
    - "Keyboard shortcuts via react-hotkeys-hook: space=play/pause, cmd/ctrl+z/shift+z (and cmd/ctrl+y on Windows)=undo/redo (wired to Plan 13 through undo-bridge from 12a), delete=remove selected clip, alt=disable snap (while held)"
    - "WCAG 2.1 AA: every interactive element keyboard-reachable, focus-ring visible on clips/tracks, ARIA labels on timeline clips ('Cursor clip at 12.5s, 3.2s duration'), screen-reader announcements for playhead position changes"
    - "Vitest + RTL tests for: timeline snap behaviour, export modal form validation, preview player lifecycle"
    - "Formal human-verify checkpoint covers scrub-at-60fps + preset application + MP4/WebM/GIF export + undo/redo journey (see Task 4)"
  artifacts:
    - path: "apps/desktop/src/routes/post-production.tsx"
      provides: "Route entry wiring EditorShell"
    - path: "apps/desktop/src/features/post-production/editor-shell.tsx"
      provides: "4-pane layout with resizable splitters + drawers"
    - path: "apps/desktop/src/features/post-production/timeline/timeline.tsx"
      provides: "5-track timeline with playhead, snapping, clip drag/trim"
    - path: "apps/desktop/src/features/post-production/preview/preview-player.tsx"
      provides: "Wraps PreviewEngine (Plan 04) + <video> element + transport controls"
    - path: "apps/desktop/src/features/post-production/inspector/inspector-panel.tsx"
      provides: "Tabbed inspector: Presets, Effects, Sound"
    - path: "apps/desktop/src/features/post-production/sound-browser/sound-drawer.tsx"
      provides: "Sound library drawer with wavesurfer.js previews"
    - path: "apps/desktop/src/features/post-production/export-modal/export-modal.tsx"
      provides: "Export modal calling exportRun IPC"
    - path: "apps/desktop/src/features/post-production/render-queue/queue-widget.tsx"
      provides: "Top-bar active render list with live progress + cancel"
  key_links:
    - from: "apps/desktop/src/features/post-production/preview/preview-player.tsx"
      to: "apps/desktop/src/features/post-production/preview/preview-engine.ts (Plan 04)"
      via: "new PreviewEngine({ canvas, videoElement, ... }); engine.renderFrame(t_ms, plan)"
      pattern: "PreviewEngine"
    - from: "apps/desktop/src/features/post-production/export-modal/export-modal.tsx"
      to: "apps/desktop/src/ipc/export.ts (Plan 12a)"
      via: "calls exportRun(request) on submit"
      pattern: "exportRun"
    - from: "apps/desktop/src/features/post-production/render-queue/queue-widget.tsx"
      to: "apps/desktop/src/features/post-production/hooks/use-render-progress.ts"
      via: "subscribes to Channel<RenderProgress>"
      pattern: "stream_render_progress"
    - from: "apps/desktop/src/features/post-production/sound-browser/sound-drawer.tsx"
      to: "apps/desktop/src/ipc/sound-library.ts (Plan 12a)"
      via: "soundLibraryList({ category }) via TanStack Query"
      pattern: "sound_library_list"
---

<objective>
Deliver UI-05 (Plan 12b of a 12a/12b split): the React UI of the Post-Production Editor — 4-pane shell, 5-track timeline with clips/playhead/snapping, preview player wired to Plan 04's PreviewEngine, inspector panels (Presets/Effects/Sound tabs), sound library drawer with wavesurfer.js previews, export modal, render queue widget, layer track components. Depends on Plan 12a's Zustand store + IPC wrappers + Tauri commands.

Purpose: The single biggest UI surface in the project where every Phase 2 feature meets the user. Layout per D-12/D-13/D-14. Human verify checkpoint confirms 60fps preview + working export + undo on reference hardware.

Output: ~30 React/TS files + Vitest tests + formal human-verify checkpoint covering the full editor journey.
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
  <name>Task 1: Editor shell + 5-track timeline + preview player + inspector + sound drawer</name>
  <read_first>
    - .planning/phases/02-cinematic-post-production-export/02-CONTEXT.md D-12, D-13, D-14
    - .planning/phases/02-cinematic-post-production-export/02-RESEARCH.md §11 layout diagram
    - apps/desktop/src/features/post-production/preview/preview-engine.ts (Plan 04)
    - packages/ui (shadcn + Base UI components from Phase 1)
  </read_first>
  <files>
    apps/desktop/src/routes/post-production.tsx
    apps/desktop/src/features/post-production/editor-shell.tsx
    apps/desktop/src/features/post-production/timeline/timeline.tsx
    apps/desktop/src/features/post-production/timeline/track.tsx
    apps/desktop/src/features/post-production/timeline/clip.tsx
    apps/desktop/src/features/post-production/timeline/playhead.tsx
    apps/desktop/src/features/post-production/timeline/snapping.ts
    apps/desktop/src/features/post-production/preview/preview-player.tsx
    apps/desktop/src/features/post-production/preview/transport-controls.tsx
    apps/desktop/src/features/post-production/inspector/inspector-panel.tsx
    apps/desktop/src/features/post-production/inspector/preset-picker.tsx
    apps/desktop/src/features/post-production/inspector/effect-params.tsx
    apps/desktop/src/features/post-production/sound-browser/sound-drawer.tsx
    apps/desktop/src/features/post-production/sound-browser/sound-row.tsx
    apps/desktop/src/features/post-production/hooks/use-preview.ts
    apps/desktop/src/features/post-production/hooks/use-hotkeys.ts
    apps/desktop/src/features/post-production/__tests__/timeline.test.tsx
  </files>
  <action>
    **Editor shell layout** per Research §11:
    ```tsx
    // editor-shell.tsx
    export function EditorShell({ storyId }: { storyId: string }) {
      return (
        <div className="grid h-screen grid-rows-[auto_1fr_30%]">
          <TopBar storyId={storyId} />
          <div className="grid grid-cols-[60%_40%]">
            <PreviewPlayer storyId={storyId} />
            <InspectorPanel />
          </div>
          <Timeline storyId={storyId} />
          <SoundDrawer />
          <ExportModal />
        </div>
      );
    }
    ```

    **Timeline component** with 5 tracks:
    ```tsx
    const TRACK_IDS = ['video', 'cursor', 'zoom', 'sound', 'annotations'] as const;
    export function Timeline({ storyId }: { storyId: string }) {
      const tracks = useEditorStore(s => s.tracks);
      return (
        <div className="flex flex-col" role="region" aria-label="Timeline">
          <TimeRuler />
          {TRACK_IDS.map(id => <Track key={id} id={id} clips={tracks[id]} />)}
          <Playhead />
        </div>
      );
    }
    ```

    **Snapping logic** (D-13):
    ```typescript
    // snapping.ts
    export const SNAP_THRESHOLD_PX = 10;
    export function snapX(candidateMs: number, targets: number[], pxPerMs: number): number {
      const thresholdMs = SNAP_THRESHOLD_PX / pxPerMs;
      let best = candidateMs;
      let bestDist = Infinity;
      for (const t of targets) {
        const d = Math.abs(candidateMs - t);
        if (d < thresholdMs && d < bestDist) { best = t; bestDist = d; }
      }
      return best;
    }
    ```
    Alt-held check: `useHotkeys('alt', ...)` + a `altDown` flag on the store's timeline slice toggles snap temporarily.

    **Preview player** wires Plan 04's PreviewEngine:
    ```tsx
    export function PreviewPlayer({ storyId }: { storyId: string }) {
      const canvasRef = useRef<HTMLCanvasElement>(null);
      const videoRef = useRef<HTMLVideoElement>(null);
      const playheadMs = useEditorStore(s => s.playheadMs);
      const engineRef = useRef<PreviewEngine | null>(null);
      useEffect(() => {
        if (!canvasRef.current || !videoRef.current) return;
        const engine = new PreviewEngine({ canvas: canvasRef.current, videoElement: videoRef.current, outputWidth: 1920, outputHeight: 1080 });
        engine.init().then(() => { engineRef.current = engine; });
        return () => { engineRef.current?.dispose(); engineRef.current = null; };
      }, []);
      useEffect(() => {
        const eng = engineRef.current;
        if (!eng) return;
        if (videoRef.current) videoRef.current.currentTime = playheadMs / 1000;
        // renderFrame with current PreviewRenderPlan from store
        const plan = useEditorStore.getState().computePreviewPlan();
        eng.renderFrame(playheadMs, plan);
      }, [playheadMs]);
      return (<div><video ref={videoRef} hidden src={`asset://recording-${storyId}.mp4`} /><canvas ref={canvasRef} width={1920} height={1080} /><TransportControls /></div>);
    }
    ```

    **Inspector panel** with 3 tabs using shadcn/ui Tabs primitive: Presets grid reads from `presetList({ scope: 'project' })` via TanStack Query; Effects tab shows selected node's params via `effect-params.tsx`; Sound tab hosts BGM selector.

    **Sound drawer** uses wavesurfer.js for static waveform previews:
    ```tsx
    // sound-row.tsx
    export function SoundRow({ entry }: { entry: SoundLibraryEntry }) {
      const containerRef = useRef<HTMLDivElement>(null);
      useEffect(() => {
        if (!containerRef.current) return;
        const ws = WaveSurfer.create({ container: containerRef.current, waveColor: '#4a4', height: 32, barWidth: 2, interact: false });
        ws.load(convertFileSrc(entry.file_path));
        return () => ws.destroy();
      }, [entry.file_path]);
      return (<div draggable onDragStart={e => e.dataTransfer.setData('sound-entry', JSON.stringify(entry))} role="listitem" aria-label={`${entry.name}, ${entry.duration_ms}ms, ${entry.license}`}><div ref={containerRef} /><span>{entry.name}</span></div>);
    }
    ```

    **Hotkeys hook** using react-hotkeys-hook:
    ```typescript
    export function useEditorHotkeys() {
      const { playPause, seekBy, removeSelected } = useEditorStore(s => ({ playPause: s.playPause, seekBy: s.seekBy, removeSelected: s.removeSelected }));
      useHotkeys('space', playPause, { preventDefault: true });
      useHotkeys('right', () => seekBy(33), { preventDefault: true });
      useHotkeys('left', () => seekBy(-33), { preventDefault: true });
      useHotkeys('shift+right', () => seekBy(5000));
      useHotkeys('shift+left', () => seekBy(-5000));
      useHotkeys('delete,backspace', removeSelected);
      // cmd+z / cmd+shift+z wired in Plan 13
    }
    ```

    Write Vitest test `timeline.test.tsx`: render Timeline with 2 clips; simulate drag clip to within 8 px of playhead → asserts clip.startMs == playhead (snapped); repeat with Alt held → no snap.

    **Accessibility:** every interactive element has `aria-label` (e.g. `Cursor clip at 12.5s, 3.2s duration`), focus-ring via Tailwind `focus-visible:ring-2`. Add an assertion test that uses `@testing-library/jest-dom`'s `toBeAccessible` or `jest-axe` (optional; add to devDeps) to scan Timeline for ARIA violations.

    Add the route to the existing router at `apps/desktop/src/App.tsx` (Phase 1): `<Route path="/post-production/:storyId" element={<PostProductionRoute />} />`.
  </action>
  <verify>
    <automated>pnpm --filter desktop exec vitest run src/features/post-production/__tests__/timeline.test.tsx && pnpm --filter desktop exec tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q "TRACK_IDS = \\['video', 'cursor', 'zoom', 'sound', 'annotations'\\]" apps/desktop/src/features/post-production/timeline/timeline.tsx` succeeds (5 fixed tracks).
    - `grep -q "SNAP_THRESHOLD_PX = 10" apps/desktop/src/features/post-production/timeline/snapping.ts` succeeds.
    - `grep -q "new PreviewEngine" apps/desktop/src/features/post-production/preview/preview-player.tsx` succeeds.
    - `grep -q "WaveSurfer.create" apps/desktop/src/features/post-production/sound-browser/sound-row.tsx` succeeds.
    - `grep -q "useHotkeys('space'" apps/desktop/src/features/post-production/hooks/use-hotkeys.ts` succeeds.
    - `grep -q "role=\"region\" aria-label=\"Timeline\"" apps/desktop/src/features/post-production/timeline/timeline.tsx` succeeds.
    - `pnpm --filter desktop exec vitest run src/features/post-production/__tests__/timeline.test.tsx` passes.
    - `pnpm --filter desktop exec tsc --noEmit` exits 0.
  </acceptance_criteria>
  <done>Editor shell + timeline + preview + inspector + sound drawer assembled.</done>
</task>

<task type="auto">
  <name>Task 2: Export modal + render queue widget + progress channel subscription</name>
  <read_first>
    - apps/desktop/src/ipc/export.ts + render.ts (Task 1)
    - Plan 10 stream_render_progress Channel<RenderProgress>
    - Plan 11 ExportRequest shape
  </read_first>
  <files>
    apps/desktop/src/features/post-production/export-modal/export-modal.tsx
    apps/desktop/src/features/post-production/export-modal/format-checkboxes.tsx
    apps/desktop/src/features/post-production/render-queue/queue-widget.tsx
    apps/desktop/src/features/post-production/render-queue/job-row.tsx
    apps/desktop/src/features/post-production/hooks/use-render-progress.ts
    apps/desktop/src/features/post-production/__tests__/export-modal.test.tsx
  </files>
  <action>
    **Export modal** using shadcn Dialog:
    ```tsx
    export function ExportModal() {
      const open = useEditorStore(s => s.exportModalOpen);
      const close = useEditorStore(s => s.closeExport);
      const [formats, setFormats] = useState<Record<OutputFormat, boolean>>({ Mp4: true, WebM: false, Gif: false });
      const [resolution, setResolution] = useState<Resolution>('R1080p');
      const [fps, setFps] = useState(60);
      const [quality, setQuality] = useState<Quality>('Med');
      const [outFolder, setOutFolder] = useState<string | null>(null);
      const pickFolder = async () => { const f = await invoke<string | null>('plugin:dialog|open', { options: { directory: true } }); if (f) setOutFolder(f); };
      const onSubmit = async () => {
        const outputs = Object.entries(formats).filter(([,v]) => v).map(([f]) => ({ format: f as OutputFormat, resolution, fps, quality }));
        const res = await exportRun({ story_id: currentStoryId, graph: useEditorStore.getState().computeGraph(), outputs, priority: 0, output_folder: outFolder! });
        toast.success(`Export queued: ${res.job_ids.length} jobs`);
        close();
      };
      return (<Dialog open={open} onOpenChange={v => !v && close()}><DialogContent>{/* FormatCheckboxes + Select for resolution/fps/quality + FolderPicker + ExportButton */}</DialogContent></Dialog>);
    }
    ```

    **Render queue widget** (top-bar dropdown):
    ```tsx
    export function QueueWidget() {
      const { data: jobs = [] } = useQuery({ queryKey: ['render-jobs', storyId], queryFn: () => renderListActive(storyId), refetchInterval: 3000 });
      const progressMap = useRenderProgress();
      return (<Popover>
        <PopoverTrigger aria-label={`${jobs.length} active renders`}><Badge>{jobs.length}</Badge></PopoverTrigger>
        <PopoverContent>{jobs.map(j => <JobRow key={j.id} job={j} progress={progressMap[j.id]} onCancel={() => renderCancel(j.id)} />)}</PopoverContent>
      </Popover>);
    }
    ```

    **use-render-progress hook** subscribes to the Tauri Channel:
    ```typescript
    export function useRenderProgress(): Record<string, RenderProgress> {
      const [map, setMap] = useState<Record<string, RenderProgress>>({});
      useEffect(() => {
        const channel = new Channel<RenderProgress>();
        channel.onmessage = p => setMap(prev => ({ ...prev, [p.job_id]: p }));
        invoke('stream_render_progress', { channel });
        return () => { /* cleanup: tauri auto-closes channel on command return */ };
      }, []);
      return map;
    }
    ```

    **Tests** `export-modal.test.tsx`:
    - Render modal with formats all off; click Export → button disabled (no formats selected).
    - Select MP4 + 1080p + 60fps + Med quality + pick folder (mock dialog to return "/tmp/foo"); click Export → invoke mock asserts `export_run` called with correct outputs array.
    - Attempt to select GIF + 4K → UI shows warning (validate_config error surfaced).

    Wire ExportModal and QueueWidget into `editor-shell.tsx`.
  </action>
  <verify>
    <automated>pnpm --filter desktop exec vitest run src/features/post-production/__tests__/export-modal.test.tsx</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q "exportRun" apps/desktop/src/features/post-production/export-modal/export-modal.tsx` succeeds.
    - `grep -q "plugin:dialog|open" apps/desktop/src/features/post-production/export-modal/export-modal.tsx` succeeds (folder picker).
    - `grep -q "stream_render_progress" apps/desktop/src/features/post-production/hooks/use-render-progress.ts` succeeds.
    - `grep -q "renderCancel" apps/desktop/src/features/post-production/render-queue/queue-widget.tsx` succeeds.
    - `grep -q "new Channel<RenderProgress>" apps/desktop/src/features/post-production/hooks/use-render-progress.ts` succeeds.
    - `pnpm --filter desktop exec vitest run src/features/post-production/__tests__/export-modal.test.tsx` passes ≥3 tests.
  </acceptance_criteria>
  <done>Export modal + render queue widget wired and tested.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Human verify — full editor journey (scrub 60fps + 3 presets + MP4/WebM/GIF export + undo-all/redo-all)</name>
  <what-built>
    End-to-end Post-Production Editor UI:
    - 4-pane layout (Preview + Inspector + Timeline + Sound drawer + Export modal + Queue widget)
    - 5 fixed tracks, magnetic snapping (Alt to disable)
    - WebGPU/WebGL2 preview driving Plan 04 PreviewEngine with the full AST from all Phase 2 features
    - Export modal calling Plan 11's export_run; render queue widget showing live progress
  </what-built>
  <how-to-verify>
    **Environment:** `pnpm --filter desktop dev` launches the Tauri dev build. Open any existing Phase 1 sample recording (create a quick one first if none exists). Navigate to `/post-production/<story-id>`.

    **1. Scrub at 60fps (no jank).**
       - Open devtools Performance monitor.
       - Drag the timeline playhead continuously for 10 seconds across the full duration.
       - Confirm sustained ~60 fps (frame time ≤ 16.6 ms) with no dropped frames > 100 ms on 1080p reference hardware.
       - Note active backend ('webgpu' or 'webgl2') logged in console.

    **2. Apply 3 different presets and verify preview matches expectations.**
       - In Inspector → Presets tab, apply each of 3 bundled presets in sequence (e.g. "Runway Cinematic", "Calm Tutorial", "Fast Demo").
       - For each preset, within ~500 ms the preview should reflect the change (zoom behaviour, cursor style, ripple intensity, BGM swap). Visually confirm each preset looks distinct.

    **3. Export MP4 + WebM + GIF; confirm files play correctly.**
       - Open Export modal. Check all three formats (MP4 + WebM + GIF), set 1080p + 60 fps + Med quality (GIF auto-falls-back to 720p30 per Plan 11 validator — verify the UI warning).
       - Pick an output folder, click Export.
       - Toast: "Export queued: 3 jobs". Queue widget badge shows "3".
       - Wait for all 3 to complete. Open each in QuickTime / VLC / a browser:
         - MP4: plays correctly with audio.
         - WebM: plays correctly in Chrome.
         - GIF: plays as animated image (no audio expected).

    **4. Apply 5 actions, undo all, redo all (verify cmd+z / cmd+shift+z).**
       - Perform 5 distinct undoable actions in order: (a) move a clip, (b) trim a clip, (c) apply a different preset, (d) drag a BGM clip onto Sound track, (e) change a text overlay string.
       - Press cmd+z (or ctrl+z) five times. After each undo, confirm the UI reverts the matching action. After the 5th undo the timeline should match the original state.
       - Press cmd+shift+z (or ctrl+shift+z, or ctrl+y on Windows) five times. After each redo the matching action should re-apply. After the 5th redo the timeline should match the post-5-actions state.
       - This confirms Plan 13's undo-bridge wiring works end-to-end through the 12a store.

    **5. Accessibility smoke test.**
       - Tab through the timeline; every clip has a visible focus ring.
       - Arrow keys move the clip selection.
       - VoiceOver (macOS) or NVDA (Windows) announces timeline clips as "Cursor clip at 12.5 seconds, 3.2 seconds duration" (or equivalent).

    **If any of 1-5 fails, describe which sub-step and the observed behaviour. A follow-up patch task will be created via `/gsd-plan-phase --gaps`.**
  </how-to-verify>
  <resume-signal>Type "approved" if all steps pass. Otherwise describe failures — a follow-up patch task will be created.</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| user folder picker (tauri-plugin-dialog) -> export_run | Path validated server-side (Plan 11 validate_folder) |
| wavesurfer.js loading audio from asset:// | Tauri asset protocol is scope-limited |
| Plan 04 WebGPU context -> preview canvas | Single device per component lifecycle (D-33) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-36 | Denial of service | WebGPU context lost on webview navigate | mitigate | PreviewPlayer useEffect cleanup disposes engine on unmount; re-inits on mount |
| T-02-37 | Information disclosure | Render queue shows other stories' jobs | accept | render_list_active filters by story_id; desktop is single-user |
| T-02-38 | Tampering | User drags an unsupported file into Sound drawer | mitigate | sound-row.tsx only accepts drags originating from the library (checks dataTransfer.types includes 'sound-entry') |
</threat_model>

<verification>
1. `pnpm --filter desktop exec vitest run src/features/post-production/` passes.
2. `pnpm --filter desktop exec tsc --noEmit` exits 0.
3. `pnpm --filter desktop dev` launches; route /post-production/:storyId renders.
4. Human verify checkpoint approved.
</verification>

<success_criteria>
- UI-05 satisfied: video timeline with scene markers + 5 fixed tracks (Video, Cursor, Zoom, Sound, Annotations); preview player with real-time effect rendering; effect preset panel; sound library browser with waveform previews; export settings panel.
- Zustand slices + TanStack Query caching per D-32.
- Preview player owns WebGPU context lifecycle per D-33 (via Plan 04 PreviewEngine).
- WCAG 2.1 AA preserved across all new components.
- Human verifies 60fps preview + MP4+WebM export on reference hardware.
</success_criteria>

<output>
After completion, create `.planning/phases/02-cinematic-post-production-export/02-12b-SUMMARY.md` including measured preview fps from the human-verify checkpoint and any accessibility issues found.
</output>
