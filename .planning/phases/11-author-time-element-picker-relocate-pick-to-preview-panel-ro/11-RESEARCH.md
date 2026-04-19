---
phase: 11
type: research
status: ready-for-planning
date: 2026-04-19
---

# Phase 11: Author-time element picker — Research

**Researched:** 2026-04-19
**Domain:** Desktop editor UX + Tauri/sidecar concurrency + automation executor plumbing
**Confidence:** HIGH on existing surfaces (Phase 7/10 code read directly); MEDIUM on Phase 9-04 primitives (plans read; implementation not yet landed per STATE).

## Summary

Phase 11 is a *relocation-and-policy* phase, not a from-scratch build. Every load-bearing primitive already exists in the tree:

- Phase 7's picker core — overlay IIFE, ranked generator, `editorController` singleton, `picker_stamp_step_id`, `targets_store.atomic_write`, `pickElement.{start,cancel,isActive}` sidecar RPCs, `picker.rs` Tauri module — is production-shipped and ready for reuse.
- Phase 10 plans (10-01..10-03) will ship: `Executor::run_story(self_heal: bool, ...)`, `continue_run`, `RunControl::cancel`, `pub try_promote_fallback`, `StepFrame.match_kind`, the simulator session registry pattern (`tokio::Mutex<HashMap<...>>` keyed by session id).
- Phase 9-04 is **still unimplemented** as of 2026-04-19 (STATE confirms: no `LivePreview`, no `start_author_preview`, no `pauseStream` sidecar RPC yet). Phase 10 D-06 / PHASE-9.8+9.9 are its locked dependencies; Phase 11 rides on the same extensions.

