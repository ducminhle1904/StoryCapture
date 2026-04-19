---
phase: 11
type: patterns
status: ready-for-planning
date: 2026-04-19
---

# Phase 11 — Pattern Map

**Mapped:** 2026-04-19
**Files analyzed:** 12 (4 NEW, 6 MODIFY, 2 DELETE)
**Analogs found:** 12 / 12 — every new/modified file has a production analog already in the tree.

Phase 11 is a re-routing + deletion phase. Prefer copying existing patterns verbatim over new design.

---

## File Classification

| File | Action | Role | Data Flow | Closest Analog | Match Quality |
|------|--------|------|-----------|----------------|---------------|
| `apps/desktop/src-tauri/src/author_driver.rs` | NEW | state-registry (Tauri-managed) | FSM / pub-sub via Channel | `apps/desktop/src-tauri/src/commands/simulator.rs` (Phase 10-02 plan — `SimulatorRegistry` + `ResumableSession`) | role-match (registry pattern); logic is net-new |
| `apps/desktop/src-tauri/src/commands/picker.rs` | EXTEND (add `picker_start_author`; patch `picker_stamp_step_id` Pitfall 5) | Tauri controller | request-response | **self** — existing `picker_start` (lines 84–102); existing `picker_stamp_step_id` (lines 180–261) | exact |
| `apps/desktop/src-tauri/src/commands/automation.rs` | EDIT (flip `self_heal=false` at Executor call site) | Tauri controller | event-stream | **self** — existing `Executor::run` call site (lines 328–336) | exact |
| `apps/desktop/src-tauri/src/commands/simulator.rs` | COORDINATE (acquire shared `AuthorDriverRegistry` lock around transitions) | Tauri controller | event-stream | Phase 10-02 plan — `simulator_start` acquires `SimulatorRegistry`; Phase 11 adds the second lock acquisition | role-match |
| `apps/desktop/src-tauri/src/lib.rs` | EDIT (`.manage(AuthorDriverRegistry::default())`) | app-bootstrap | config | **self** — existing `.manage()` calls in `app.setup` (lines 134–147) | exact |
| `apps/desktop/src/features/editor/PreviewPickerButton.tsx` | NEW | React component (toolbar button + kbd shortcut + banner) | request-response + event-subscribe | `apps/desktop/src/features/recorder/pick-element-button.tsx` (full behavior; adapted to author-session) + `apps/desktop/src/features/editor/preview-panel.tsx` (`ViewportButton` chrome) | exact |
| `apps/desktop/src/features/editor/PreviewPickerButton.test.tsx` | NEW | vitest | test | `apps/desktop/src/features/recorder/pick-element-button.test.tsx` (mockIPC + editorController spy + recorder store seed) | exact |
| `apps/desktop/src/features/editor/preview-panel.tsx` | EXTEND (mount `<PreviewPickerButton />` in toolbar) | React component | layout | **self** — toolbar header at lines 47–80 | exact |
| `apps/desktop/src/features/editor/codemirror-setup.ts` | EXTEND (register `Cmd-Shift-P` keymap; Phase 10-03 adds `Cmd-.` in the same block) | CM6 extension | config | **self** — theme + extension assembly (current file); Phase 10-03 will add keymap block | role-match |
| `apps/desktop/src/ipc/picker.ts` | EXTEND (add `pickElementAuthor({ streamId, cursorLine })`) | IPC wrapper | request-response | **self** — existing `pickElement` (lines 60–70), `pickerStampStepId` (lines 154–163) | exact |
| `apps/desktop/src/features/recorder/recording-view.tsx` | EDIT (remove import line 45 + mount line 704 + banner block) | React composition | — | **self** — lines 45, 704 | exact (deletion) |
| `apps/desktop/src/features/recorder/pick-element-button.tsx` | DELETE | — | — | — | — |
| `apps/desktop/src/features/recorder/pick-element-button.test.tsx` | DELETE / MIGRATE | — | — | new test reuses this structure | — |
| `scripts/playwright-sidecar/server.mjs` | EXTEND (`pickElement.start({ streamId? })` routing; previewPagesByStreamId lookup) | JSON-RPC handler | request-response | **self** — existing `pickElement.start` (lines 665–778); `captureSnapshot` (lines 582–638, branches on `authorContext` vs `state.page`) | exact |

