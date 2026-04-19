---
phase: 10
type: research
status: ready-for-planning
date: 2026-04-18
---

# Phase 10: Author-time simulator — Research

**Researched:** 2026-04-18
**Domain:** Author-time DSL execution against the Phase 9-04 ephemeral Playwright session, producing (a) step-bounded run-to-here preview, (b) scrubable per-step timeline with screenshots + matched bboxes + cursor coords; timeline ↔ CodeMirror line linkage.
**Confidence:** HIGH on executor + storage + IPC shapes; MEDIUM on Phase 9-04 coordination (9-04 not shipped yet — coordination surface is spec-only); LOW on Phase 3 dry-run-vs-Phase-10 dry-run naming collision (see Design Conflicts).

## Summary

The three named surfaces (executor, storage, UI) each have a clean extension point. The unresolved piece is **coordination with code that already calls itself "Dry-Run"**: Phase 3 shipped an `intelligence::dryrun` orchestrator + Tauri `dryrun_start/_cancel` + a `DryRunPanel.tsx` that is NOT a placeholder — it is a working UI against a stub driver (`StubBrowserDriver` in `apps/desktop/src-tauri/src/commands/dryrun.rs:105-131`). The 10-CONTEXT truth "`DryRunPanel.tsx` existing placeholder becomes the timeline" is factually wrong, and the CONTEXT.md assumes an executor integration (`Executor::run_to_step` on the Phase 1 `automation::Executor`) that does not match the tier where the existing dry-run runs. See Design Conflicts Discovered.

Assuming those conflicts are resolved in discuss-phase, the implementation is three narrow seams:
- **Executor:** thread a `stop_after_ordinal: Option<u32>` through `run_story` and add a branch that emits `ExecutorEvent::RunPaused` + leaves drivers launched (so subsequent `run_to_step` calls resume). Capture `StepFrame` inside the existing `StepSucceeded` path — per-step screenshot reuses `driver.screenshot()`; cursor coords reuse `driver.current_cursor_position()`; bbox comes from the sidecar's already-built `elementState` RPC (`scripts/playwright-sidecar/server.mjs:326-355`).
- **Storage:** `project_dir/.story.dryrun/<uuid>/` parallel to the shipped `.story.snapshots/` (07-05) and `.story.targets.json` (07-04c) conventions. Retention: directory ls + mtime sort + unlink all but newest 5 on each new dry-run start.
- **UI:** CodeMirror 6 line decorations (`Decoration.line` + `StateField<DecorationSet>`) driven by a new Zustand slice. Timeline is a horizontal scrubber of thumbnails; scrub event updates `currentFrameOrdinal` → decoration StateField recomputes → editor highlights that line; clicking a DSL line dispatches the inverse.

**Primary recommendation:** Rename the Phase-10 surface everywhere to **"simulator"** (or split the two features: "Step Preview" + "Walkthrough") to avoid semantic collision with the shipped Phase-3 `dryrun_*` commands and `DryRunPanel.tsx`. Treat Phase 10 as introducing new commands (`simulator_start/_stop/_step_to`), a new panel (`SimulatorTimeline.tsx`), and new store (`simulatorStore`). Gate the Phase 3 Dry-Run flow behind a feature flag to deprecate later. This is the one big decision; everything downstream is mechanical.

## User Constraints (from 10-CONTEXT.md)

### Locked Decisions

- **D-01:** Reuse Phase 9-04's ephemeral author-time Playwright session. No third Chromium instance.
- **D-02:** Executor gains a `run_to_step(n)` entry point; extend existing `ExecutorEvent` pipe with `RunPaused`; run-to-end path unchanged.
- **D-03:** Dry-run and step-preview share one artifact schema `Vec<StepFrame { ordinal, screenshot_path, cursor_xy, matched_selector, matched_bbox, duration_ms }>`. Step-preview is dry-run with `stop_after = caret_line`.
- **D-04:** Dry-run frames stored in `project_dir/.story.dryrun/<timestamp>/`; retention = 5; cleaned on project close.
- **D-05:** Timeline UI is a thin React component over `StepFrame[]`; Zustand-driven; CodeMirror line decoration syncs via shared `currentFrameOrdinal`.

### Claude's Discretion

- Plan split granularity (3 plans proposed, 10-01 may split to 10-01a/b).
- Naming of new surfaces (simulator vs dry-run — see recommendation and Design Conflicts).
- Concurrency protocol between author-session Live Preview and dry-run (exclusive lock, pause/resume semantics).

### Deferred Ideas (OUT OF SCOPE)

- Producing a final video during dry-run (Record button remains sole path).
- Running DSL against the live recording session.
- Persistent dry-run archives across sessions — in-memory + last-5-on-disk only.
- "Snapshot-only" (no-network) mode.

## Phase Requirements

**NO requirement IDs currently allocated in REQUIREMENTS.md** — searched 2026-04-18, only ROADMAP.md references `PHASE-10.x`. Planner MUST add requirement IDs during plan-phase. Proposed allocations (based on CONTEXT acceptance criteria):

