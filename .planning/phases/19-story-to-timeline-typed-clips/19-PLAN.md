# Phase 19 — Story → Timeline Producer + Typed Clip Schema

**Status:** SHIPPED IN SOURCE — original plan retained for traceability
**Date drafted:** 2026-04-27
**Depends on:** Phase 18 (real video wiring + computeGraph plumbing landed)
**Driver:** Phase 18 P18-B's producer audit confirmed `compute-graph.ts` will always emit empty graphs in production until clip-population path exists. This phase builds that path.

> Refresh note (2026-05-02): source now contains the Phase 19 outcomes:
> typed Clip discriminated union, `get_recording_trajectory`,
> `get_recording_actions`, `get_recording_step_timing`, and
> `build-timeline-from-story.ts`. This artifact remains plan-shaped because no
> separate `19-SUMMARY.md` has been written yet.

## Goal

Make `computeGraph()` produce non-empty graphs for real recordings so the export button gates on real renderable content, by:

1. Auto-populating the post-production timeline from `.story` script + recording trajectory when user opens `/post-production/<storyId>`.
2. Replacing `Clip.metadata: Record<string, unknown>` with a discriminated union so producer ↔ consumer share a schema (no field-name drift).

## Acceptance Criteria (goal-backward)

1. **AC1** — User opens `/post-production/<storyId>` for a recording that exists. Timeline auto-populates with ≥1 video clip and ≥0 cursor/zoom/annotation clips. Preview shows real video (Phase 18-A).
2. **AC2** — User clicks Export. `graph_json` is non-empty, `graphIsRenderable() === true`, exportRun IPC accepts the payload, encoder consumes it without deserialize error.
3. **AC3** — `Clip` is a discriminated union. Zero `Record<string, unknown>` casts in producers OR consumers. `compute-graph.ts` accesses typed fields directly (no `readString`/`readNumber` helpers).
4. **AC4** — `pnpm typecheck` + `cargo check --workspace` + `pnpm vitest run` + `cargo test -p effects` all green. No regression in 78/80 vitest baseline.

## Architecture Decision (locked)

**D-1: Frontend-only producer (Option A) over Rust bridge.**

| Option | Pros | Cons |
|---|---|---|
| **A. Frontend producer** ✓ | Symmetric with Phase 18-B (computeGraph also TS). No new IPC except trajectory read. Iterates fast. | Logic not reusable for headless/CI render. |
| B. Rust `story_to_timeline` crate + IPC | Single source-of-truth. Reusable for headless render. | New crate + IPC + tauri-specta regen + types regen. Larger surface change. |
| C. Hybrid (heuristic in Rust, UI in TS) | Best perf for trajectory math. | Two-producer interface is the worst of both worlds. |

Refactor to Option B is a future phase IF headless render needs the same conversion. Today's editor is the only consumer.

## Plan Breakdown — 3 plans, sequential (cannot parallelize)

### Plan 19-01 — Typed Clip discriminated union (foundation, blocking)

**Scope:** Frontend only. No Rust touched.

**Files modified:**
- `apps/desktop/src/features/post-production/state/timeline-slice.ts` — replace flat `Clip` interface with discriminated union keyed on `trackId`:
  ```ts
  type VideoClip      = ClipBase & { trackId: "video";       sourcePath: string; }
  type CursorClip     = ClipBase & { trackId: "cursor";      trajectoryDir: string; trajectoryFps: number; trajectoryFrameCount: number; skin: string; sizeScale: number; }
  type ZoomClip       = ClipBase & { trackId: "zoom";        target: ZoomTarget; scale: number; center: {x:number,y:number}; preset?: "DYNAMIC"|"CALM"|"SUBTLE"; }
  type SoundClip      = ClipBase & { trackId: "sound";       path: string; kind: "bgm"|"sfx"|"voiceover"; gain?: number; }
  type AnnotationClip = ClipBase & { trackId: "annotations"; text: string; pos: {x:number,y:number}; sizePt: number; color?: string; }
  type Clip = VideoClip | CursorClip | ZoomClip | SoundClip | AnnotationClip
  ```
  Add per-variant typed setters: `addVideoClip`, `addCursorClip`, `addZoomClip`, `addAnnotationClip` (sound already typed).
- `state/compute-graph.ts` — drop `readString`/`readNumber` helpers, access typed fields directly.
- `undo/actions.ts` — generic `add-clip` payload becomes type-narrowed by `trackId`.
- `layer-tracks/clip-affordance.tsx` — `presetLabel` becomes typed switch on `trackId`.
- `sound-browser/` — only existing producer; verify it still compiles against typed `SoundClip`.