Deletion targets: `pick-element-button.tsx` (236 lines) + `pick-element-button.test.tsx` entirely. Phase 7 picker core (`picker/overlay/`, `targets_store.rs`, ranked generator) is preserved verbatim per D-08.

---

## Pattern Assignments

### `apps/desktop/src-tauri/src/author_driver.rs` (NEW — state registry, FSM)

**Analog:** `apps/desktop/src-tauri/src/commands/simulator.rs` (per Phase 10-02 plan lines 190–214). **This is the canonical registry pattern in-tree.**

**Registry shape pattern** (10-02-PLAN.md lines 211–214):
```rust
#[derive(Default)]
pub struct SimulatorRegistry {
    pub sessions: Mutex<HashMap<SimulatorSessionId, ResumableSession>>,
}
```

**Phase 11 mirror (D-16 enum, not HashMap):**
```rust
#[derive(Default)]
pub struct AuthorDriverRegistry {
    pub state: Mutex<AuthorDriverState>,  // Default = AuthorDriverState::Idle
}

pub enum AuthorDriverState { Idle, LivePreview{..}, Picking{..}, SimulatorRunning{..}, SimulatorPaused{..} }
```

**Registration pattern — copy from** `apps/desktop/src-tauri/src/lib.rs:134-147`:
```rust
app.manage(state::AppState::new(data_dir, log_dir));
// ...
app.manage(commands::lsp::LspBridgeState::new(lsp_bridge));
app.manage(std::sync::Arc::new(state::nl_tasks::NlTaskRegistry::default()));
```
→ Add `app.manage(author_driver::AuthorDriverRegistry::default());` next to these.

**Typed-error pattern — copy from** 10-02-PLAN.md lines 227–239:
```rust
#[derive(Debug, thiserror::Error, Serialize)]
pub enum SimulatorError {
    #[error("preview is disabled — ...")]
    PreviewDisabled,
    #[error("session {0} not found — ...")]
    SessionNotFound(String),
    // ...
}
```
→ Mirror as `AuthorDriverError::{BusyPicking, SimulatorRunning(session), InvalidTransition(from, to)}`.

**RAII Drop guard — no existing analog in src-tauri** (verified via grep — no `impl Drop for` exists). This is net-new; follow 11-RESEARCH.md Pattern 1 (`PickerResumeGuard`). Use `tokio::runtime::Handle::try_current().ok()` before `tokio::spawn` (Pitfall 2).

---

### `apps/desktop/src-tauri/src/commands/picker.rs` (EXTEND)

**Analog:** itself. Phase 11 adds a second command + patches `picker_stamp_step_id`.

**New command pattern — copy the exact shape of `picker_start`** (picker.rs:84-102):
```rust
#[tauri::command]
#[specta::specta]
pub async fn picker_start(
    state: State<'_, AppState>,
    timeout_ms: u64,
) -> Result<PickElementResponseDto, AppError> {
    let driver = {
        let slot = state.playwright_driver.lock().await;
        slot.as_ref()
            .cloned()
            .ok_or_else(|| AppError::Automation("Playwright sidecar not launched".into()))?
    };
    let d = driver.lock().await;
    let r = d
        .pick_element_start(timeout_ms)
        .await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    Ok(r.into())
}
```

**Phase 11 adds `picker_start_author`** with the same signature shape + a `stream_id: String`, `cursor_line: u32` pair + a `State<'_, AuthorDriverRegistry>` parameter. Lock-scope-drop-reacquire pattern per RESEARCH Pattern 1. **Acquire `AuthorDriverRegistry` FIRST, drop guard, then acquire `playwright_driver` lock** (never hold both across an await).

**Lock-scope precedent — copy from `author_snapshot.rs:131-144`** (drop+reacquire idiom):
```rust
let driver = {
    let slot = state.playwright_driver.lock().await;
    slot.as_ref().cloned().ok_or_else(|| {
        AppError::Automation("Playwright sidecar not launched — ...".into())
    })?
};
let d = driver.lock().await;
let resp = d.capture_snapshot(&url, None, Some(15_000)).await
    .map_err(|e| AppError::Automation(format!("captureSnapshot: {e}")))?;
drop(d);  // ← explicit drop before next awaited step
```