| Proposed ID | Description | Research Support |
|-------------|-------------|------------------|
| PHASE-10.1 | `Executor::run_to_step(n)` stops after ordinal `n` and emits `RunPaused`; re-invocation from ordinal `n+1` continues without relaunch | Existing `run_story` already has loop-exit point at `break 'scenes` (executor.rs:239); identical treatment for `RunPaused` with drivers kept alive is a local refactor |
| PHASE-10.2 | Per-step `StepFrame` capture writes `screenshot.png`, `cursor (x,y)`, matched selector string, matched element bbox, step duration | `driver.screenshot()` (executor.rs:220, 399), `driver.current_cursor_position()` (executor.rs:204), `elementState.bbox` (sidecar server.mjs:336-353) all already exist |
| PHASE-10.3 | "Preview to here" action at caret line `L` resolves to the step whose span contains `L` and runs `run_to_step(ordinal(L))`; ≤10 s for 20 steps on M2 | Span data available on `CommandDto` via `parse::parse_story` — see `SpanDto` in ipc_spec.rs:189 |
| PHASE-10.4 | Dry-run frames persist to `<project>/.story.dryrun/<uuid>/`; keep last 5 dry-runs on new-dryrun-start; cleared on project close | Mirrors `.story.snapshots/` convention from 07-05 (07-05-PLAN.md line 49) |
| PHASE-10.5 | Timeline scrub updates CodeMirror line decoration within one frame; click-line jumps timeline frame | CodeMirror `Decoration.line` + `StateField<DecorationSet>` + `EditorView.dispatch` is standard; no existing usage in repo — new pattern |
| PHASE-10.6 | Dry-run populates `.story.targets.json` fallbacks on first success (07-04c self-healing protocol, unchanged) | Existing `try_promote_fallback` already runs in the default executor path (executor.rs:423-500) — if 10-02 plumbs `story_path` through, this is free |
| PHASE-10.7 | Phase 9-04 Live Preview pauses/resumes cleanly when dry-run takes exclusive lock on the author session | Requires 9-04 to expose a `pauseStream/resumeStream` sidecar RPC (not currently in the 09-04 plan) — see Design Conflicts |
| PHASE-10.8 | Author session and recording session never share a Chromium; recording path untouched | 09-04 already guarantees separate sidecar processes (09-04-PLAN.md line 74) |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `run_to_step(n)` loop control | `crates/automation` (`Executor::run_story`) | — | Phase 1 executor already owns the scene/command loop + event pipe (`executor.rs:107-267`) |
| Per-step screenshot + bbox + cursor capture | Inside executor's `StepSucceeded` emission | Playwright sidecar RPCs (`screenshot`, `elementState`, `cursorPosition`) | Adding capture next to the existing event emission preserves step→artifact atomicity |
| Ephemeral author-session lifecycle | 9-04's `start_author_preview` / `stop_author_preview` | Phase 10 NEW `simulator_attach(streamId)` for exclusive lock | Must not leak session creation into Phase 10; 10 consumes what 9-04 provides |
| Frame storage + retention | Rust host (`commands/simulator.rs`) writing into `<project>/.story.dryrun/` | `fs::rename` atomic directory swap on retention trim | Matches shipped `.story.snapshots/` + `.story.targets.json` atomic pattern (`targets_store.rs`) |
| `StepFrame[]` state | Zustand slice (`simulatorStore.ts`) | — | Same pattern as `dryRunStore`/`useSelectorValidation` |
| Timeline ↔ editor line linkage | CodeMirror `StateField<DecorationSet>` + effect dispatch | React component reads `currentFrameOrdinal` from Zustand and dispatches CM effect | Line decorations are a CM-native concept; no existing usage in repo (new extension) |
| Bidirectional sync (click-line → timeline) | React click handler on CM gutter OR new CM extension `EditorView.domEventHandlers` | — | Gutter-click + line-number-to-ordinal lookup via parsed AST spans |

## Standard Stack

### Core (all already in repo — no new deps for Phase 10)

| Library | Version (repo) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `tokio` | 1.40+ (workspace) | Async runtime for spawned executor task | Already used by `Executor::run_with_story_path` |
| `tokio::sync::mpsc` | same | ExecutorEvent pipe | Already used at `executor.rs:76` |
| `serde` / `serde_json` | 1.x | `StepFrame` serialization + JSON-RPC to sidecar | All crates use it |
| `uuid` | 1.x (feature `v4`) | Dry-run id for `.story.dryrun/<uuid>/` | Already used in `dryrun_start` (dryrun.rs:155) |
| `uuid` v7 | same | Step IDs from 07-04b already UUIDv7 — reused, not generated here |  |
| `@codemirror/view` | 6.x | `Decoration.line`, `EditorView.decorations`, `StateField` | Already depended via `@uiw/react-codemirror` 4.x (story-editor.tsx:2) |
| `@codemirror/state` | 6.x | `StateField` + `StateEffect.define<{frame: number \| null}>` for frame-to-decoration dispatch | Same |
| `zustand` | 5.x | `simulatorStore` slice | Every editor feature store uses it (dryRunStore.ts:9, SelectorValidatorOverlay.tsx:27) |
| `@tauri-apps/api` `Channel<T>` | 2.x | Stream `StepFrame` to renderer as they're captured | Already used in `dryrun_start` (useDryRun.ts:28) |

[VERIFIED: all via Grep of repo — no new dependencies required.]

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Extending `automation::Executor` (recommended) | Extending `intelligence::dryrun::run` (the Phase 3 orchestrator) | Phase 3 orchestrator has a private `BrowserDriver` trait distinct from `automation::BrowserDriver` (see `crates/intelligence/src/dryrun/mod.rs:1-19`); using it would force a parallel driver tree. The Phase 1 executor is the canonical DSL-driver bridge (auto-wait + self-healing + capability routing all live there) and is what CONTEXT D-02 references. Recommended: use Phase 1 executor and deprecate Phase 3's `dryrun` orchestrator (see Design Conflicts). [VERIFIED: both files read] |
| Dedicated frame capture RPC in sidecar | Reuse `screenshot` + `elementState` + `cursorPosition` RPCs the sidecar already has (server.mjs:320, 326, 358) | Existing RPCs give everything `StepFrame` needs; adding a combined `captureStepFrame` is 3 extra server lines but requires sidecar bump. Not worth it. |
| Binary Tauri Channel for frame stream | JSON-stringified `StepFrame { screenshot_path: string }` (file-path, not inline PNG) | Passing paths avoids re-encoding. Screenshot PNG lives on disk; renderer reads via `convertFileSrc()` or `readFile`. |