**The work is:**
1. A new `AuthorDriverState` registry module (`apps/desktop/src-tauri/src/author_driver.rs`) that Picker *and* Simulator both lock against, with 5 states per D-16.
2. A new `PreviewPickerButton.tsx` that invokes picker against the author-session `streamId` (not the recorder's `state.page`).
3. Sidecar extension: `pickElement.start` must optionally target the author-context `Page` instead of `state.page`. Today the entry hard-wires `const page = state.page` (server.mjs:681).
4. Executor call-site flip: `launch_automation` passes `self_heal=false` (Phase 10's new param) and surfaces a structured "open in Simulator" error on primary-miss timeout.
5. Deletion: `PickElementButton` mount + import in `recording-view.tsx` (lines 45, 704), plus the test file `pick-element-button.test.tsx`.
6. `navigate`-only replay helper for author-browser warm-up.

**Primary recommendation:** Split into 4 waves — backend registry + sidecar (W1) and executor flip (W1) in parallel; author-browser warm-up replay (W2) depends on W1 for the driver handle; Preview-UI button + deletion (W3) depends on W1 Tauri commands; smoke-test + Phase 7 smoke-runbook rewrite (W4). Do not start Phase 11 plans until Phase 9-04 execute has landed `attach_author_driver` + `pause_author_preview`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `AuthorDriverState` lock (5-state FSM) | API/Backend (Tauri host) | — | Must coordinate across two command modules (picker, simulator) and the sidecar lifecycle. Only the host has the linearizable view. |
| `PreviewPickerButton` (toolbar + kbd + disabled-state derivation) | Frontend Server / Client (React) | — | UI concerns; subscribes to `AuthorDriverState` transitions via a small Zustand projection or Tauri event stream. |
| Picker-aware `pickElement.start` routing to author `Page` | Sidecar (Playwright Node process) | — | Playwright owns the author-context `Page`. Host cannot inject overlays directly. |
| Self-heal gating (`self_heal=false` on record) | API/Backend (Rust crates::automation via host wiring) | — | Policy enforced at the Executor call site; not UI-visible. |
| Actionable "open in Simulator" error on miss | API/Backend → Client | — | Error shaped in Rust (`AutomationError` variant or string template); UI surfaces as recorder HUD toast + link. |
| `navigate`-only replay warm-up | API/Backend | Sidecar | Rust walks the AST; sidecar executes `page.goto(url)` via existing driver surface. |
| Same-line re-pick (targets.json-only mutation) | API/Backend (`picker_stamp_step_id` idempotent path) | — | Already implemented: returns existing step_id when line is stamped and upserts targets.json atomically. |

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Area 1 — Picker placement, invocation & re-pick**
- **D-01:** Primary entry point is a Preview-panel toolbar button + `Cmd-Shift-P` shortcut. Crosshair icon. No caret-line context menu in v1. New `apps/desktop/src/features/editor/PreviewPickerButton.tsx`, mounted inside `preview-panel.tsx`.
- **D-02:** Pick is enabled whenever the author-session is up, independent of Live Preview toggle. Lazy-start handles dormant case.
- **D-03:** During an active pick, the author-session screencast is paused. `pauseStream(streamId)` at start, `resumeStream(streamId)` on resolve/cancel.
- **D-04:** Same-line re-pick updates `targets.json` only; `.story` source bytes are never rewritten by a re-pick. Demote prior primary to `fallbacks[0]`. First pick on unstamped line → `picker_stamp_step_id` idempotent stamp.

**Area 2 — Record-path read-only policy & Phase 7 migration**
- **D-05:** `PickElementButton` and picking banner are removed from the recording toolbar.
- **D-06:** Recording runs pass `self_heal=false` to `Executor::run_story`. Primary-miss surfaces actionable "open Simulator + Promote" error. No `.story.targets.json` mutation on record.
- **D-07:** No pending-promotions buffer (`.story.targets.pending.json`). Simulator + `simulator_promote_fallback` is the single healing surface.
- **D-08:** Phase 7 core modules reused verbatim; only driver routing swapped.

**Area 3 — Author-session lifecycle for picking**
- **D-09:** Lazy-start on first Pick when dormant. Button enters `starting…` state.
- **D-10:** Warm-up replays only `navigate` verbs from scene start up to cursor. Default to `meta.app` if none.
- **D-11:** Author-session idle-timeout is 10 minutes (sidecar concern, aligned with 9-04).
- **D-12:** Picker acquires driver via `pauseStream` → CDP control → `resumeStream`. Resolve AND cancel guarantee `resumeStream`.

**Area 4 — Concurrency with simulator runs**
- **D-13:** Pick disabled while simulator in `Running`. Tooltip: "Simulator running — cancel to pick".
- **D-14:** Pick allowed while simulator in `RunPaused`. Transition `Paused → Picking{resume_to=Paused}`; on exit → `Paused`.
- **D-15:** Simulator-start blocked while Pick active. Tooltip: "Picking — press Esc".
- **D-16:** Shared `AuthorDriverState` registry in `apps/desktop/src-tauri/src/author_driver.rs`:
  ```rust
  enum AuthorDriverState {
      Idle,
      LivePreview { stream_id: StreamId },
      Picking { stream_id: StreamId, resume_to: Option<Box<AuthorDriverState>> },
      SimulatorRunning { session: SimulatorSessionId },
      SimulatorPaused { session: SimulatorSessionId },
  }
  ```

### Claude's Discretion
- Tauri command name for author-session picker (e.g., `picker_start_author` vs `author_pick_start`)
- UI copy for disabled tooltips
- Whether `AuthorDriverState` is exposed as `Channel<T>` to frontend, or derived from Simulator/Preview event streams
- `starting…` loading/error UI
- Keyboard hint placement (inline vs hover)
- Telemetry hooks (opt-in only per PROJECT.md)
- Warm-up navigate error handling (e.g., 404 on replay)

### Deferred Ideas (OUT OF SCOPE)
- Caret-line context menu ("Pick element here" / "Re-pick this step")
- Full-replay warm-up (click/type/hover) — users run Simulator "Preview to here" first
- Tauri `Channel<AuthorDriverState>` stream to frontend (planner's call)
- Pending-promotions buffer + review drawer (explicitly rejected)
- Persistent author-session across project switches
- Cross-frame / cross-origin picker (Phase 7 limitation stands)
- "Pick multiple" batch mode

## Phase Requirements

No `PHASE-11.*` requirement IDs exist in `.planning/REQUIREMENTS.md` at the time of research. ROADMAP.md added Phase 11 on 2026-04-19 without minting requirement IDs. The canonical project requirements this phase touches (already shipped, reaffirmed as invariants):

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTO-05 (existing) | On step failure, executor reports failure point + attempted selectors + screenshot | Phase 11 D-06: recording path emits this AS-IS, without silent self-healing |
| AUTO-03 (existing) | Smart selector engine with ranked candidates | Phase 11 preserves Phase 7-03's ranked generator unchanged |

**Recommendation to planner:** mint `PHASE-11.1` through `PHASE-11.5` during plan-phase covering (1) AuthorDriverState registry, (2) Preview-panel button + shortcut, (3) sidecar picker author-context routing, (4) record-path self_heal=false + actionable error, (5) recorder-side picker deletion + test migration. Surface to user in plan-check review.

## Standard Stack

Phase 11 adds zero new libraries. Every primitive is either already in the tree or locked by Phase 10.

### Core (all already in Cargo.lock / package.json)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `tokio` (`sync::Mutex`) | 1.40+ | `AuthorDriverState` lock | Same async mutex Phase 10 uses for `SimulatorRegistry`; async-compatible with sidecar RPC calls |
| `tauri` State mgmt | 2.8.x | `.manage(AuthorDriverRegistry::default())` in `lib.rs` | Precedent: Phase 10's `SimulatorRegistry` (10-02 Task 1) |
| `tauri::ipc::Channel<T>` | 2.x | Optional state-transition stream to frontend (planner's call) | Precedent: `simulator_start`'s `channel: Channel<SimulatorEvent>` |
| `zustand` | 5.x | `authorDriverStore` OR re-use `simulatorStore` + `editorStore` projections | Matches Phase 10 pattern |
| `@codemirror/state` | 6.x | Read cursor line number from active view | Already used by `editorController` for insertAtCursor |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `uuid` v7 (`Uuid::now_v7`) | 1.x | Step-id stamping on first-pick-on-line (reuse `picker_stamp_step_id`) | Existing `picker.rs` flow unchanged |
| `lucide-react` (`Crosshair`, `Loader2`) | 0.460+ | Icons for the new button + loading state | Matches shipped PickElementButton |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `tokio::sync::Mutex` for AuthorDriverState | `std::sync::Mutex` + `tokio::sync::Notify` | Rejected — we need `.lock().await` since sidecar RPCs are awaited while deciding transitions. Phase 10 registry already uses tokio Mutex; consistency wins. |
| Separate Zustand `authorDriverStore` | Derive from `simulatorStore.runState` + new `livePreviewStore.streamId` | CONTEXT.md D-16 Discretion explicitly permits either. **Recommend deriving** — avoids a parallel source of truth that can skew from the host registry; host is the single authority per D-16. |
| Tauri `Channel<AuthorDriverState>` | Poll via `author_driver_state()` command + event-driven invalidation | `Channel<T>` fits Phase 10 precedent; polling is cheaper but skews. **Recommend `Channel<T>`** if implementation cost is low. |

**Verification:** No version changes required. All versions align with CLAUDE.md committed stack.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────┐          ┌────────────────────────────────┐
│  Editor (React)             │          │  Recorder (React) — RO path    │
│                             │          │                                │
│  preview-panel.tsx          │          │  recording-view.tsx            │
│    └─ PreviewPickerButton ──┼─┐        │    (NO picker UI after Phase 11│
│    (Cmd-Shift-P kbd)        │ │        │     D-05 deletion)             │
└─────────────────────────────┘ │        └────────────────┬───────────────┘
                                │                         │
                                ▼                         ▼
                         invoke("author_pick_start"   invoke("launch_automation"
                         stream_id, cursor_line)      self_heal=false — D-06)
                                │                         │
┌───────────────────────────────┴─────────────────────────┴───────────────┐
│  Tauri host (Rust)                                                      │
│                                                                         │
│  author_driver.rs  ◄──── shared lock ─────┐                             │
│   Mutex<AuthorDriverState> (D-16)         │                             │
│      ▲                                    │                             │
│      │ guard+transition                   │                             │
│      │                                    │                             │
│  commands/picker.rs                    commands/simulator.rs            │
│   • picker_start_author               commands/automation.rs (record)   │
│     1. acquire lock                    • launch_automation              │
│     2. state -> Picking{resume_to}       → Executor::run_story          │
│     3. replay navigate verbs             (self_heal=false,              │
│     4. pause_author_preview              capture_frames=false)          │
│     5. sidecar pickElement.start                                        │
│     6. resume_author_preview                                            │
│     7. restore resume_to state                                          │
│     8. upsert .story.targets.json                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼  JSON-RPC
┌─────────────────────────────────────────────────────────────────────────┐
│  Playwright sidecar (Node)                                              │
│   • state.authorContext (09-04)                                         │
│   • pickElement.start({ streamId? }) ── NEW: accept streamId, route to  │
│     state.authorPage instead of state.page                              │
│   • pauseStream/resumeStream (9-04 PHASE-9.9)                           │
│   • Overlay IIFE + ranked generator (unchanged)                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| File | Role |
|------|------|
| `apps/desktop/src-tauri/src/author_driver.rs` (NEW) | `AuthorDriverState` enum + `AuthorDriverRegistry { state: Mutex<AuthorDriverState> }` + transition helpers |
| `apps/desktop/src-tauri/src/commands/picker.rs` (EXTEND) | Add `picker_start_author(stream_id, cursor_line)` — different from `picker_start`; acquires author_driver lock |
| `apps/desktop/src-tauri/src/commands/simulator.rs` (COORDINATE) | `simulator_start` + `simulator_step_to` acquire the SAME `AuthorDriverRegistry` lock and transition through `SimulatorRunning` / `SimulatorPaused` |
| `apps/desktop/src-tauri/src/commands/automation.rs` (MODIFY) | Call `Executor::run_story(..., self_heal=false, ...)` in the recording entry path |
| `crates/automation/src/executor.rs` | `run_story` signature already extended by Phase 10-01 Task 2; no further changes |
| `apps/desktop/src/features/editor/PreviewPickerButton.tsx` (NEW) | Button + kbd shortcut; derives disabled-state from `AuthorDriverState` stream (or projection) |
| `apps/desktop/src/features/editor/preview-panel.tsx` (EXTEND) | Mount `<PreviewPickerButton />` in toolbar, left of viewport controls |
| `apps/desktop/src/features/recorder/pick-element-button.tsx` (DELETE) | |
| `apps/desktop/src/features/recorder/pick-element-button.test.tsx` (DELETE/REWRITE) | Rewrite as `PreviewPickerButton.test.tsx` under editor |
| `apps/desktop/src/features/recorder/recording-view.tsx` (EDIT) | Remove imports at line 45 + mount at line 704 + the banner block (lines 701–710) |
| `scripts/playwright-sidecar/server.mjs` (EXTEND) | `pickElement.start` accepts optional `streamId`; routes to `state.authorContext`-owned Page when provided |

### Recommended Project Structure (additions only)

```
apps/desktop/src-tauri/src/
├── author_driver.rs        # NEW — shared state registry (D-16)
├── commands/
│   ├── picker.rs           # EXTEND — new picker_start_author command
│   └── automation.rs       # EDIT — self_heal=false; error formatting
└── lib.rs                  # EDIT — .manage(AuthorDriverRegistry::default())

apps/desktop/src/features/editor/
├── PreviewPickerButton.tsx         # NEW
└── PreviewPickerButton.test.tsx    # NEW (migrate from recorder/)

apps/desktop/src/ipc/
└── picker.ts               # EXTEND — add pickElementAuthor({streamId, cursorLine})

crates/automation/src/
└── (unchanged — Phase 10-01 already ships self_heal: bool)
```

### Pattern 1: AuthorDriverState lock discipline

**What:** Never hold the Mutex guard across an awaited sidecar RPC that could fail indefinitely. Instead: scope the lock to decide + mutate state, drop the guard, make the async call, re-acquire on return to finalize.

**When to use:** Every Tauri command that transitions `AuthorDriverState` AND calls the sidecar.

**Example (recommended pattern for `picker_start_author`):**
```rust
// Source: pattern derived from apps/desktop/src-tauri/src/commands/picker.rs
// and apps/desktop/src-tauri/src/commands/author_snapshot.rs:131-144 (existing precedent).

pub async fn picker_start_author(
    state: State<'_, AppState>,
    registry: State<'_, AuthorDriverRegistry>,
    stream_id: String,
    cursor_line: u32,
) -> Result<PickElementResponseDto, AppError> {
    // 1. Lock scope: decide + record intent, clone what we need, release.
    let prior_state = {
        let mut g = registry.state.lock().await;
        match &*g {
            AuthorDriverState::SimulatorRunning { .. } => {
                return Err(AppError::Automation("Simulator running — cancel to pick".into()));
            }
            AuthorDriverState::Picking { .. } => {
                return Err(AppError::Automation("Pick already active".into()));
            }
            _ => {}
        }
        let prior = std::mem::replace(&mut *g, AuthorDriverState::Idle); // placeholder
        *g = AuthorDriverState::Picking {
            stream_id: stream_id.clone(),
            resume_to: match &prior {
                AuthorDriverState::SimulatorPaused { .. } => Some(Box::new(prior.clone())),
                _ => None,
            },
        };
        prior
    };

    // 2. RAII guard for resume-on-error/cancel/panic.
    let _resume_guard = PickerResumeGuard {
        registry: registry.inner().clone(),
        stream_id: stream_id.clone(),
        prior_state: Some(prior_state),
    };

    // 3. Long-running awaited work: replay navigate, pause stream, run picker.
    replay_navigate_verbs(&state, &stream_id, cursor_line).await?;
    crate::commands::automation::pause_author_preview(stream_id.clone()).await?;

    let driver = state.playwright_driver.lock().await.as_ref().cloned()
        .ok_or_else(|| AppError::Automation("Playwright sidecar not launched".into()))?;
    let d = driver.lock().await;
    let r = d.pick_element_start_author(&stream_id, 60_000).await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    drop(d);

    crate::commands::automation::resume_author_preview(stream_id.clone()).await?;
    // 4. _resume_guard's Drop restores state — but on success path we want to land in
    //    the prior state (LivePreview/SimulatorPaused), so just let Drop do it.

    Ok(r.into())
}

struct PickerResumeGuard {
    registry: Arc<AuthorDriverRegistry>,
    stream_id: String,
    prior_state: Option<AuthorDriverState>,
}

impl Drop for PickerResumeGuard {
    fn drop(&mut self) {
        // Best-effort: spawn a detached task because Drop is sync.
        // Resume pauseStream and restore state. Fire-and-forget is acceptable
        // because any leftover PAUSED state is still interactive (no ghost lock).
        if let Some(prior) = self.prior_state.take() {
            let registry = self.registry.clone();
            let stream_id = self.stream_id.clone();
            tokio::spawn(async move {
                let mut g = registry.state.lock().await;
                *g = prior;
                // resume_author_preview is idempotent; call anyway.
                let _ = crate::commands::automation::resume_author_preview(stream_id).await;
            });
        }
    }
}
```

**Why this works:** The Drop impl never holds the Mutex across an await because `tokio::spawn` returns immediately. This is identical to the pattern CLAUDE.md's "No Workarounds" rule endorses: failure paths are designed-in, not papered over.

### Pattern 2: Cursor-line → Command ordinal / navigate-only AST walk

**What:** The editor needs to turn "cursor line N" into (a) the matching command for re-pick and (b) the list of `navigate` verbs that precede line N for warm-up.

**Existing primitives:**
- `Command::meta().line: u32` (ast.rs line 334) — 1-indexed source line per command (already set by parser)
- `Command::step_id() -> Option<Uuid>` (ast.rs line 312) — returns existing stamp or None
- `apps/desktop/src/features/editor/simulator-decoration.ts` (Phase 10-03) will export `caretLineToOrdinal(ast, line)` — **reuse this helper**

**navigate-only replay helper (NEW):**
```rust
// Source: to be added under apps/desktop/src-tauri/src/author_driver.rs or a helper module.
async fn replay_navigate_verbs(
    state: &AppState,
    stream_id: &str,
    cursor_line: u32,
) -> Result<(), AppError> {
    let story_src = read_open_story(state)?;
    let story = story_parser::parse(&story_src).ast
        .ok_or_else(|| AppError::Automation("story parse failed".into()))?;
    let mut nav_urls = Vec::<String>::new();
    'walk: for scene in &story.scenes {
        for cmd in &scene.commands {
            if cmd.meta().line > cursor_line { break 'walk; }
            if let story_parser::Command::Navigate { url, .. } = cmd {
                nav_urls.push(url.clone());
            }
        }
    }
    if nav_urls.is_empty() {
        if let Some(app_url) = story.meta.app.clone() { nav_urls.push(app_url); }
    }
    // Execute against the author-context Page via sidecar `author.goto(streamId, url)`
    // (extend 09-04's surface — see Open Questions).
    for url in nav_urls {
        sidecar_author_goto(stream_id, &url).await?;
    }
    Ok(())
}
```

**UX on warm-up failure:** Don't fail the pick. Log a diagnostic, emit a toast ("Couldn't warm up context; picking on whatever page loaded"), continue to `pickElement.start`. Rationale: the user already committed to picking; fallback to "pick whatever's there" is more useful than a hard abort.

### Pattern 3: Record-path error shaping

**What:** On `wait_actionable` timeout during a recording run (self_heal=false), return an `AutomationError` the UI can turn into a toast with a "Open in Simulator" link.

**Existing error surface:** `AutomationError` already carries attempts + screenshot_path. Recorder HUD (`apps/desktop/src/features/recorder/hud.tsx`) already renders `StepFailed` events with error_message.

**Recommendation:** Append to the error message template in the execution path OR add a new `AutomationError::PrimaryMissNoHeal { step_ordinal, story_path, step_id }` variant for typed handling.

**Template (from CONTEXT Specific Ideas):**
```
Step {N}: "{verb} {target}" could not match any element.
Self-healing is disabled during recording. Open this story in Simulator,
use "Promote to fallback" on step {N}, then try again.
```

**Where to shape:** In `executor.rs::run_command`, when `wait_actionable_or_heal!` returns `Err(primary_err)` AND `self_heal=false`. Phase 10-01 Task 2 already adds this gate; Phase 11 extends the error string.

### Anti-Patterns to Avoid

- **Holding `AuthorDriverRegistry.state` lock across `pauseStream`/`resumeStream` awaits.** Will deadlock if sidecar RPC is slow AND another command (simulator_cancel) tries to transition. Use the scope-drop-reacquire pattern above.
- **Stamping step_ids from the record path.** Phase 11 D-06 forbids record-path mutations; audit `launch_automation` + any Executor hooks and confirm `picker_stamp_step_id` is reachable ONLY from Pick UI.
- **Forking picker.rs into picker_record.rs + picker_author.rs.** D-08 says reuse the single module; just add a new command that takes `stream_id`.
- **Putting AuthorDriverState in Zustand.** The host is the authority; renderer derives. Putting it in Zustand invites two sources of truth (lived through this with simulator in Phase 10 research).
- **Using `Mutex<Option<X>>` for the state.** `Option<AuthorDriverState>` vs `AuthorDriverState::Idle` are isomorphic; prefer the enum — self-documenting and exhaustive-match-enforced.
- **`expect()` / `.unwrap()` in the resume path.** Must always call `resumeStream` on cancel, panic, error. The RAII guard pattern handles this.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| State machine for AuthorDriverState | Hand-rolled `String` status field + if/else | `enum AuthorDriverState` with exhaustive matching | Rust compiler enforces all transitions are handled |
| Atomic resume-on-cancel | try/finally / deferred macro | RAII `Drop` guard pattern | Works across panics; idiomatic Rust |
| Keyboard shortcut handling | Global `document.addEventListener('keydown')` | CodeMirror keymap extension + shadcn `useHotkeys` pattern | Phase 10-03 Task 4a already registers Cmd-. in codemirror-setup.ts — extend with Cmd-Shift-P |
| Cursor-line → ordinal mapping | Re-parse source on every Cmd-Shift-P | Reuse `caretLineToOrdinal(ast, line)` from Phase 10-03 Task 2 | Already shipped |
| Atomic `targets.json` rewrite | Write + rename ourselves | `automation::targets_store::atomic_write` | Already hardened by Phase 7-04c |
| JSON-RPC framing for author picker | New envelope | Existing `pickElement.start` with optional `streamId` param | Avoids duplicate protocol surface |
| UUIDv7 step_id generation | `uuid::Uuid::new_v4()` | Reuse `picker_stamp_step_id` which already uses `Uuid::now_v7()` | Monotonic; existing convention |

**Key insight:** Phase 11 is > 80% re-routing existing surfaces. The biggest temptation is to "redesign the picker" — resist. Only two net-new modules (`author_driver.rs`, `PreviewPickerButton.tsx`) carry net-new logic; everything else is a plumbing change.

## Runtime State Inventory

Phase 11 is primarily a rename-of-routing phase (re-route picker from recorder to author), plus a code-delete phase (PickElementButton from recording-view). Runtime state to audit:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| **Stored data** | `.story.targets.json` files already on disk from Phase 7-04c shipped picker. Schema byte-compatible between record path and author path (same `targets_store::atomic_write`). | **None** — no migration needed. Record path stops writing; author path writes identically. |
| **Live service config** | None — no external service owns per-project picker state. | **None**. |
| **OS-registered state** | None. Picker is not registered with OS; no scheduled tasks, no keychain entries. | **None**. |
| **Secrets / env vars** | None. Picker uses no secrets; `tauri-plugin-keyring` untouched. | **None**. |
| **Build artifacts / installed packages** | Sidecar IIFE is bundled into SEA at build time (picker/overlay/index.ts → esbuild → inlined string). Phase 11 extends server.mjs but does NOT change the overlay. | **Rebuild sidecar SEA** on first Phase 11 build so the new `streamId`-aware `pickElement.start` ships. Planner must include a `pnpm --filter playwright-sidecar build` task. |

**In-memory runtime state at app start:**
- `AuthorDriverState::Idle` is the correct initial value.
- On sidecar reconnect after crash: no persistent state — the lock is host-owned; a fresh process starts Idle.
- Per CONTEXT.md D-02 Discretion on "Persistent author-session across project switches — out of scope": Phase 11 MUST reset `AuthorDriverState` to `Idle` on project switch.

## Common Pitfalls

### Pitfall 1: `pickElement.start` hard-wires `state.page` in the sidecar
**What goes wrong:** Today `scripts/playwright-sidecar/server.mjs:681` does `const page = state.page;`. If Phase 11 invokes the picker while the author-session Page lives under `state.authorContext`, the overlay will be injected into the recorder browser (or nothing, if `state.page` is null).
**Why it happens:** Phase 7-03a assumed a single live page owned by the recorder.
**How to avoid:** Extend `pickElement.start({ streamId?, timeoutMs })`. When `streamId` is present, the sidecar looks up the page in an existing `state.authorPagesByStreamId: Map<StreamId, Page>` (populated by Phase 9-04 `start_author_preview`). When absent, fall back to `state.page` (record path — but per D-05 no caller remains in v1). `framenavigated` listener + `exposeBinding` per-page logic needs to key off the chosen page, not `state.page`.
**Warning signs:** Manual test — open author preview, click Pick, expect overlay on author viewport; if overlay appears on recorder window (or nothing), the routing is wrong.

### Pitfall 2: RAII Drop guard spawning a detached task during shutdown
**What goes wrong:** If the Tauri runtime is shutting down while `PickerResumeGuard::drop` fires, `tokio::spawn` panics ("no reactor running"). The app terminates uncleanly.
**Why it happens:** Drop runs on unwind; shutdown paths tear down the runtime first.
**How to avoid:** Guard the spawn with `tokio::runtime::Handle::try_current().ok()`. If no runtime, skip the cleanup (process is exiting; OS will reap).
**Warning signs:** Intermittent "no reactor running" in crash logs; clean shutdown tests start flaking.

### Pitfall 3: `authorBrowser` is the Phase 7 snapshot browser, NOT the Phase 9-04 author-session
**What goes wrong:** `scripts/playwright-sidecar/server.mjs:107-113` defines `state.authorBrowser` / `state.authorContext` / `state.authorIdleHandle` — but these belong to the Phase 7-06 **snapshot capture** flow (captureSnapshot for selector validator). They are NOT the Phase 9-04 **Live Preview** author-session. Accidentally reusing this browser for picker would break the snapshot flow AND wouldn't give us the streamId-keyed page model Phase 10 depends on.
**Why it happens:** Name collision. Both use the word "author".
**How to avoid:** Phase 9-04 will introduce a SEPARATE page pool keyed by streamId (per 10-02 `attach_author_driver`). Name it something like `state.previewPagesByStreamId` to disambiguate. Research the 9-04 plan when it lands and confirm naming.
**Warning signs:** Snapshots for the selector validator suddenly go stale or break after Phase 11 ships.

### Pitfall 4: `framenavigated` auto-cancel fighting with navigate-replay warm-up
**What goes wrong:** Phase 7-03a MVP registers `page.on('framenavigated', framenavListener)` which auto-cancels pending picks on navigation (server.mjs:707-711). Phase 11 D-10 warm-up REPLAYS `navigate` verbs BEFORE calling `pickElement.start`, so in principle this is fine. But if a replayed navigate page fires framenavigated events late (after `pickElement.start` registers), it'll cancel immediately.
**Why it happens:** Navigation events can be delayed vs. `goto()` awaiting.
**How to avoid:** In the host flow, order it: (1) all navigate replays `await`-complete; (2) `await page.waitForLoadState('networkidle')` (via sidecar); (3) then `pickElement.start`. Alternative: in the sidecar, ignore the first `framenavigated` within N ms of picker start (ugly — prefer sequence fix).
**Warning signs:** First pick after lazy-start immediately resolves with `{ cancelled: true, reason: "navigation" }`.

### Pitfall 5: Re-pick on a line without `@id=...` double-stamps
**What goes wrong:** `picker_stamp_step_id` is idempotent by line number when `existing_id.is_some()`. BUT if a previous pick inserted the line + stamped it, the editor shows `click button "Save" # @id=<uuid>`. If the user moves the cursor to this line and invokes Pick again, re-pick should upsert `targets.json` WITHOUT rewriting the source. The current `picker_stamp_step_id` re-reads the source, re-parses, finds `existing_id`, and **re-writes the source anyway** via `std::fs::write(&path, formatted)`. This defeats D-04's "bytes never rewritten by a re-pick."
**Why it happens:** Phase 7-04 wrote the function assuming stamping is always paired with an insertion; it doesn't short-circuit when the id is unchanged.
**How to avoid:** **Audit and patch** `picker_stamp_step_id` (picker.rs lines 225-242): when `existing_id.is_some()`, skip the formatter + file write entirely, jump straight to the `targets_store::atomic_write`. Add a unit test. This is a true Phase 11 fix — surface to planner explicitly.
**Warning signs:** `git diff story.story` shows whitespace-only changes after a re-pick; file mtime changes on every re-pick.

### Pitfall 6: Simulator-start raced with Pick
**What goes wrong:** Renderer derives "can I click simulator-start?" from a stale snapshot of `AuthorDriverState`. User clicks simulator-start → command enters host → acquires lock → finds `Picking` state → returns error. Meanwhile the Pick button was also disabled but the stale render let simulator-start through. D-15 says blocked but UI-only guards are insufficient.
**How to avoid:** **Two-layer defense.** (a) UI derives from `Channel<AuthorDriverState>` (or polled snapshot) for disabled state. (b) Host command re-validates under the lock before transitioning — return typed `AppError::Automation("Picking — press Esc")` if state has shifted. Never rely solely on UI gating for concurrency correctness.
**Warning signs:** Flaky "can't start simulator while picking" integration tests.

## Code Examples

### Example 1: Sidecar `pickElement.start` streamId routing (sketch)

```javascript
// Source: scripts/playwright-sidecar/server.mjs (proposed extension of :665)
'pickElement.start': async ({ timeoutMs = 60000, streamId } = {}) => {
  const page = streamId
    ? state.previewPagesByStreamId?.get(streamId)    // Phase 9-04 populated
    : state.page;                                    // record path (no callers in v1)
  if (!page) {
    const err = new Error(streamId
      ? `no author page for streamId=${streamId} — call start_author_preview first`
      : 'browser not launched');
    err.code = -32000;
    throw err;
  }
  // ... rest unchanged, using `page` instead of `state.page`.
},
```

### Example 2: Preview-panel button mount (UI wiring)

```tsx
// Source: apps/desktop/src/features/editor/preview-panel.tsx (proposed extension, top of header)
import { PreviewPickerButton } from "./PreviewPickerButton";

// Inside <header>, left of viewport controls:
<div className="flex items-center gap-2">
  <PreviewPickerButton />   {/* NEW */}
  <span className="text-[11px] ...">Preview</span>
</div>
```

### Example 3: Record-path self_heal=false + actionable error

```rust
// Source: apps/desktop/src-tauri/src/commands/automation.rs (proposed edit, around line 328)
let mut events = Executor::run_with_story_path(
    story,
    Some(story_path.clone()),
    primary,
    fallback,
    Some(project_db),
    screenshot_dir,
    launch_opts,
    Some(Arc::new(RunControl::default())),
    /* stop_after_ordinal */ None,
    /* capture_frames    */ false,
    /* frame_dir         */ None,
    /* self_heal         */ false,   // ← Phase 11 D-06 flip
);
```

Error surfacing — in `executor.rs::run_command` (Phase 10-01 Task 2 will introduce the gate):
```rust
// When self_heal=false AND primary miss:
return Err((
    AutomationError::PrimaryMissNoHeal {
        step_ordinal: ordinal,
        step_id: cmd.step_id(),
        verb: command_verb_label(cmd),   // existing helper
    },
    attempts,
));
```

### Example 4: AuthorDriverState transition table (source doc comment)

```rust
// Source: proposed apps/desktop/src-tauri/src/author_driver.rs
//
// Transition table (lock-protected):
//
//   Idle                 ──(start_author_preview)──►  LivePreview{streamId}
//   LivePreview{s}       ──(stop_author_preview)──►   Idle
//   LivePreview{s}       ──(picker_start_author)──►   Picking{s, resume_to=None}
//   LivePreview{s}       ──(simulator_start)──────►   SimulatorRunning{session}
//   Picking{s,rt=None}   ──(pick resolve/cancel)──►   LivePreview{s}
//   Picking{s,rt=Some}   ──(pick resolve/cancel)──►   *rt (restore prior)
//   SimulatorRunning     ──(RunPaused)────────────►   SimulatorPaused
//   SimulatorRunning     ──(StoryEnded/Cancel)────►   Idle or LivePreview{s}
//   SimulatorPaused{s}   ──(simulator_step_to)────►   SimulatorRunning
//   SimulatorPaused{s}   ──(simulator_cancel)─────►   Idle or LivePreview{s}
//   SimulatorPaused{s}   ──(picker_start_author)──►   Picking{s, resume_to=SimulatorPaused}
//
// Invariants:
//   • Picking only reachable from LivePreview or SimulatorPaused.
//   • SimulatorPaused is the ONLY non-Idle state that carries a resume_to box.
//   • Idle is reachable from any state via explicit teardown OR app shutdown.
```

## Environment Availability

Phase 11 has no NEW external dependencies. It uses only tools already required by the shipped recorder + picker flows:

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node runtime (sidecar SEA) | playwright-sidecar | ✓ | bundled | — (required) |
| esbuild (overlay bundle) | sidecar build | ✓ | — | — |
| tokio 1.40+ | AuthorDriverState mutex | ✓ | workspace-pinned | — |
| Tauri 2.8+ | State mgmt | ✓ | workspace-pinned | — |
| **Phase 9-04 execute** | attach_author_driver, pauseStream, resumeStream | ✗ (not shipped) | — | **None — blocks Phase 11 execute, same blocker as Phase 10** |
| **Phase 10-01 execute** | `Executor::run_story(self_heal)` + `StepFrame.match_kind` | ⚠ in-flight (plan ready, not executed) | — | Phase 11 Task "self_heal flip" blocks on 10-01 Task 2 |

**Missing dependencies with no fallback:**
- Phase 9-04 must land `start_author_preview`, `attach_author_driver`, `pauseStream`, `resumeStream`, and `previewPagesByStreamId` (or equivalent) before Phase 11 can run end-to-end. Same blocker already identified for Phase 10.

**Missing dependencies with fallback:**
- None. All other primitives already in the tree.

## Validation Architecture

Nyquist validation is enabled (no `workflow.nyquist_validation: false` in config). Phase 11 needs:

### Test Framework
| Property | Value |
|----------|-------|
| Rust | `cargo test -p storycapture-desktop` + `cargo test -p automation` |
| TS unit | `pnpm --filter @storycapture/desktop test` (vitest) |
| Sidecar | `pnpm --filter playwright-sidecar test` (vitest + real Chromium, existing) |
| Quick run command | `pnpm --filter @storycapture/desktop test -- PreviewPickerButton author_driver` |
| Full suite | `pnpm test && cargo test --workspace` |

### Phase Requirements → Test Map

| Req | Behavior | Test Type | Command | File Exists? |
|-----|----------|-----------|---------|-------------|
| D-01 | PreviewPickerButton renders in preview-panel toolbar; Cmd-Shift-P triggers pick | unit | `pnpm ... test -- PreviewPickerButton` | ❌ Wave 0 |
| D-02 | Button enabled only when author-session is up (D-09 lazy-start separately tested) | unit | same | ❌ Wave 0 |
| D-03 | pauseStream called on pick start; resumeStream on resolve AND cancel | integration | `cargo test -p storycapture-desktop --test author_driver_picker_pause_resume` | ❌ Wave 0 |
| D-04 | Same-line re-pick does NOT modify `.story` bytes; does modify `.story.targets.json` | integration | `cargo test -p storycapture-desktop --test picker_stamp_idempotent_source_bytes` | ❌ Wave 0 — **see Pitfall 5; this also verifies the patch** |
| D-05 | recording-view no longer renders PickElementButton; pick-element-button.test.tsx removed | unit (grep-style) | `pnpm ... typecheck` + `grep -c "PickElementButton" apps/desktop/src/features/recorder/*` = 0 | — (negative assertion) |
| D-06 | launch_automation passes self_heal=false; primary-miss produces structured error | integration | `cargo test -p storycapture-desktop --test record_path_self_heal_false` | ❌ Wave 0 |
| D-07 | No `.story.targets.pending.json` ever written | integration | grep in test | — |
| D-09 | Lazy-start: button with no live session transitions to `starting…`, then active | unit | `pnpm ... test -- PreviewPickerButton.lazy` | ❌ Wave 0 |
| D-10 | navigate-only replay walks commands ≤ cursor_line, skips non-Navigate | unit | `cargo test -p storycapture-desktop replay_navigate_verbs_before_cursor` | ❌ Wave 0 |
| D-12 | Resume-on-cancel: PickerResumeGuard Drop restores prior state + calls resumeStream | integration | `cargo test -p storycapture-desktop picker_resume_guard_on_cancel` | ❌ Wave 0 |
| D-13/D-15 | Simulator ↔ Pick mutual exclusion at the host layer | integration | `cargo test -p storycapture-desktop author_driver_concurrency` | ❌ Wave 0 |
| D-14 | Pick from SimulatorPaused restores to SimulatorPaused | integration | `cargo test -p storycapture-desktop pick_from_simulator_paused` | ❌ Wave 0 |
| D-16 | All 5 AuthorDriverState variants reachable; invalid transitions return error | unit | `cargo test -p storycapture-desktop author_driver_state_machine` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm ... test -- PreviewPickerButton && cargo test -p storycapture-desktop --test author_driver_state_machine`
- **Per wave merge:** Full suite plus one manual smoke against a live author-session (after 9-04 lands).
- **Phase gate:** Full suite green + rewritten `11-SMOKE.md` (replacing `07-03b-SMOKE.md` + `07-04c-SMOKE.md` record-path runbooks).

### Wave 0 Gaps
- [ ] `apps/desktop/src-tauri/tests/author_driver_state_machine.rs` — covers D-16
- [ ] `apps/desktop/src-tauri/tests/author_driver_concurrency.rs` — covers D-13/D-14/D-15
- [ ] `apps/desktop/src-tauri/tests/picker_stamp_idempotent_source_bytes.rs` — covers D-04 + Pitfall 5 fix
- [ ] `apps/desktop/src-tauri/tests/replay_navigate_verbs.rs` — covers D-10
- [ ] `apps/desktop/src-tauri/tests/record_path_self_heal_false.rs` — covers D-06
- [ ] `apps/desktop/src/features/editor/PreviewPickerButton.test.tsx` — covers D-01, D-02, D-09
- [ ] `.planning/phases/11-.../11-SMOKE.md` — operator runbook replacing 07-03b/04c record-path smokes
- [ ] Update `scripts/playwright-sidecar/server.test.mjs` — `pickElement.start({ streamId })` routing

## Security Domain

`security_enforcement` is not explicitly `false` in config (default: enabled). Phase 11 adds minimal security surface:

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No auth boundary added |
| V3 Session Management | no | — |
| V4 Access Control | yes | AuthorDriverState lock IS the access-control primitive for browser-automation exclusive access; enforce under Mutex, not on renderer trust |
| V5 Input Validation | yes | `streamId` from renderer must be validated (type + membership in known-live-streams map) before sidecar routing |
| V6 Cryptography | no | — |
| V12 Files & Resources | yes | `picker_stamp_step_id` already has path-traversal guard (picker.rs:190-194); keep the guard on any new command that accepts a story_path or project_dir |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Renderer sends fabricated `streamId` to `picker_start_author` | Spoofing / EoP | Validate streamId against `state.previewPagesByStreamId` membership; return typed error on miss (do NOT fall through to `state.page`) |
| Deadlock: picker holds `AuthorDriverState` lock + simulator_cancel waits | DoS | Scope-drop-reacquire pattern (Pattern 1 above) |
| Silent `.story.targets.json` mutation during recording (Phase 7 legacy behavior) | Tampering | D-06 self_heal=false; add assertion in an integration test that record-run does NOT change targets.json mtime |
| Stamped step_id collides with existing one (re-pick bug) | Tampering | `picker_stamp_step_id` already short-circuits on existing_id; patch to also skip source write per Pitfall 5 |
| Pick activated on `chrome://` / `about:` page (sidecar allowlist) | EoP / IdDisclosure | Already handled: server.mjs:672-674 returns unsupported-url. Verify this path still fires on author-context Page. |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 9-04 will expose author pages via a map keyed by streamId (e.g., `state.previewPagesByStreamId`) | Pitfall 3, Example 1 | If 9-04 uses a different shape (single page, or stream-id-derived URL), sidecar extension needs rework — minor refactor, not a rethink |
| A2 | Phase 10-01 Task 2 will plumb `self_heal: bool` through `run_story`; Phase 11 only flips the call-site flag | Pattern 3 | If 10-01 ships differently, Phase 11 may need to add the param itself — adds one task |
| A3 | Phase 10-03 Task 2 will export `caretLineToOrdinal` from simulator-decoration.ts | Pattern 2 | If not exported, Phase 11 duplicates the helper (~20 lines) |
| A4 | `picker_stamp_step_id` currently re-writes source even when step_id is unchanged | Pitfall 5 | **[VERIFIED: Read picker.rs:225-242]** — no assumption; the function DOES re-write. Planner must include the fix. |
| A5 | Pitfall 6 (UI-only gating insufficient) is a real race | Pitfall 6 | Low consequence; host-layer guard is cheap to add regardless |
| A6 | ROADMAP.md's Phase 11 entry does NOT include PHASE-11.* requirement IDs | Phase Requirements section | If IDs are minted later, planner must backfill |

**Mostly verified; two assumptions (A1, A2) depend on pending Phase 9-04 + 10-01 execute. Planner should confirm at plan-check time.**

## Open Questions

1. **Shape of author-session page lookup in sidecar.**
   - What we know: Phase 10 D-06 specifies `attach_author_driver(streamId)` + `pauseStream`/`resumeStream`; this implies the sidecar has a streamId-keyed lookup.
   - What's unclear: whether it's `Map<StreamId, Page>`, `Map<StreamId, { page, context }>`, or something else.
   - Recommendation: Planner reads 09-04-PLAN.md and 10-02's sidecar extension portion before finalizing Phase 11's sidecar extension.

2. **Should `AuthorDriverState` be exposed to the renderer via `Channel<T>` or derived?**
   - What we know: CONTEXT D-16 Discretion allows either.
   - What's unclear: Whether the UI's needs (enable/disable button, show `starting…` state) are cleanly derivable from `simulatorStore.runState` + a `livePreviewStore.streamId != null` signal.
   - Recommendation: **Prefer `Channel<T>`.** Phase 10-03's button-enablement logic already threads through Preview+Simulator stores; adding a third source (AuthorDriverState) is cleaner than fan-out projection.

3. **Is `starting…` state a UI-only flag or part of `AuthorDriverState`?**
   - What we know: CONTEXT says "button enters `starting…` state".
   - What's unclear: Whether this is a local component state (useState) or a formal state in the FSM.
   - Recommendation: **Local component state.** The FSM should track "who owns the driver," not per-UI-action loading. `starting…` is a pre-flight UI gate.

4. **Where does `AuthorDriverState::Idle ↔ LivePreview` transition fire?**
   - What we know: LivePreview is the 9-04 surface; user toggles Preview on/off.
   - What's unclear: Whether 9-04's `start_author_preview` command takes the AuthorDriverRegistry lock to transition Idle→LivePreview, or whether Phase 11 adds that step.
   - Recommendation: Phase 11 owns this — 9-04 shipped before Phase 11 and predates the FSM. Planner adds the transition hooks in `start_author_preview` / `stop_author_preview` as part of Phase 11's backend plan.

5. **Should `picker_stamp_step_id` Pitfall 5 fix be in Phase 11 or a hotfix?**
   - What we know: D-04 is strict about "bytes never rewritten by a re-pick"; current code fails D-04.
   - What's unclear: Whether this is considered a shipped-Phase-7 bug (hotfix) or in Phase 11 scope.
   - Recommendation: **Phase 11.** D-04 is new policy; Phase 11 owns making it true. Include as an explicit task with a dedicated test.

## Proposed Plan Split

Suggested breakdown for planner (4 plans, 3 waves):

### Wave 1 (parallel — no inter-deps)

**11-01: AuthorDriverRegistry + state machine (backend)**
- New `apps/desktop/src-tauri/src/author_driver.rs`: enum + `AuthorDriverRegistry { state: Mutex<AuthorDriverState> }` + transition guards
- `.manage()` in lib.rs
- `picker_stamp_step_id` Pitfall 5 fix (skip source write when step_id unchanged)
- Unit + integration tests (state_machine, concurrency, stamp-idempotent-bytes)
- Files: `src-tauri/src/author_driver.rs` (NEW), `src-tauri/src/lib.rs` (EDIT), `src-tauri/src/commands/picker.rs` (PATCH)
- Depends on: none

**11-02: Record-path self_heal=false + actionable error**
- Flip `Executor::run_with_story_path` call in `commands/automation.rs:328` to pass `self_heal=false` (uses Phase 10-01 Task 2 surface)
- Shape structured "open in Simulator" error
- Recorder HUD: surface error with action link (click → opens Simulator on the failed step)
- Integration test: record-path primary-miss produces error, `.story.targets.json` mtime unchanged
- Files: `src-tauri/src/commands/automation.rs`, `crates/automation/src/executor.rs` (error variant), `apps/desktop/src/features/recorder/hud.tsx`
- Depends on: Phase 10-01 Task 2 merged

### Wave 2 (depends on 11-01 lock handle + 09-04)

**11-03: Sidecar author-context picker + navigate-replay warm-up**
- `scripts/playwright-sidecar/server.mjs`: `pickElement.start({ streamId? })` route selection + per-streamId-page binding bookkeeping
- New `author.goto(streamId, url)` sidecar RPC (or extend existing driver surface) for replay
- New Rust command `picker_start_author(stream_id, cursor_line)` in `commands/picker.rs` — wraps replay, pause, pick, resume in PickerResumeGuard
- `replay_navigate_verbs` helper
- Unit tests in sidecar vitest (route with streamId, route without)
- Integration test: D-10 + D-12 + D-14 (from SimulatorPaused restore path)
- Files: `scripts/playwright-sidecar/server.mjs`, `src-tauri/src/commands/picker.rs`, `apps/desktop/src/ipc/picker.ts` (add `pickElementAuthor`)
- Depends on: 11-01 (for registry), 09-04-execute (for streamId map + pause/resume RPCs), 10-02 (for `attach_author_driver` pattern)

### Wave 3 (depends on 11-03 Tauri commands)

**11-04: PreviewPickerButton + deletion of recorder picker**
- New `apps/desktop/src/features/editor/PreviewPickerButton.tsx`
- New `.../PreviewPickerButton.test.tsx` (adapted from `recorder/pick-element-button.test.tsx`)
- Mount in `preview-panel.tsx` toolbar; Cmd-Shift-P keymap registration in codemirror-setup.ts (hook into existing Phase 10-03 keymap block)
- Derive disabled state from AuthorDriverState (via `Channel<T>` or polled projection — planner picks)
- Delete `apps/desktop/src/features/recorder/pick-element-button.tsx` + its test
- Edit `apps/desktop/src/features/recorder/recording-view.tsx` — remove import (line 45) + mount (line 704) + surrounding comment
- Rewrite `07-03b-SMOKE.md` + `07-04c-SMOKE.md` record-path sections → new `11-SMOKE.md` covering author-side picker
- Files: `apps/desktop/src/features/editor/PreviewPickerButton.tsx` (NEW), test file (NEW), `preview-panel.tsx` (EDIT), `codemirror-setup.ts` (EDIT), `recording-view.tsx` (EDIT — 3 small deletions), recorder files (DELETE), `.planning/phases/11-.../11-SMOKE.md` (NEW)
- Depends on: 11-03

## Sources

### Primary (HIGH confidence — read in-session)
- `.planning/phases/11-.../11-CONTEXT.md` — 16 LOCKED decisions (D-01..D-16)
- `.planning/phases/10-.../10-CONTEXT.md` — dependency decisions (D-06, D-07, D-08, D-11)
- `.planning/phases/10-.../10-01-PLAN.md`, `10-02-PLAN.md`, `10-03-PLAN.md` — execute plans for dependency primitives
- `.planning/phases/07-.../07-CONTEXT.md` — Tier 2 picker baseline decisions (LOCKED; still in force)
- `apps/desktop/src-tauri/src/commands/picker.rs` — shipped picker surface (316 lines)
- `apps/desktop/src-tauri/src/commands/author_snapshot.rs` — lock-scope precedent (lines 131-144)
- `apps/desktop/src-tauri/src/commands/automation.rs` — `launch_automation` entry (line 38)
- `apps/desktop/src/features/editor/controller.ts` — editorController singleton (88 lines)
- `apps/desktop/src/features/editor/preview-panel.tsx` — mount target (219 lines; note: this is the Phase 1 static preview — Phase 9-04 will add LivePreview; mount location still correct)
- `apps/desktop/src/features/recorder/pick-element-button.tsx` — source of the deletion + behavior to port (236 lines)
- `apps/desktop/src/features/recorder/recording-view.tsx:45,704` — deletion sites
- `apps/desktop/src/ipc/picker.ts` — TS IPC wrappers + `TargetRecordDto`
- `scripts/playwright-sidecar/server.mjs:90-113, 665-789, 975-978` — picker + author state
- `crates/automation/src/executor.rs:1-92, 107-175, 300-500` — run_story + try_promote_fallback
- `crates/story-parser/src/ast.rs:260-390` — Command meta + step_id helpers

### Secondary (MEDIUM confidence)
- `.planning/STATE.md` — confirms 9-04 not yet executed as of 2026-04-19
- CLAUDE.md — stack + Agent Working Rules invariants

### Tertiary (LOW confidence)
- None — entire research grounded in in-tree artifacts.

## Metadata

**Confidence breakdown:**
- Existing code surfaces: HIGH — read directly.
- Phase 10 dependency behavior: MEDIUM-HIGH — plans are detailed but unexecuted.
- Phase 9-04 dependency behavior: MEDIUM — plans not fully read in this session; A1/A2 assumptions flagged for plan-check.
- AuthorDriverState design: HIGH — enum locked in D-16, lock pattern confirmed against existing simulator registry.
- Pitfall 5 (stamp source-write bug): HIGH — verified by reading picker.rs:225-242.

**Research date:** 2026-04-19
**Valid until:** 2026-05-19 (30 days; stable since depends on in-repo artifacts, not external libraries)