**Pitfall 5 patch — `picker_stamp_step_id`** (picker.rs:225-242): the current match arm re-writes source even when `existing_id.is_some()`. Patch to short-circuit:
```rust
// CURRENT (buggy) — picker.rs:225-242
let stamped_id = match existing_id {
    Some(id) => id,
    None => {
        let new_id = uuid::Uuid::now_v7();
        // ... stamp + format_story + std::fs::write ...
        new_id
    }
};
// FIX: Some(id) branch already does the right thing (skips write);
// the bug is only if a future change moves fs::write out of the None arm.
// Verify no writes outside None arm; add a test that asserts file mtime
// unchanged on a re-pick of an already-stamped line.
```
**Per research A4, the code as-written is structurally correct** — the bug risk is regression. Add explicit unit test `picker_stamp_idempotent_source_bytes` guarding D-04.

**Path-traversal guard — reuse verbatim** (picker.rs:190-194):
```rust
if story_path.split(['/', '\\']).any(|seg| seg == "..") {
    return Err(AppError::Automation(
        "path traversal rejected: story_path contains '..'".into(),
    ));
}
```
Apply to any new command accepting a path (`picker_start_author` if it takes `story_path` directly, or via `AppState.open_story_path`).

**Notification forwarder — reuse `spawn_notification_forwarder`** (picker.rs:276-315) unchanged; hover-preview events flow identically regardless of which page fires them.

---

### `apps/desktop/src-tauri/src/commands/automation.rs` (EDIT)

**Analog:** itself. The call site is at lines 328–336:

```rust
let mut events = Executor::run(
    story,
    primary,
    fallback,
    persistence,
    screenshot_dir,
    launch_opts,
    Some(control.clone()),
);
```

**Phase 11 change:** After Phase 10-01 lands `Executor::run_with_story_path(..., self_heal: bool, ...)`, switch this call to `Executor::run_with_story_path(...)` with `self_heal: false`. RESEARCH Example 3 shows the expected signature:
```rust
Executor::run_with_story_path(
    story, Some(story_path.clone()), primary, fallback,
    Some(project_db), screenshot_dir, launch_opts,
    Some(Arc::new(RunControl::default())),
    /* stop_after_ordinal */ None,
    /* capture_frames    */ false,
    /* frame_dir         */ None,
    /* self_heal         */ false,   // D-06
);
```

**Error enrichment — follow the existing `truncate_at` + `tracing::info!` pattern** (automation.rs:337-353) for the new `AutomationError::PrimaryMissNoHeal` variant. The HUD (`apps/desktop/src/features/recorder/hud.tsx`) already consumes `StepFailed` events with `error_message`.

---

### `apps/desktop/src/features/editor/PreviewPickerButton.tsx` (NEW)

**Analog:** `apps/desktop/src/features/recorder/pick-element-button.tsx` (236 lines). Port behavior; swap session-liveness source + IPC target.

**Full flow to copy** (pick-element-button.tsx:118-178 — the onClick handler):
```tsx
const onClick = async () => {
  if (picking) return;
  setPicking(true);
  try {
    const r = await pickElement({ timeoutMs: 60000 });   // ← replace with pickElementAuthor
    if (isPicked(r)) {
      const res = editorController.insertAtCursor(r.emitted + "\n");
      if (res.ok) {
        toast.success(`Inserted: ${r.emitted}`);
        const storyPath = editorController.getStoryPath();
        if (storyPath) {
          pickerStampStepId({ /* ... */ }).catch((e) => toast.error(...));
        }
      }
    } else {
      switch (r.reason) { /* user-cancel / navigation / unsupported-url / timeout */ }
    }
  } catch (e) { toast.error(...); }
  finally { setPicking(false); }
};
```

**Key substitutions for author path:**
| pick-element-button.tsx | PreviewPickerButton.tsx |
|-------------------------|-------------------------|
| `useRecorderStore((s) => s.status)` → `sessionLive = status === "recording" / "paused"` | derive from `AuthorDriverState` channel or projection (per research Q2 — prefer Channel<T>) |
| `pickElement({ timeoutMs: 60000 })` | `pickElementAuthor({ streamId, cursorLine, timeoutMs: 60000 })` |
| banner copy `"PICKING — press Esc to cancel"` | same copy (UI-SPEC §Picking banner) — relocate into Preview panel surface, not `document.body` portal |
| Button aria-label `"Pick element from browser"` | `"Pick element from preview (Cmd-Shift-P)"` (UI-SPEC §Copywriting) |