### Installation

None. No new dependencies.

## Architecture Patterns

### System Architecture Diagram

```
  [Editor page] ───► "Preview to here" (caret line L)
      │                  │
      │                  ▼
      │         simulator_step_to(project, story, L) ─[Tauri]──►
      │                  │
      │                  ▼
      │    commands/simulator.rs (new)
      │         │  resolves caret→ordinal via parsed AST spans
      │         │  acquires exclusive author-session lock (9-04)
      │         ▼
      │    Executor::run_with_story_path(..., stop_after_ordinal: Some(n), ...)
      │         │  per-step loop (executor.rs run_story scenes→commands)
      │         │     on StepSucceeded:
      │         │       ─► sidecar.screenshot(name, outDir) ────► PNG bytes
      │         │       ─► sidecar.elementState(resolvedSelector) ► bbox
      │         │       ─► sidecar.cursorPosition()            ► (x,y)
      │         │       ─► build StepFrame; write into
      │         │          <project>/.story.dryrun/<uuid>/<ordinal>.png
      │         │       ─► tx.send(ExecutorEvent::StepFrameCaptured { frame })
      │         │     on ordinal == stop_after_ordinal:
      │         │       ─► tx.send(ExecutorEvent::RunPaused { ordinal })
      │         │       ─► return without driver teardown (drivers held in task state)
      │         ▼
      │    Channel<SimulatorEvent>  (forwarder task pumps to webview)
      │         │
      ▼         ▼
  Zustand simulatorStore  ◄───────────────────────────────┐
      │  .frames[], .currentFrameOrdinal, .runState       │
      │                                                    │
      ▼                                                    │
  SimulatorTimeline.tsx  (horizontal thumb scrubber)       │
      │                                                    │
      └─ onScrub(frameN) ─► setCurrentFrameOrdinal(frameN) ┘
                            │
                            └─► CodeMirror StateEffect.of({ordinal: frameN})
                                └─► StateField<DecorationSet> recomputes
                                    └─► Line decoration highlights span
                                        (AST.command.span.start_line)
```

### Pattern 1: Executor loop gains optional stop-after-ordinal

**What:** Thread `stop_after_ordinal: Option<u32>` (and session-retention flag) through `run_story`; check `if Some(n) == Some(ordinal) { emit RunPaused; persist driver state in session registry; return; }` after `StepSucceeded` emission.

**When to use:** Only when phase-10 simulator commands call it. `launch_automation` for recording passes `None` — behavior unchanged.

**Example:**
```rust
// Source: crates/automation/src/executor.rs:107 (existing signature to extend)
async fn run_story(
    story: Story,
    story_path: Option<PathBuf>,
    mut primary: Box<dyn BrowserDriver>,
    mut fallback: Box<dyn BrowserDriver>,
    persistence: Option<PersistenceHandle>,
    screenshot_dir: PathBuf,
    launch_opts: LaunchOptions,
    control: Option<Arc<RunControl>>,
    stop_after_ordinal: Option<u32>,          // NEW
    capture_frames: bool,                      // NEW (off for recording path)
    frame_dir: Option<PathBuf>,                // NEW
    tx: mpsc::Sender<ExecutorEvent>,
) -> Result<()>
```

### Pattern 2: Session retention for resumable runs

**What:** For `run_to_step(n)` followed by `run_to_step(n+k)`, drivers must NOT be torn down. Phase 10 stores the `Box<dyn BrowserDriver>` pair + story + ordinal-reached in a session registry keyed by author-session id. Subsequent calls skip `primary.launch(launch_cfg)` (executor.rs:129) and resume iteration from `ordinal + 1`.

**Why:** Relaunching Chromium costs ~1.5 s per invocation on M2 — blows the "≤10 s for 20 steps" budget after two preview-to-here events.

**Anti-pattern:** Re-invoking the whole `Executor::run_with_story_path` for each `run_to_step` — this relaunches drivers and loses the CDP session.

### Pattern 3: CodeMirror line decoration via StateField + StateEffect

**What:** Standard CM6 pattern for externally-driven line highlights.

```typescript
// NEW: apps/desktop/src/features/editor/simulator-decoration.ts
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

export const setActiveFrame = StateEffect.define<number | null>();

const activeLineMark = Decoration.line({ class: "cm-simulator-active-step" });

export const simulatorDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setActiveFrame)) {
        if (e.value == null) return Decoration.none;
        const line = ordinalToLine(e.value); // from parsed AST spans
        const from = tr.state.doc.line(line).from;
        return Decoration.set([activeLineMark.range(from)]);
      }
    }
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});
```

Dispatch from React:
```typescript
view.dispatch({ effects: setActiveFrame.of(frameOrdinal) });
```