**Tests:**
- All existing post-prod tests must stay green (74/76 baseline excluding the 2 pre-existing GPU fails — F3's wiring brought timeline tests up from 73/75).
- New: type-level test (or compile-time assertion) that mismatched `metadata` shape fails type check.

**Estimate:** 1 agent, ~30–45 min. NO PARALLEL — this is the bedrock everything else builds on.

**Risk:** Refactor surface is wide; agent may discover producers we didn't anticipate. Mitigation: agent grep `Clip\b` and `tracks.{video,cursor,zoom,annotations}` first, list all writers before refactoring.

---

### Plan 19-02 — Recording trajectory artifact + IPC

**Scope:** Backend + IPC + thin TS facade.

**Pre-flight check (Wave 0):** confirm whether trajectory data is currently persisted at recording time.
- Audit `crates/capture/`, `crates/automation/executor.rs`, `apps/desktop/src-tauri/src/commands/capture.rs`.
- If trajectory IS persisted → skip to step 1.
- If NOT persisted → spike: capture pipeline must write a sidecar `<recording_id>.trajectory.json` per recording. Scope grows by ~1 hour.

**Files modified (assuming trajectory exists or persistence is added):**
- `apps/desktop/src-tauri/src/commands/projects.rs` (or new `trajectory.rs`) — Tauri command `get_recording_trajectory(recording_id) -> TrajectoryDto`.
- `apps/desktop/src-tauri/src/ipc_spec.rs` — register command. Run tauri-specta regen.
- `apps/desktop/src/ipc/projects.ts` (or new `trajectory.ts`) — TS facade matching Phase 18 `useProjectRecordings` pattern.
- `apps/desktop/src/features/post-production/hooks/use-recording-trajectory.ts` — React Query hook.

**`TrajectoryDto` shape (proposed):**
```rust
struct TrajectoryDto {
  recording_id: String,
  fps: u32,
  frame_count: u32,
  // Either inline frames (if small) or path to PNG sequence dir.
  // Decision: inline if frame_count < 1800 (30s at 60fps), else path.
  frames: Option<Vec<TrajectoryFrame>>,
  png_sequence_dir: Option<String>,
}
struct TrajectoryFrame { t_ms: u32, x: f32, y: f32, click: bool }
```

**Tests:**
- Rust: golden trajectory JSON round-trip serialize/deserialize.
- TS: hook returns expected shape on success; handles 404 gracefully.

**Estimate:** 1 agent, ~30 min IF trajectory persisted; +1 hour spike IF not.

---

### Plan 19-03 — Story → Timeline producer + auto-population

**Scope:** Frontend only. Depends on 19-01 (typed clips) + 19-02 (trajectory IPC).

**Files modified:**
- `apps/desktop/src/features/post-production/state/build-timeline-from-story.ts` (NEW):
  - Input: `{ story: StoryDto, trajectory: TrajectoryDto, recording: RecordingInfo }`
  - Output: `{ video: VideoClip[], cursor: CursorClip[], zoom: ZoomClip[], annotations: AnnotationClip[] }` (sound stays user-driven)
  - Heuristics:
    - 1 `VideoClip` covering full `recording.duration_ms`, `sourcePath = recording.path`.
    - 1 `CursorClip` covering `[0, duration]`, points to `trajectory.png_sequence_dir` (or inlines frames if small).
    - Auto-zoom: detect Click/Hover/Drag commands in `story.scenes[].commands` with click events in trajectory. Each click → 1 `ZoomClip` (start: click_t - 200ms, end: click_t + 600ms, scale 1.3, center on click x/y, preset CALM).
    - Annotations: optional. v1 derives from `Scene.title` if present (1 `AnnotationClip` per scene start). Fallback: empty.
- `state/timeline-slice.ts` — add bulk `setTracks(tracks: Partial<Tracks>)` setter (idempotent, replaces specified tracks).
- `features/post-production/editor-shell.tsx` (Phase 18-A wiring) — when `recording` resolves AND `story` resolves AND `trajectory` resolves AND `tracks.video.length === 0` (don't clobber user edits), call `setTracks(buildTimelineFromStory(...))`.

**Behavior:**
- Auto-population is one-shot per session entry. After it runs, user edits + undo/redo work normally.
- If user previously edited and persisted (Phase 18-B persist), respect persisted state — don't auto-populate over it. (Decision: detect via persist hydration timestamp or simple `tracks.video.length > 0` heuristic.)

**Tests:**
- Golden: small Story DTO + trajectory fixture → expected `Tracks` shape (vitest snapshot).
- Auto-zoom: 3 click commands in trajectory → exactly 3 ZoomClips at expected times.
- Idempotence: calling builder twice with same input yields same output.

**Estimate:** 1 agent, ~30–45 min.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Trajectory not persisted at recording time | Medium | +1 hour spike | Wave 0 audit in 19-02 before scope locks |
| Discriminated union refactor (19-01) hits unanticipated producers | Medium | +0.5 hour | Agent grep + producer list before refactoring |
| Auto-zoom heuristic (19-03) feels wrong subjectively | High | UX polish | Ship simple rule first; iterate based on operator feedback |
| `compute-graph.ts` (P18-B) drift if 19-01 changes shape names | Low | Type errors will catch | Same agent owns 19-01 + compute-graph migration |
| BigInt vs number mismatch when surfacing typed shapes via shared-types | Medium | Already mitigated in P18-B by local types | Continue using local TS types until generated file's BigInt issue is resolved upstream |

## Out of Scope

- Headless / CI render of the same graph (Option B refactor).
- Operator-gated audio curation (02-08 BLOCKER).
- Smart annotation generation (LLM-derived). v1 uses scene titles only.
- Export-time render of the populated graph. The encoder side is Phase 13's quality knobs and works once the graph is non-empty.
- Shipping changes to recording capture pipeline (would happen in 19-02 only if Wave 0 audit forces it).

## Decisions (locked 2026-04-27)

- **D-1** ✓ One-shot auto-population, guarded by `tracks.video.length === 0`. Don't clobber persisted user edits.
- **D-2** ✓ Trajectories > 1800 frames surface as `png_sequence_dir` path; inline only when smaller. Avoids blowing up Zustand persist payload.
- **D-3** ✓ Skip annotations in v1. Auto-populate `video` + `cursor` + `zoom` only. User adds annotations manually. Revisit after operator feedback.

## Plan Authoring Notes

- Plans must execute SEQUENTIAL: 19-01 → 19-02 → 19-03. No parallel; 19-03 depends on both predecessors' types and IPC.
- Each plan is one Wave. Total: 3 Waves, 3 agents.
- Total estimate: ~2 hours wall time (if no spike); ~3 hours if trajectory persistence spike triggers.