**Esc safety-net pattern — copy verbatim** (pick-element-button.tsx:52-63):
```tsx
useEffect(() => {
  if (!picking) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      pickElementCancel().catch(() => {});
    }
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}, [picking]);
```

**Hover-preview subscription — copy verbatim** (pick-element-button.tsx:65-116). Listener name (`picker_hover_preview`) is unchanged; only the page it fires against changes.

**Button chrome — match `ViewportButton` cadence** in preview-panel.tsx:202-219 (`h-7 px-2.5`, rounded, hover → surface-300). Do NOT copy pick-element-button.tsx:187 (`px-3 py-1.5` — that's recorder-toolbar cadence, heavier than Preview toolbar).

**Icon imports:**
```tsx
import { Crosshair, Loader2, XCircle } from "lucide-react";
```

---

### `apps/desktop/src/features/editor/PreviewPickerButton.test.tsx` (NEW)

**Analog:** `apps/desktop/src/features/recorder/pick-element-button.test.tsx` (60+ lines).

**Test harness pattern — copy verbatim** (lines 18-54):
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), /* ... */ }) }));

describe("PreviewPickerButton", () => {
  let insertSpy;
  beforeEach(() => {
    insertSpy = vi.spyOn(editorController, "insertAtCursor")
      .mockReturnValue({ ok: true, lineNumber: 1 });
    // Seed AuthorDriverState as LivePreview (replaces useRecorderStore seed)
  });
  afterEach(() => { clearMocks(); insertSpy.mockRestore(); });
  // ... 4 cases: disabled / happy / cancel / banner
});
```

**Substitutions:**
- `useRecorderStore.setState({ status: "recording" })` → seed `authorDriverStore` (if used) or `simulatorStore` + mocked Channel state projection.
- `mockIPC` route `picker_start` → route `picker_start_author`.

**Additional cases** for D-13/D-14/D-15 (author-driver exclusion):
- Button disabled when `AuthorDriverState::SimulatorRunning`.
- Click-through when `SimulatorPaused` (Pick allowed per D-14).
- Tooltip copy per state (UI-SPEC §Per-state tooltips).

---

### `apps/desktop/src/features/editor/preview-panel.tsx` (EXTEND — mount button)

**Analog:** itself. Mount inside the header flex container at lines 47–80.

**Mount pattern:**
```tsx
// preview-panel.tsx:47 (header)
<header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-1.5">
  <div className="flex items-center gap-2">
    <PreviewPickerButton />   {/* ← NEW, left of scene label */}
    <span className="text-[11px] ...">Preview</span>
  </div>
  <div className="flex items-center gap-3">
    {/* existing viewport selector + quality selector */}
  </div>