[CITED: https://codemirror.net/docs/ref/#view.Decoration.line — CM6 authoritative docs]

### Anti-Patterns to Avoid

- **Running `run_to_step` against a recording-session author browser.** 9-04 guarantees separate processes (09-04-PLAN.md:74). Never share.
- **Capturing step frames for recording-path runs.** Would double I/O and compete with the encoder for disk. Guard with the `capture_frames` parameter; default off.
- **Persisting dry-run UI state across sessions.** 10-CONTEXT explicitly defers this (D-04 "cleaned on project close"). Do not add IndexedDB / SQLite rows for simulator state.
- **Forking the existing `.story.targets.json` self-healing path.** `run_to_step` MUST run through the same `try_promote_fallback` hook so dry-runs warm the fallback cache (CONTEXT decisions "Integration with Phase 7"). Requires 10-02 to thread `story_path` through.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-step screenshot | New sidecar RPC | Existing `screenshot` RPC (`scripts/playwright-sidecar/server.mjs:320-324`) | Already wired + tested |
| Matched element bbox | Parse DOM in Rust | Existing `elementState` RPC returning `.bbox` (`server.mjs:326-355`) | Sidecar already has the live page — Rust would need a second DOM copy |
| Cursor (x,y) | Track synthetic cursor in Rust | Existing `cursorPosition` RPC (`server.mjs:358-360`) and `driver.current_cursor_position()` trait method (`driver.rs:217`) | Already consumed by `StepSucceeded` (executor.rs:204) — shape `(i32,i32)` |
| CM line decoration | Custom DOM overlays on gutter | `@codemirror/view` `Decoration.line` + `StateField<DecorationSet>` | Native CM6 API; play well with CM's change-mapping |
| Dry-run retention (trim to 5) | New scheduled cleanup task | Inline check on new-dryrun-start: ls + sort-by-mtime + unlink | Matches `.story.snapshots/` pattern |
| Atomic dry-run write | fs::write of in-progress results | Write to `<uuid>/` directly (not `.tmp`+rename) — dry-run uuid is unique per session | Collisions impossible; failed run's dir can remain and be GC'd on next retention pass |
| Author-session pause/resume | New sidecar `pauseStream` | See Design Conflicts — NEEDS 9-04 design update | 9-04 does not currently expose this (09-04-PLAN.md only lists `setViewport`) |

**Key insight:** Every IPC + disk primitive Phase 10 needs is already shipped. The only new Rust is a fork in one function (`run_story`), one Tauri command file, and one TS file for CM decoration. Planner should keep scope tight.

## Runtime State Inventory

**Applies? YES** — Phase 10 changes which process owns an in-flight Chromium session (introduces resumable driver state retention between commands) and writes to a new on-disk folder. Relevant because future phase that teardowns "all author sessions" must also GC our new session-retention map.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `<project>/.story.dryrun/<uuid>/` new dir. Retention=5. `<project>/.story.targets.json` will be mutated by self-healing during dry-runs (by design — D-IntegrationPhase7) | Code creates + cleans; planner adds doc to `.gitignore` template for project folders (verify if `.story.dryrun` should be gitignored — likely yes, matches `.story.snapshots/`) |
| Live service config | Phase 9-04 ephemeral Chromium (separate sidecar child process). Phase 10 never spawns its own — only consumes 9-04's. | None (9-04 owns); Phase 10 must assert presence before step_to calls |
| OS-registered state | **None** — no launchd/Task Scheduler registrations, no persistent IPC sockets | None |
| Secrets/env vars | **None** — no new secrets. No new env vars needed. | None |
| Build artifacts | New Rust module(s) in `crates/automation/src/` and `apps/desktop/src-tauri/src/commands/simulator.rs` → requires `cargo check` after add. tauri-specta will regenerate `packages/shared-types/src/ipc.ts` on dev build. | Nothing manual — standard workflow |

Not found in any other category — verified by Grep.

## Common Pitfalls

### Pitfall 1: Driver state lost between `run_to_step` calls

**What goes wrong:** User clicks "Preview to here" on line 5 → executor launches Chromium → runs 5 steps → emits RunPaused. User clicks line 8 → new `run_to_step(8)` call relaunches Chromium (blank page) and runs 1-8 from scratch. 2× cost per click.

**Why it happens:** `run_story` calls `primary.launch(launch_cfg)` at top (`executor.rs:129`) and does not distinguish fresh-start from resumption.

**How to avoid:** Introduce a session registry (`HashMap<SimulatorSessionId, ResumableSession>`) in `commands/simulator.rs`. `ResumableSession` holds `{ primary, fallback, story, last_ordinal }`. New calls with existing session id skip launch.

**Warning signs:** "Preview to here" latency grows linearly with caret-line distance from previous caret — indicates relaunch.

### Pitfall 2: 9-04 viewport changes mid-dry-run invalidate captured frames

**What goes wrong:** Dry-run captures step 5 at 1280×800, user clicks "Mobile 375×667" in preview panel, subsequent steps captured at 375×667. Timeline shows mismatched resolutions → bbox math inconsistent.

**How to avoid:** Simulator's exclusive lock must FREEZE the viewport switcher UI while a run is in flight. Or: capture viewport dimensions INTO each `StepFrame` and the timeline renders accordingly.

### Pitfall 3: `try_promote_fallback` runs during dry-run — mutates `.story.targets.json` the user didn't ask to mutate

**What goes wrong:** CONTEXT wants this (warms fallback cache). But if the user is running dry-run purely to diagnose WHY their primary is broken, the silent self-healing muddies the signal.

**How to avoid:** (Planner decision): expose `enable_self_healing: bool` on the simulator commands. Default true per CONTEXT. UI toggle in SimulatorTimeline header: "Self-heal on success" checkbox.

### Pitfall 4: Phase 3 Dry-Run event names collide with Phase 10 events on the renderer bus

**What goes wrong:** Both phases use Tauri `Channel<...>` for events, both emit `"Queued" | "Running" | "Pass" | "Fail"` shapes. If developers import the wrong type from `@tauri-apps/api`, subtle typechecks pass but events disappear.

**How to avoid:** Namespace Phase 10 types (`SimulatorEvent`, not `DryRunEvent`). Enforce at tauri-specta layer.

### Pitfall 5: CodeMirror line decoration invalidated by buffer edits mid-run

**What goes wrong:** Dry-run produces 20 frames; user edits line 3 while scrubbing → `ordinalToLine(frame)` returns stale line number.

**How to avoid:** Decoration StateField's `deco = deco.map(tr.changes)` handles position mapping, BUT if the user DELETES the line, the decoration disappears silently. Planner should decide: lock editor as read-only during dry-run execution, OR invalidate the timeline on any buffer edit (force re-run).

## Code Examples

### Example 1: Extending ExecutorEvent (MINOR breaking-change risk)

```rust
// Source: crates/automation/src/events.rs:82-116 — current shape
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutorEvent {
    StoryStarted { /* ... */ },
    SceneEntered { /* ... */ },
    StepStarted { /* ... */ },
    StepAttempt { /* ... */ },
    StepSucceeded { /* ... */ },
    StepFailed { /* ... */ },
    StoryEnded { /* ... */ },
    // NEW:
    RunPaused { ordinal: u32 },
    StepFrameCaptured { ordinal: u32, frame: StepFrame },
}
```

Wire effects:
- Downstream Rust: `commands/automation.rs:27` (`AutomationEvent::from(ExecutorEvent)`) — no change; it serializes to JSON.
- Downstream TS: Any exhaustive `switch(ev.type)` in renderer. Grep: only `hud.tsx` / `recording-view.tsx` consume `AutomationEvent`. Must add default-ignore branches or narrow type by a new IPC surface.

### Example 2: Frame capture at end of succeeded step

```rust
// Source: extending executor.rs:202-217 (StepSucceeded branch)
Ok(()) => {
    succeeded += 1;
    let (cx, cy) = driver.current_cursor_position().await.unwrap_or((0, 0));
    let _ = tx.send(ExecutorEvent::StepSucceeded { /* ... */ }).await;

    if capture_frames {
        // Pre-existing RPCs:
        let shot_path = driver
            .screenshot(&format!("frame-{ordinal}"), frame_dir.as_deref().unwrap())
            .await.ok();
        let bbox = last_resolved_selector
            .as_ref()
            .and_then(|s| driver.element_state(s).ok())      // new trait method; wraps sidecar elementState
            .and_then(|st| st.bbox);
        let frame = StepFrame {
            ordinal,
            screenshot_path: shot_path,
            cursor_xy: (cx, cy),
            matched_selector: last_resolved_selector.map(|s| s.to_string()),
            matched_bbox: bbox,
            duration_ms: cmd_started.elapsed().as_millis() as u64,
        };
        let _ = tx.send(ExecutorEvent::StepFrameCaptured { ordinal, frame }).await;
    }

    if stop_after_ordinal == Some(ordinal) {
        let _ = tx.send(ExecutorEvent::RunPaused { ordinal }).await;
        // persist drivers into session registry — see Pitfall 1
        return Ok(());  // skip StoryEnded; session is resumable
    }
}
```

Needs new trait method `element_state` on `BrowserDriver` to wrap sidecar's existing `elementState` RPC (server.mjs:326). Noop driver: return `None`.

### Example 3: Phase 9-04 author-session lock protocol (NEEDS 9-04 UPDATE)

Phase 10 needs to pause-and-resume the live screencast while executing DSL. Proposed protocol for 9-04 to expose:

```rust
// apps/desktop/src-tauri/src/commands/automation.rs — 9-04 territory
pub async fn pause_author_preview(stream_id: String) -> Result<(), AppError>;
pub async fn resume_author_preview(stream_id: String) -> Result<(), AppError>;
```

At the sidecar level: wraps `client.send('Page.stopScreencast')` / `startScreencast` on the existing CDP session. [CITED: 09-RESEARCH.md lines 112-114 confirms stopScreencast returns immediately and can be resumed with fresh startScreencast.]

**This surface does not exist in 09-04-PLAN.md** — flagged in Design Conflicts.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Phase 3 `intelligence::dryrun::run` against `StubBrowserDriver` | Phase 10 `Executor::run_to_step` against the 9-04 author session | This phase | Phase 3 UI becomes a thin wrapper on Phase 10 infrastructure; `StubBrowserDriver` deprecated |
| `DryRunEvent` (6-variant union) | `SimulatorEvent` (adds `FrameCaptured`, `RunPaused`) | This phase | Phase 3 UI migrates or stays on old surface behind feature flag |

**Deprecated/outdated:**
- `crates/intelligence/src/dryrun/trait_stub.rs` — the `phase1-wired` feature gate never flipped; the stub is the only path in production. Phase 10 should either (a) flip the gate by pointing at `automation::BrowserDriver`, or (b) delete the module outright. (b) is simpler and aligns with "one codepath per CONTEXT D-03.")

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Phase 9-04 shipped (`start_author_preview`, multi-stream sidecar, setViewport) | Simulator session uses author browser | ✗ (plan exists, not implemented — grepped 2026-04-18) | — | **BLOCKING** — Phase 10 cannot ship until 9-04 ships |
| Phase 9-04 + `pause_author_preview`/`resume_author_preview` RPCs | Mutual exclusion with Live Preview | ✗ (not in 09-04-PLAN.md) | — | Add to 9-04 before Phase 10 plans start — see Design Conflicts |
| Phase 7-04c `.story.targets.json` self-healing | Dry-run warms fallback cache | ✓ (shipped) | `executor.rs:423-500` | — |
| Phase 7-04b `@id=<uuidv7>` step stamping | Required so self-healing knows which step's targets to promote | ✓ (shipped) | `Command.step_id()` via `cmd.step_id()` | — |
| CodeMirror 6 `@codemirror/view`, `@codemirror/state` | Line decoration | ✓ | bundled via `@uiw/react-codemirror` 4.25.x | — |
| Playwright sidecar `screenshot`, `elementState`, `cursorPosition` RPCs | StepFrame capture | ✓ | server.mjs:320, 326, 358 | — |
| `BrowserDriver::element_state` Rust trait method | Surfacing bbox to Rust | ✗ (NEW) | — | Add to `crates/automation/src/driver.rs` — 1 method, parallel to `current_cursor_position` |

