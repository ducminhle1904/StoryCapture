# Phase 11: Author-time element picker — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in 11-CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-19
**Phase:** 11 — Author-time element picker (relocate Pick to Preview panel, route through author-session, record path read-only)
**Areas discussed:** Picker placement/invocation/re-pick; Record-path read-only policy & Phase 7 migration; Author-session lifecycle for picking; Concurrency with simulator runs

---

## Area 1 — Picker placement, invocation & re-pick

### Q: Primary entry point for Pick in the Preview panel

| Option | Description | Selected |
|--------|-------------|----------|
| Preview toolbar button + shortcut (Recommended) | Crosshair in Preview toolbar + Cmd-Shift-P. Mirrors shipped Phase 7 pattern; highest discoverability. | ✓ |
| Caret context menu only | Right-click on DSL line → 'Pick element here'. Tightly couples pick to step; lower discoverability. | |
| Both toolbar + context menu | Two code paths. | |

### Q: Enable conditions

| Option | Description | Selected |
|--------|-------------|----------|
| Author-session up, regardless of Live Preview toggle (Recommended) | Pick lazy-starts author-session if dormant; Live Preview toggle orthogonal. | ✓ |
| Only when Live Preview is ON | Toggle dance required before first pick. | |
| Always enabled; 'starting…' state | Most complex loading states. | |

### Q: Visual affordance during active pick

| Option | Description | Selected |
|--------|-------------|----------|
| Pause screencast + overlay only (Recommended) | pauseStream; overlay takes over. Requires PHASE-9.9. | ✓ |
| Keep screencast live + overlay on top | Higher latency/jitter. | |
| Dim screencast + tint border | Middle ground. | |

### Q: Same-line re-pick behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Update targets.json only; .story bytes unchanged (Recommended) | Matches simulator_promote_fallback invariant. | ✓ |
| Rewrite DSL line + update targets.json | Risks clobbering hand-crafted DSL. | |
| Prompt modal per re-pick | Most friction. | |

---

## Area 2 — Record-path read-only policy & Phase 7 migration

### Q: Pick element in the recording toolbar

| Option | Description | Selected |
|--------|-------------|----------|
| Remove entirely; Pick only in Preview (Recommended) | Cleanest, matches 'Record is final' invariant. | ✓ |
| Keep disabled with tooltip | Permanent cruft. | |
| Feature flag — off by default | Added complexity. | |

### Q: Self-healing behavior during recording run

| Option | Description | Selected |
|--------|-------------|----------|
| Off during record — fail on primary miss (Recommended) | self_heal=false; actionable error directs to Simulator. Strongest determinism guarantee. | ✓ |
| In-memory heal, no disk writes | Opaque. | |
| Heal + pending buffer + review drawer | Most permissive, most code. | |

### Q: Handle shipped Phase 7 picker code

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse core modules, redirect to author-session (Recommended) | Swap driver routing; minimal duplication. | ✓ |
| Fresh implementation in editor/ namespace | Duplicates logic. | |
| Hybrid: shared core, forked button + Tauri command | Accommodates future divergence. | |

### Q: Pending promotions drawer

| Option | Description | Selected |
|--------|-------------|----------|
| No drawer — healing only in Simulator (Recommended) | Zero new UI; single healing surface. | ✓ |
| Yes — drawer reviews pending buffer | New UI + IPC. | |
| Defer decision to planner | Claude's discretion. | |

---

## Area 3 — Author-session lifecycle for picking

### Q: Author-session startup on first Pick

| Option | Description | Selected |
|--------|-------------|----------|
| Lazy-start on first Pick, spinner on button (Recommended) | ~2-3s first-click latency; subsequent picks instant. | ✓ |
| Pre-warm on project open | Higher idle memory. | |
| Require explicit 'Start preview' first | Worst UX. | |

### Q: Author-browser starting page

| Option | Description | Selected |
|--------|-------------|----------|
| meta.app + replay navigate verbs above cursor (Recommended) | Fast; lands on right route for cross-route picks. | ✓ |
| meta.app only | Poor UX for multi-page stories. | |
| Full replay up to cursor | Overkill; 10s+ for 20-step stories. | |

### Q: Author-session idle timeout

| Option | Description | Selected |
|--------|-------------|----------|
| 10 min (Recommended) | Covers burst + coffee break. | ✓ |
| 2 min | Frequent cold-starts. | |
| Never idle-shutdown | Persistent memory cost. | |

### Q: Screencast behavior during pick

| Option | Description | Selected |
|--------|-------------|----------|
| pauseStream at pick start, resumeStream at end (Recommended) | Clean, matches D-03. | ✓ |
| Keep stream running | CPU + input contention. | |
| Stream runs; hover previews via screencast metadata | Overly clever. | |

---

## Area 4 — Concurrency with simulator runs

### Q: Pick during actively-running simulator

| Option | Description | Selected |
|--------|-------------|----------|
| Disable Pick; tooltip 'cancel to pick' (Recommended) | Aligns with D-08 editor read-only. | ✓ |
| Clicking Pick cancels simulator first | Destructive; silent state loss. | |
| Queue the Pick | State complexity. | |

### Q: Pick during paused simulator (RunPaused)

| Option | Description | Selected |
|--------|-------------|----------|
| Allow Pick; preserves paused driver state (Recommended) | Supports 'Preview to here → pick missing button' flow. | ✓ |
| Disable until simulator ended | Breaks natural pause-and-pick loop. | |
| Pick implicitly ends simulator | Lossy. | |

### Q: Simulator start while Pick is active

| Option | Description | Selected |
|--------|-------------|----------|
| Simulator button shows 'Picking—press Esc'; blocked (Recommended) | Matches D-11 'never shared'. | ✓ |
| Simulator start cancels active pick | One-click wins. | |
| Queue simulator run | State complexity. | |

### Q: Where does the exclusive lock live

| Option | Description | Selected |
|--------|-------------|----------|
| Single shared Mutex<AuthorDriverState> in author_driver.rs (Recommended) | One lock, enum states. Simplest correctness. | ✓ |
| Separate locks, acquire-order convention | Invites deadlocks. | |
| Leave to planner | Claude picks primitive. | |

---

## Claude's Discretion

- Exact Tauri command names on the new author-session picker path.
- UI copy for disabled-state tooltips.
- Whether to expose AuthorDriverState transitions as Channel<T> or derive from event streams.
- Loading/error UI for the `starting…` state.
- Keyboard hint rendering on the toolbar button.
- Telemetry hooks (opt-in only).
- Error handling for navigate-replay during warm-up.

## Deferred Ideas

- Caret-line context menu entry for Pick.
- Full-replay warm-up (click/type/hover).
- Tauri Channel<AuthorDriverState> stream to frontend.
- Pending-promotions buffer + review drawer.
- Persistent author-session across project switches.
- Cross-frame / cross-origin picker.
- "Pick multiple" batch mode.