</header>
```
UI-SPEC §Visual Layout locates the button **left** of viewport/quality controls.

**Picking banner** — render between header and preview stage (UI-SPEC §Picking banner position):
```tsx
{picking && <PickingBanner variant={...} />}  // below <header>, above stage div
```

---

### `apps/desktop/src/features/editor/codemirror-setup.ts` (EXTEND — Cmd-Shift-P keymap)

**Analog:** itself. Current file has no keymap block (Phase 10-03 Task 4a will add `Cmd-.`). Phase 11 adds `Cmd-Shift-P` to the same keymap import.

**Pattern (follows CM6 convention):**
```ts
import { keymap } from "@codemirror/view";
// ...
keymap.of([
  { key: "Cmd-.", mac: "Cmd-.", run: runPreviewToHere },            // Phase 10-03
  { key: "Cmd-Shift-P", mac: "Cmd-Shift-P", run: triggerPickFromEditor }, // Phase 11
]),
```

Do NOT use `document.addEventListener('keydown')` (research anti-pattern; UI-SPEC §6).

---

### `apps/desktop/src/ipc/picker.ts` (EXTEND — add `pickElementAuthor`)

**Analog:** itself. Copy the exact shape of `pickElement` (lines 60–70) and `pickerStampStepId` (lines 154–163).

**New wrapper pattern:**
```ts
export async function pickElementAuthor(
  opts: { streamId: string; cursorLine: number; timeoutMs?: number },
): Promise<PickResult> {
  const dto = await invoke<PickerStartDto>("picker_start_author", {
    streamId: opts.streamId,
    cursorLine: opts.cursorLine,
    timeoutMs: opts.timeoutMs ?? 60000,
  });
  return JSON.parse(dto.json) as PickResult;
}
```

`PickResult`, `isPicked`, `TargetRecordDto`, `pickerStampStepId`, `listenPickerHoverPreview`, `pickElementCancel` all reused verbatim — same wire contract.

---

### `scripts/playwright-sidecar/server.mjs` (EXTEND — streamId routing)

**Analog:** itself. Two precedents in-file:
1. `pickElement.start` at lines 665–778 (hard-wires `const page = state.page`).
2. `captureSnapshot` at lines 582–638 — **already branches into a separate `state.authorContext`-owned page**. This is the "route to a different page" precedent.

**Current (pickElement.start:681):**
```js
const page = state.page;
```

**Phase 11 replacement (matches research Example 1):**
```js
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
  const url = page.url() || '';
  if (/^(chrome|about|view-source):/i.test(url)) {
    return { cancelled: true, reason: 'unsupported-url' };
  }
  // ... rest unchanged; all uses of `state.page` → `page`
},
```

**Per-page binding bookkeeping — already handled correctly** via `state.pickerBoundPages = new WeakSet()` (server.mjs:97) and `state.pickerHoverBoundPages` (line 102). WeakSet accepts any `Page` reference; no change needed.

**Pitfall 3 naming:** do NOT reuse `state.authorBrowser` / `state.authorContext` (those are the Phase 7 snapshot browser). The Phase 9-04 map MUST be a new field like `state.previewPagesByStreamId`. If Phase 9-04 lands with a different name, update here.

**Pitfall 4 sequencing:** the host's `picker_start_author` must `await` navigate-replay + `waitForLoadState('networkidle')` BEFORE invoking `pickElement.start`, so `framenavigated` auto-cancel doesn't fire immediately. No sidecar change needed if sequencing is enforced in Rust.

---

### `apps/desktop/src/features/recorder/recording-view.tsx` (EDIT — delete 3 spots)

**Analog:** itself.

1. Line 45: `import { PickElementButton } from "./pick-element-button";` — **delete**.
2. Line 704 (inside `status === "recording"` branch): `<PickElementButton />` — **delete**.
3. Lines 702–704 comment: `{/* pick element while a Playwright session is live. */}` — **delete**.

No banner block exists in recording-view.tsx (banner is inside PickElementButton's render via `createPortal`); deletion of the import + mount is sufficient. All other recorder controls (Pause, Stop) remain.

---

## Shared Patterns

### Pattern A: Tauri command + specta + `AppError::Automation`

**Source:** `apps/desktop/src-tauri/src/commands/picker.rs:84-102` + `author_snapshot.rs:120-174`
**Apply to:** `picker_start_author`, `author_driver_state` (if Channel<T> deferred), any new Tauri command in Phase 11

```rust
#[tauri::command]
#[specta::specta]
pub async fn <name>(
    state: State<'_, AppState>,
    /* other tauri::State args */,
    /* serializable args */,
) -> Result<DtoType, AppError> {
    // 1. Acquire locks in scopes; release before awaits
    // 2. Map errors via .map_err(|e| AppError::Automation(e.to_string()))
    // 3. Return DTO from Into<DtoType>
}
```

### Pattern B: Zustand store (if `authorDriverStore` materializes)

**Source:** `apps/desktop/src/features/editor/dryRunStore.ts` (full file — 130 lines)
**Apply to:** `authorDriverStore.ts` (if research Q2 resolves in favor of a Zustand projection rather than Channel<T>)

```ts
import { create } from "zustand";