**Missing dependencies with no fallback:**
- Phase 9-04 implementation (blocking). Planner must confirm 9-04 ship date before starting Phase 10-02/10-03.

**Missing dependencies with fallback:**
- `pause_author_preview`/`resume_author_preview` — fallback is "accept brief double-render of Chromium by Live Preview canvas while dry-run runs"; UX acceptable for MVP.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework (Rust) | `cargo test` / `cargo nextest` (existing) |
| Framework (TS) | Vitest 2.x (existing) |
| Config file | `crates/automation/Cargo.toml`, `apps/desktop/vitest.config.ts` (existing) |
| Quick run command | `cargo test -p automation run_to_step && pnpm --filter desktop test -- simulator` |
| Full suite command | `cargo test --workspace && pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PHASE-10.1 | `run_to_step(n)` stops at ordinal n | unit | `cargo test -p automation run_to_step_stops_at_ordinal` | ❌ Wave 0 |
| PHASE-10.1 | resumable: run_to_step(3) then run_to_step(5) does not relaunch | integration | `cargo test -p automation --test simulator_resume -- --ignored` (needs real sidecar) | ❌ Wave 0 |
| PHASE-10.2 | StepFrame captured with screenshot path + bbox + cursor | unit | `cargo test -p automation step_frame_capture_populates_all_fields` (uses NoopDriver extended) | ❌ Wave 0 |
| PHASE-10.3 | caret→ordinal mapping from AST span | unit (TS) | `pnpm --filter desktop test -- caretToOrdinal` | ❌ Wave 0 |
| PHASE-10.4 | retention keeps last 5 dry-run dirs | unit | `cargo test -p automation dryrun_retention_trim` | ❌ Wave 0 |
| PHASE-10.5 | CM decoration highlights correct line when frame scrubbed | component | `pnpm --filter desktop test -- SimulatorTimeline` with `@testing-library/react` | ❌ Wave 0 |
| PHASE-10.6 | Self-healing still runs on primary-miss during dry-run | integration | reuses `crates/automation/tests/self_healing.rs` with `stop_after_ordinal` set | ✓ (fixture exists; add variant) |
| PHASE-10.7 | Live Preview pauses during dry-run, resumes after | E2E (manual or WDIO) | human-verify; `10-03-SMOKE.md` | ❌ Wave 0 |
| PHASE-10.8 | Recording session untouched | unit | `cargo test -p automation recording_uses_distinct_driver_pair` | ✓ (recording-side coverage exists from Phase 5; add assertion) |

### Sampling Rate

- **Per task commit:** `cargo test -p automation` + `pnpm --filter desktop test -- editor/simulator`
- **Per wave merge:** `cargo test --workspace && pnpm test`
- **Phase gate:** Full suite green + `10-03-SMOKE.md` operator checklist

### Wave 0 Gaps

- [ ] `crates/automation/tests/simulator_run_to_step.rs` — covers PHASE-10.1, .2
- [ ] `crates/automation/tests/simulator_resume.rs` (`#[ignore]` — real sidecar) — covers PHASE-10.1 resume
- [ ] `apps/desktop/src/features/editor/simulator-decoration.test.ts` — covers PHASE-10.5
- [ ] `apps/desktop/src/features/editor/SimulatorTimeline.test.tsx` — covers PHASE-10.5 UI
- [ ] `apps/desktop/src/features/editor/simulatorStore.test.ts` — covers state transitions
- [ ] No new framework install — existing infra covers all cases.

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A — local-only feature |
| V3 Session Management | no | N/A |
| V4 Access Control | no | N/A |
| V5 Input Validation | yes | DSL parsed via `story_parser::parse` already (canonical). Ordinal param validated: `n <= total_steps` |
| V6 Cryptography | no | N/A |