export interface AuthorDriverStore {
  state: "idle" | "live-preview" | "picking" | "simulator-running" | "simulator-paused";
  streamId: string | null;
  // actions
  handleEvent: (ev: AuthorDriverEvent) => void;
  reset: () => void;
}
```
**However:** RESEARCH recommends **Channel<T>** over Zustand (avoids two sources of truth). Plan should default to Channel unless it's too heavy.

### Pattern C: IPC wrapper + typed DTO + JSON-string unwrap

**Source:** `apps/desktop/src/ipc/picker.ts:53-70`
**Apply to:** `pickElementAuthor` in picker.ts

```ts
interface XxxDto { json: string; }
export async function xxx(opts): Promise<TypedResult> {
  const dto = await invoke<XxxDto>("cmd_name", { /* args */ });
  return JSON.parse(dto.json) as TypedResult;
}
```
Rationale (existing comment at picker.ts:52): "The Rust enum is `#[serde(untagged)]` so the inner JSON shape IS the typed union — no DTO-to-domain mapping required."

### Pattern D: vitest with `mockIPC` + `editorController` spy + `emit()` for events

**Source:** `apps/desktop/src/features/recorder/pick-element-button.test.tsx:18-54` + full file
**Apply to:** `PreviewPickerButton.test.tsx`

Three fixture pieces to reuse:
1. `vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success, error, info, warning }) }))`
2. `vi.spyOn(editorController, "insertAtCursor").mockReturnValue({ ok: true, lineNumber: 1 })`
3. `mockIPC((cmd, args) => { if (cmd === "picker_start_author") return { json: JSON.stringify({...}) }; })`

### Pattern E: State-mgmt registration in `lib.rs`

**Source:** `apps/desktop/src-tauri/src/lib.rs:134-147`
**Apply to:** `AuthorDriverRegistry`

```rust
app.manage(commands::author_driver::AuthorDriverRegistry::default());
```
Place alphabetically between existing `.manage(...)` calls; `commands::mod.rs` must declare `pub mod author_driver;`.

### Pattern F: `generate_handler![...]` wiring

**Source:** pattern visible in lib.rs (grep `generate_handler`); Phase 10-02 plan line 431.
**Apply to:** Add `picker_start_author` (and any new command) to `tauri::generate_handler![..., commands::picker::picker_start_author, ...]`.

### Pattern G: Path-traversal guard

**Source:** `apps/desktop/src-tauri/src/commands/picker.rs:190-194` + `author_snapshot.rs:93-106`
**Apply to:** Any Phase 11 command accepting a filesystem path

```rust
if path.split(['/', '\\']).any(|seg| seg == "..") {
    return Err(AppError::Automation("path traversal rejected: ...".into()));
}
```
Sidecar-side streamId validation (V5 ASVS per RESEARCH §Security Domain):
```js
if (streamId && !state.previewPagesByStreamId?.has(streamId)) {
  throw Object.assign(new Error('unknown streamId'), { code: -32000 });
}
```
Do NOT fall through to `state.page` on unknown streamId.

---

## No Analog Found

| File | Reason |
|------|--------|
| `author_driver.rs` Drop guard (`PickerResumeGuard`) | `grep "impl Drop for"` in src-tauri returns no matches. This is net-new Rust idiom in this codebase. Use RESEARCH Pattern 1 + Pitfall 2 mitigation (`Handle::try_current()`) verbatim. |
| `replay_navigate_verbs` helper | No existing navigate-only AST walker in src-tauri. Follow RESEARCH Pattern 2 (scan `story.scenes[*].commands[*]` for `Command::Navigate`, filter by `meta().line <= cursor_line`). |
| `Channel<AuthorDriverState>` frontend stream | Phase 10-02 plan line 347 documents `channel: Channel<SimulatorEvent>` — follow that shape when it lands. Until then, consider Zustand projection (Pattern B). |

---

## Metadata

**Analog search scope:** `apps/desktop/src-tauri/src/**`, `apps/desktop/src/features/{editor,recorder}/**`, `apps/desktop/src/ipc/**`, `scripts/playwright-sidecar/*.mjs`, `.planning/phases/10-.../10-02-PLAN.md`.
**Files scanned:** 14 read, 5 grep-only.
**Key architectural insight:** Phase 11 has an in-tree analog for **every** component. The only net-new logic is (1) the 5-state FSM enum body, (2) the RAII Drop guard, (3) the navigate-only AST walker. Everything else is exact pattern copy + substitution. Planner should resist redesign — stay close to Phase 7 picker behavior + Phase 10 registry shape.