### Known Threat Patterns for Tauri + Playwright sidecar

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malicious DSL causes sidecar to exfiltrate local files via `screenshot({path: "/etc/passwd"})` | Tampering | `screenshot_dir` param restricted to `project_dir/.story.dryrun/<uuid>/` — enforce with `Path::strip_prefix` check before passing to sidecar. Pattern shipped for Phase 1 recording; reuse. |
| Path traversal in `<uuid>` directory | Tampering | Use `uuid::Uuid::new_v4().to_string()` (hyphen-separated hex, no slashes) — inherently safe |
| Resource exhaustion: user clicks "Preview to here" repeatedly, spawning unbounded frame captures | DoS (self) | Coalesce: new call cancels in-flight run via `RunControl` before starting (`control.rs:22-29` already supports pause; add `cancel` flag or reuse by tearing down session) |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 9-04 will expose `stream_id`-keyed sidecar such that Phase 10 can open a second RPC channel against the same ephemeral browser session | Architecture, Env Availability | Medium — if 9-04 ends up with a single global stream, Phase 10 must do its own Playwright spawn, contradicting CONTEXT D-01 |
| A2 | 9-04's "author-time Playwright session" exposes the Page/Context handle to Rust in a way that lets Phase 10 call `Executor::run_*` against it | Architecture | High — if 9-04 keeps the session private to its own sidecar RPC, Phase 10 needs a new "exec verb on author page" sidecar RPC surface. Planner must coordinate with 9-04 design. |
| A3 | Phase 9-04 will add pause/resume on the screencast to coexist with dry-run | Pitfall 2, Env Availability | Medium — fallback is re-render overhead (acceptable); but UX jitter |
| A4 | `driver.screenshot()` PNG output path format is compatible with `tauri::convertFileSrc` for rendering in `<img>` / canvas | UI | Low — already proven: `.story.snapshots/` uses same pattern (07-05) |
| A5 | `elementState.bbox` from sidecar is the viewport-relative bbox suitable for overlaying on the screenshot at the same moment | Architecture | Low — sidecar `getBoundingClientRect()` is viewport-relative; screenshot with `fullPage: false` is also viewport-relative; alignment is natural |
| A6 | Self-healing's `try_promote_fallback` invocation during dry-run is desired behavior | CONTEXT Integration | Low — CONTEXT explicitly says yes; Pitfall 3 flags a UX opt-out as planner discretion |
| A7 | Retention policy "last 5 dry-runs" is measured by mtime of the `<uuid>/` dir, not by explicit creation-order log | Don't Hand-Roll | Low — mtime works cross-platform for freshly-created dirs |

## Design Conflicts Discovered

These surface conflicts between 10-CONTEXT.md must_haves and shipped code. MUST be resolved in /gsd-discuss-phase 10 before planning begins — they change the scope.

### Conflict 1: "DryRunPanel.tsx existing placeholder" is NOT a placeholder

**CONTEXT claim** (10-CONTEXT.md plan 10-03): "`DryRunPanel.tsx` existing placeholder becomes the timeline."

**Reality:** `apps/desktop/src/features/editor/DryRunPanel.tsx` is a shipped Phase 3 feature (plan 03-18) — a working UI over `intelligence::dryrun` → `dryrun_start` Tauri command → `StubBrowserDriver`. It has tests, a Zustand store (`dryRunStore.ts`), a row component (`DryRunStepRow.tsx`), a hook (`useDryRun.ts`), and i18n strings (Vietnamese "Chạy thử").

**Impact:** "Becomes the timeline" implies in-place replacement, which either (a) breaks the Phase 3 UX contract or (b) means refactoring a shipped feature without clear spec. Per CLAUDE.md "Plan Before Big Changes" rule, this needs explicit decision.

**Proposed resolution (for discuss-phase):** Three options —
- **(A) Rename Phase 10 surface to "simulator":** New `SimulatorTimeline.tsx` + `simulatorStore.ts` + `simulator_*` commands. Deprecate Phase 3 DryRunPanel behind a feature flag (removed in a later phase). Recommended per Primary Recommendation above.
- **(B) Merge:** Extend `DryRunPanel.tsx` to add timeline scrubber; keep old "flat list" view as fallback. Risks cluttering the UI.
- **(C) Replace:** Delete Phase 3 dry-run entirely (`commands/dryrun.rs`, `intelligence/src/dryrun/*`, `useDryRun.ts`) and rebuild on Phase 10 foundation. Cleanest long-term, largest blast radius (Phase 3 tests + UI-spec + Vietnamese strings all re-home).

Recommendation for planner: **(A)** short-term, schedule **(C)** as a cleanup task.

### Conflict 2: "Extend `Executor::run`" but the existing Dry-Run runs `intelligence::dryrun::run`

**CONTEXT claim** (D-02): extend `crates/automation/src/executor.rs`.

**Reality:** That IS the right call — `automation::Executor` is the canonical DSL-execution engine with self-healing, capability routing, auto-wait, etc. The currently-shipped Phase 3 "Dry-Run" bypasses it entirely via `intelligence::dryrun::run` + a stub. So CONTEXT is right but implicitly mandates replacing Phase 3's orchestrator.

**Impact:** Planner must include an explicit task to decide what happens to `intelligence::dryrun::*` — keep, deprecate, or delete.

**Proposed resolution:** Delete `crates/intelligence/src/dryrun/` and `apps/desktop/src-tauri/src/commands/dryrun.rs` after the Phase 10 simulator surface ships and the UI has migrated. Add as an explicit plan task (say 10-04 "migrate Phase 3 Dry-Run to Phase 10 simulator, remove legacy surface").

### Conflict 3: 9-04 lacks the RPCs Phase 10 needs

**CONTEXT claim** (D-01): reuse 9-04's author-time session.

**Reality:** 09-04-PLAN.md lists RPCs `start_author_preview`, `stop_author_preview`, `setViewport`, and `startPreviewStream(streamId)`. It does NOT expose:
- A way to run Playwright verbs against the author page (click, type, etc.) — 9-04 only launches and views.
- Pause/resume on the screencast for exclusive-lock concurrency.
- A handle from Rust to the `Page` object so `Executor::run_with_story_path` can dispatch through it.

**Impact:** Phase 10 cannot simply call 9-04 commands — 9-04 needs to either expose its Page to the automation driver, OR Phase 10 must add a "simulator runs verbs against the author session" sidecar-side handoff.

**Proposed resolution (discuss-phase):**
- **Before Phase 10 starts:** Add to 9-04's must_haves:
  - Expose the author-session's `Page` handle such that `PlaywrightSidecarDriver` can be constructed against a `{sidecarUrl, streamId}` pair (not just `.launch()`).
  - Add `pauseStream(streamId)` / `resumeStream(streamId)` RPCs on the sidecar.
- **If 9-04 refuses:** Phase 10 gains its OWN sidecar spawn — contradicting D-01 "no third Chromium instance". Would need CONTEXT revision.

### Conflict 4: `ExecutorEvent` adds variant — downstream `AutomationEvent` JSON is permissive but TS exhaustive switches may break silently

**CONTEXT claim** (10-01 plan): add `ExecutorEvent::RunPaused`.

**Reality:** Rust-side serialization (`commands/automation.rs:27-33`) wraps ExecutorEvent as JSON-stringified in `AutomationEvent { json: String }`. No specta coupling. But on the TS side, the consumer re-parses via `JSON.parse(ev.json)`. Any `switch(ev.type)` without `default:` breaks on new variants.

**Impact:** Grep for `switch` over ExecutorEvent types in `apps/desktop/src/`:
- `hud.tsx`, `recording-view.tsx` handle StepStarted/StepSucceeded/StepFailed/etc. Not a design conflict, but an execution-time gotcha.

**Proposed resolution:** Add `StepFrameCaptured` + `RunPaused` to any discriminated-union TS type exported for ExecutorEvent and update switches defensively. Confirm no-op for recording-view (recording path never emits them because `capture_frames=false`).

## Open Questions

1. **Where does the session registry live? (`commands/simulator.rs` vs. `crates/automation::session_registry`)**
   - What we know: Must live in the Tauri host (needs `AppHandle` for streaming, Chromium child lifetime).
   - What's unclear: Whether the executor crate grows a `session()` API or the Tauri command owns it outright.
   - Recommendation: Put in `apps/desktop/src-tauri/src/commands/simulator.rs`. Crate-level API unnecessary.

2. **Who owns dry-run disk cleanup on project close?**
   - What we know: CONTEXT D-04 says "cleaned on project close."
   - What's unclear: Existing `projects::open_project`/`close_project` commands do not GC sibling dirs.
   - Recommendation: Hook into `project_close` (if it exists) or trim-to-5 is the only cleanup (simple + correct).

3. **Should CodeMirror lock the buffer while dry-run is in flight?**
   - What we know: Edits invalidate decorations (Pitfall 5).
   - What's unclear: UX preference — read-only is safer but surprising.
   - Recommendation: Show a banner "Dry-run in progress — edits paused" and set `EditorState.readOnly` for the duration. Allow scrub.

4. **Is `StepFrame.matched_bbox` null when command is `Navigate` / `Wait` / `Screenshot` (no target)?**
   - What we know: Those commands have no `SelectorOrText`.
   - Recommendation: `Option<Bbox>` on `StepFrame`; timeline renders "no selector" badge.

## Sources

### Primary (HIGH confidence)

- `crates/automation/src/executor.rs` (lines 38-267, 269-404, 423-500) — canonical executor loop, self-healing hook, control checkpoint
- `crates/automation/src/events.rs` (lines 82-116) — ExecutorEvent enum
- `crates/automation/src/control.rs` (lines 9-46) — RunControl pause/resume primitive
- `crates/automation/src/driver.rs:217` — `current_cursor_position` trait method already exists
- `scripts/playwright-sidecar/server.mjs:320-360` — screenshot, elementState, cursorPosition RPCs
- `apps/desktop/src-tauri/src/commands/dryrun.rs` (lines 1-210) — shipped Phase 3 stub dry-run
- `apps/desktop/src/features/editor/DryRunPanel.tsx` (lines 1-225) — shipped Phase 3 UI
- `apps/desktop/src/features/editor/dryRunStore.ts` (lines 1-60) — shipped Phase 3 store
- `.planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-04-PLAN.md` (lines 22-75) — Phase 9-04 spec (not yet implemented)
- `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04c-PLAN.md` — self-healing protocol
- `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-05-PLAN.md:49` — `.story.snapshots/` convention precedent

### Secondary (MEDIUM confidence)

- CodeMirror 6 Decoration API — https://codemirror.net/docs/ref/#view.Decoration.line [CITED]
- Chrome DevTools Protocol Page.startScreencast / stopScreencast — https://chromedevtools.github.io/devtools-protocol/tot/Page/ [CITED via 09-RESEARCH cross-verification]

### Tertiary (LOW confidence)

- None — all claims in this document cite a file path + line range or an already-cited doc in 09-RESEARCH.

## Metadata

**Confidence breakdown:**
- Executor extension: HIGH — shipped code exists, change is a parameter thread
- Storage + retention: HIGH — matches shipped conventions
- CodeMirror decoration: HIGH — standard CM6 API; no repo precedent but well-documented
- 9-04 coordination: MEDIUM — 9-04 not implemented; coordination surface speculative
- Phase 3 deprecation: MEDIUM — requires user decision in discuss-phase
- Timeline UX details: MEDIUM — CONTEXT underspecifies thumbnail rendering, scrub sensitivity

**Research date:** 2026-04-18
**Valid until:** 2026-05-18 (30 days, stable stack)
