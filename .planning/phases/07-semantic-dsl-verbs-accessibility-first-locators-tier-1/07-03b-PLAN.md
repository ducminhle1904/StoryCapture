---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 03b
type: execute
wave: 4
depends_on:
  - 07-03a
files_modified:
  - crates/automation/src/playwright_driver.rs
  - apps/desktop/src/features/editor/controller.ts
  - apps/desktop/src/features/editor/controller.test.ts
  - apps/desktop/src/features/editor/story-editor.tsx
  - apps/desktop/src/features/recorder/pick-element-button.tsx
  - apps/desktop/src/features/recorder/pick-element-button.test.tsx
  - apps/desktop/src/features/recorder/recording-view.tsx
  - apps/desktop/src/ipc/picker.ts
  - apps/desktop/src-tauri/src/commands/picker.rs
  - apps/desktop/src-tauri/src/commands/mod.rs
  - apps/desktop/src-tauri/src/lib.rs
autonomous: true
requirements:
  - PHASE-7.4
tags: dsl, picker, codemirror, tauri-ipc, desktop-ui
must_haves:
  truths:
    - "User clicks the 'Pick element' button in the recording view so the Playwright-controlled page enters PICKING mode with a visible top-of-page banner (aria-live='polite') reading 'PICKING - press Esc to cancel'"
    - "User clicks a DOM element so the sidecar emits its pickElement.start response and editorController inserts the `result.emitted` DSL line at the CodeMirror cursor in ONE view.dispatch (single undo step)"
    - "Rust PickElementResponse.Picked variant field is literally named `emitted: String`, matching the sidecar wire contract (07-03a)"
    - "Pick button is disabled unless a sidecar launch() has succeeded (live recording session)"
    - "User presses Esc from the desktop window while PICKING so the Tauri command calls picker_cancel and the sidecar returns user-cancel; no DSL is inserted"
    - "Desktop vitest with @tauri-apps/api/mocks asserts editorController.insertAtCursor is called with exactly `result.emitted + '\\n'` — proving 07-03a→07-03b wire contract works end-to-end"
    - "cargo test PickElementResponse serde round-trips covers testid, role-object-value, cancelled navigation, cancelled user-cancel, and cancelled unsupported-url"
    - "editorController is a module-level singleton (NOT Zustand); single view.dispatch with userEvent: 'input.pick' guarantees single-undo atomicity"
  artifacts:
    - path: "crates/automation/src/playwright_driver.rs"
      provides: "PickElementResponse enum (Picked { emitted: String, locator, candidates } | Cancelled { reason }); pick_element_start/cancel/is_active RPC wrappers"
      contains: "emitted: String"
    - path: "apps/desktop/src/features/editor/controller.ts"
      provides: "editorController module-level singleton: setView(view), clearView(), insertAtCursor(text), isReady()"
      contains: "export const editorController"
    - path: "apps/desktop/src/features/recorder/pick-element-button.tsx"
      provides: "React component wrapping the pickElement.start flow + banner + Esc handler; consumes result.emitted"
      contains: "PickElementButton"
    - path: "apps/desktop/src-tauri/src/commands/picker.rs"
      provides: "Tauri commands: picker_start, picker_cancel, picker_is_active which route to PlaywrightSidecarDriver"
      contains: "picker_start"
    - path: "apps/desktop/src/ipc/picker.ts"
      provides: "TS wrappers over invoke('picker_*') with typed PickResult / PickCandidate exposing the `emitted` field"
      contains: "emitted"
  key_links:
    - from: "PickElementButton onClick"
      to: "apps/desktop/src/ipc/picker.ts pickElement()"
      via: "Tauri invoke('picker_start')"
      pattern: "invoke\\(\"picker_start\""
    - from: "picker.rs picker_start command"
      to: "PlaywrightSidecarDriver::pick_element_start"
      via: "AppState-held driver handle"
      pattern: "pick_element_start"
    - from: "PlaywrightSidecarDriver::pick_element_start"
      to: "sidecar JSON-RPC method pickElement.start (07-03a)"
      via: "call('pickElement.start', params) returning { emitted, locator, candidates }"
      pattern: "pickElement.start"
    - from: "pick_element_start Rust return PickElementResponse::Picked"
      to: "editorController.insertAtCursor"
      via: "PickElementButton awaits result, inserts `result.emitted + '\\n'`"
      pattern: "insertAtCursor"
---

<objective>
Ship the desktop side of the Tier 2 MVP: Rust driver wrappers + Tauri commands + TS IPC + `editorController` singleton + `PickElementButton` + aria-live banner + desktop vitest. All inputs come from 07-03a's sidecar wire contract (`result.emitted`).

Purpose: Close the picker loop from the sidecar's emitted DSL line to the CodeMirror editor cursor. On successful pick, the desktop inserts `result.emitted + "\n"` at the cursor in exactly one undo-atomic dispatch.

Output: `PickElementResponse::Picked { emitted: String, locator, candidates }` Rust enum (field is literally `emitted` — matches sidecar wire field); `pick_element_start/cancel/is_active` driver methods; Tauri commands `picker_start/cancel/is_active`; TS IPC wrappers; `editorController` singleton wired into `StoryEditor`; `PickElementButton` component + aria-live banner + desktop Esc handler; vitest proving insertion with `@tauri-apps/api/mocks`.
</objective>

<scope>
**EXPLICITLY IN SCOPE:**
- Rust driver wrappers + serde round-trip tests on `PickElementResponse`.
- Tauri commands routing to AppState-held driver.
- TS IPC typed wrappers.
- `editorController` singleton with snap-to-line-end + single-dispatch semantics.
- `PickElementButton` with portal banner, disabled-when-not-live, desktop Esc.
- Vitest with Tauri mocks proving the full wire flow (mock invoke returns `{emitted: '...'}` → `editorController.insertAtCursor` called with `emitted + '\n'`).
- Full regression on existing desktop + automation test suites.
- Manual smoke runbook at `07-03b-SMOKE.md`.

**EXPLICITLY OUT OF SCOPE:**
- Sidecar-side overlay, handlers, generator (07-03a — dependency).
- `pickElement.hoverPreview` notifications and preview chip (07-04a).
- Step-id comment + formatter (07-04b).
- `.story.targets.json` self-healing (07-04c).
</scope>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-RESEARCH-TIER2.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-03a-SUMMARY.md
@CLAUDE.md

@crates/automation/src/playwright_driver.rs
@apps/desktop/src/features/editor/story-editor.tsx
@apps/desktop/src/features/recorder/recording-view.tsx

<interfaces>
<!-- Wire contract from 07-03a — sidecar pickElement.start response shape: -->
<!--   { emitted: string, locator: { kind, value }, candidates: Array<{kind, value, score, unique}> } -->
<!--   OR { cancelled: true, reason: 'user-cancel' | 'navigation' | 'unsupported-url' | 'timeout' } -->
<!-- Rust struct `PickElementResponse::Picked` field MUST be named `emitted: String`, NOT `dsl_line` or alternatives. -->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Rust driver wrappers + Tauri commands + IPC types (pick_element_start / cancel / is_active)</name>
  <files>crates/automation/src/playwright_driver.rs, apps/desktop/src-tauri/src/commands/picker.rs, apps/desktop/src-tauri/src/commands/mod.rs, apps/desktop/src-tauri/src/lib.rs, apps/desktop/src/ipc/picker.ts</files>
  <read_first>
    - crates/automation/src/playwright_driver.rs (existing `call(method, params)` + `browser_process` for wrapper pattern)
    - apps/desktop/src-tauri/src/commands/ (existing command modules — follow their AppState + error pattern)
    - apps/desktop/src-tauri/src/lib.rs (invoke_handler! registration point)
    - apps/desktop/src/ipc/automation.ts or similar (existing Tauri invoke wrapper patterns + type generation via tauri-specta)
    - 07-03a-SUMMARY.md (sidecar wire contract)
  </read_first>
  <behavior>
    - `PlaywrightSidecarDriver::pick_element_start(timeout_ms) -> Result<PickElementResponse>` dispatches JSON-RPC `pickElement.start` and deserializes the response.
    - `PickElementResponse` is a serde-tagged enum: `Picked { emitted: String, locator: PickLocator, candidates: Vec<PickCandidate> }` or `Cancelled { cancelled: bool, reason: String }`.
    - **CRITICAL:** The `Picked` variant's field name must be literally `emitted: String` — NOT `dsl_line`, `line`, or any other alias. This matches the sidecar's wire field and prevents drift with 07-03a.
    - `PickLocator` is `{ kind: String, value: serde_json::Value }` — `value` is either a string (for testid/selector/label/text_exact) or an object `{ role, name }` (for role).
    - `PickCandidate` is `{ kind: String, value: Value, score: f64, unique: bool }`.
    - Tauri commands `picker_start`, `picker_cancel`, `picker_is_active` forward to the driver held in AppState (the same handle already used by Plan 01-06 automation commands).
    - TS wrapper `pickElement()` in `apps/desktop/src/ipc/picker.ts` calls `invoke("picker_start", { timeoutMs })` and returns a typed union `PickResult = Picked | Cancelled` where `Picked` exposes `emitted: string`.
  </behavior>
  <action>
1. **Edit `crates/automation/src/playwright_driver.rs`.** At the bottom of the `impl PlaywrightSidecarDriver` block (next to `browser_process`), add:
   ```rust
   #[derive(Debug, Clone, Serialize, Deserialize)]
   #[serde(untagged)]
   pub enum PickElementResponse {
       Picked {
           // CONTRACT: field name `emitted` matches sidecar wire field (07-03a server.mjs).
           // Do not rename — drift breaks the picker UI flow.
           emitted: String,
           locator: PickLocator,
           candidates: Vec<PickCandidate>,
       },
       Cancelled {
           cancelled: bool,  // always true in this arm; kept so serde_untagged disambiguates
           reason: String,
       },
   }

   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub struct PickLocator {
       pub kind: String,
       pub value: serde_json::Value,  // string OR { role, name }
   }

   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub struct PickCandidate {
       pub kind: String,
       pub value: serde_json::Value,
       pub score: f64,
       #[serde(default)]
       pub unique: bool,
   }

   impl PlaywrightSidecarDriver {
       pub async fn pick_element_start(&self, timeout_ms: u64) -> Result<PickElementResponse> {
           let v = self.call("pickElement.start", serde_json::json!({ "timeoutMs": timeout_ms })).await?;
           serde_json::from_value(v)
               .map_err(|e| AutomationError::Protocol(format!("pickElement.start decode: {e}")))
       }

       pub async fn pick_element_cancel(&self) -> Result<()> {
           self.call("pickElement.cancel", serde_json::json!({})).await?;
           Ok(())
       }

       pub async fn pick_element_is_active(&self) -> Result<bool> {
           let v = self.call("pickElement.isActive", serde_json::json!({})).await?;
           Ok(v.get("active").and_then(|a| a.as_bool()).unwrap_or(false))
       }
   }
   ```

2. **Add unit tests** for `PickElementResponse` serde round-trips (5 tests):
   ```rust
   #[cfg(test)]
   mod pick_element_serde_tests {
       use super::*;
       #[test]
       fn picked_response_deserializes_testid() {
           let json = serde_json::json!({
               "emitted": "click testid \"save\"",
               "locator": { "kind": "testid", "value": "save" },
               "candidates": [{ "kind": "testid", "value": "save", "score": 1.0, "unique": true }]
           });
           let r: PickElementResponse = serde_json::from_value(json).unwrap();
           match r {
               PickElementResponse::Picked { emitted, locator, candidates } => {
                   assert_eq!(emitted, "click testid \"save\"");
                   assert_eq!(locator.kind, "testid");
                   assert_eq!(candidates.len(), 1);
               }
               _ => panic!("expected Picked"),
           }
       }

       #[test]
       fn picked_response_deserializes_role_object_value() {
           let json = serde_json::json!({
               "emitted": "click button \"Save\"",
               "locator": { "kind": "role", "value": { "role": "button", "name": "Save" } },
               "candidates": []
           });
           let r: PickElementResponse = serde_json::from_value(json).unwrap();
           match r {
               PickElementResponse::Picked { locator, .. } => {
                   assert_eq!(locator.value["role"], "button");
                   assert_eq!(locator.value["name"], "Save");
               }
               _ => panic!("expected Picked"),
           }
       }

       #[test]
       fn cancelled_navigation() {
           let json = serde_json::json!({ "cancelled": true, "reason": "navigation" });
           let r: PickElementResponse = serde_json::from_value(json).unwrap();
           assert!(matches!(r, PickElementResponse::Cancelled { reason, .. } if reason == "navigation"));
       }

       #[test]
       fn cancelled_user() {
           let json = serde_json::json!({ "cancelled": true, "reason": "user-cancel" });
           let r: PickElementResponse = serde_json::from_value(json).unwrap();
           assert!(matches!(r, PickElementResponse::Cancelled { reason, .. } if reason == "user-cancel"));
       }

       #[test]
       fn cancelled_unsupported_url() {
           let json = serde_json::json!({ "cancelled": true, "reason": "unsupported-url" });
           let r: PickElementResponse = serde_json::from_value(json).unwrap();
           assert!(matches!(r, PickElementResponse::Cancelled { reason, .. } if reason == "unsupported-url"));
       }
   }
   ```

3. **Create `apps/desktop/src-tauri/src/commands/picker.rs`** following the existing command pattern (inspect `commands/automation.rs` or similar for AppState + error handling). Skeleton:
   ```rust
   use automation::playwright_driver::{PickElementResponse, PlaywrightSidecarDriver};
   use tauri::State;
   // Use the same AppState type that hosts the driver (already established in Plan 01-06).
   use crate::AppState;

   #[tauri::command]
   #[specta::specta]
   pub async fn picker_start(
       state: State<'_, AppState>,
       timeout_ms: u64,
   ) -> Result<PickElementResponse, String> {
       let driver = state.driver.lock().await;
       let d = driver.as_ref().ok_or_else(|| "sidecar not launched".to_string())?;
       d.pick_element_start(timeout_ms).await.map_err(|e| e.to_string())
   }

   #[tauri::command]
   #[specta::specta]
   pub async fn picker_cancel(state: State<'_, AppState>) -> Result<(), String> {
       let driver = state.driver.lock().await;
       let d = driver.as_ref().ok_or_else(|| "sidecar not launched".to_string())?;
       d.pick_element_cancel().await.map_err(|e| e.to_string())
   }

   #[tauri::command]
   #[specta::specta]
   pub async fn picker_is_active(state: State<'_, AppState>) -> Result<bool, String> {
       let driver = state.driver.lock().await;
       match driver.as_ref() {
           Some(d) => d.pick_element_is_active().await.map_err(|e| e.to_string()),
           None => Ok(false),
       }
   }
   ```
   Adjust `AppState` field access to match the actual name used by existing automation commands. If `state.driver` does not exist verbatim, use whatever handle is already present (e.g. `state.automation_driver`) — do not fabricate a new field.

4. **Register commands** in `apps/desktop/src-tauri/src/commands/mod.rs` (add `pub mod picker;`) and in `apps/desktop/src-tauri/src/lib.rs` `invoke_handler!` list (add `commands::picker::picker_start, commands::picker::picker_cancel, commands::picker::picker_is_active`). Also register the specta types emitted by `#[specta::specta]` — follow the existing specta registration pattern for this codebase.

5. **Create `apps/desktop/src/ipc/picker.ts`:**
   ```ts
   import { invoke } from "@tauri-apps/api/core";

   export type PickLocator = { kind: string; value: string | { role: string; name: string } };
   export type PickCandidate = { kind: string; value: unknown; score: number; unique: boolean };
   export type PickPicked = { emitted: string; locator: PickLocator; candidates: PickCandidate[] };
   export type PickCancelled = { cancelled: true; reason: "user-cancel" | "navigation" | "timeout" | "unsupported-url" | string };
   export type PickResult = PickPicked | PickCancelled;

   export function isPicked(r: PickResult): r is PickPicked {
     return "emitted" in r;
   }

   export async function pickElement(opts: { timeoutMs?: number } = {}): Promise<PickResult> {
     return await invoke<PickResult>("picker_start", { timeoutMs: opts.timeoutMs ?? 60000 });
   }

   export async function pickElementCancel(): Promise<void> {
     await invoke("picker_cancel");
   }

   export async function pickElementIsActive(): Promise<boolean> {
     return await invoke<boolean>("picker_is_active");
   }
   ```

   Prefer tauri-specta generated types if the codebase regenerates them from the `#[specta::specta]` annotations — in that case, import from the generated module instead of redeclaring here. Check `apps/desktop/src/ipc/` for the existing pattern.
  </action>
  <verify>
    <automated>cargo build -p automation 2>&1 | tail -5 && cargo test -p automation --lib -- pick_element_serde_tests 2>&1 | tail -10 && cd apps/desktop/src-tauri && cargo check 2>&1 | tail -10 && cd - && grep -n "pick_element_start" crates/automation/src/playwright_driver.rs && grep -n "pub async fn pick_element_cancel" crates/automation/src/playwright_driver.rs && grep -n "enum PickElementResponse" crates/automation/src/playwright_driver.rs && grep -c "emitted: String" crates/automation/src/playwright_driver.rs && grep -c "emitted" crates/automation/src/playwright_driver.rs && grep -n "picker_start" apps/desktop/src-tauri/src/commands/picker.rs && grep -n "pub mod picker" apps/desktop/src-tauri/src/commands/mod.rs && grep -n "picker_start" apps/desktop/src-tauri/src/lib.rs && grep -n "pickElement" apps/desktop/src/ipc/picker.ts && grep -n "isPicked" apps/desktop/src/ipc/picker.ts</automated>
  </verify>
  <acceptance_criteria>
    - `cargo build -p automation` exits 0
    - `cargo test -p automation --lib -- pick_element_serde_tests` passes all 5 serde round-trip tests
    - `cargo check` inside `apps/desktop/src-tauri/` exits 0
    - **Wire-contract guard:** `grep -n "emitted" crates/automation/src/playwright_driver.rs` returns ≥1 hit; the `PickElementResponse::Picked` variant has a field literally named `emitted: String` (NOT `dsl_line`, `line`, or any alias). Asserted via `grep -c "emitted: String" crates/automation/src/playwright_driver.rs` ≥ 1.
    - `grep -c "pick_element_start" crates/automation/src/playwright_driver.rs` ≥ 2 (definition + test)
    - `grep -n "PickElementResponse" crates/automation/src/playwright_driver.rs` matches the enum def + at least one test reference
    - `grep -n "picker_start\|picker_cancel\|picker_is_active" apps/desktop/src-tauri/src/commands/picker.rs | wc -l` ≥ 3 (all three commands defined)
    - `grep -n "picker_start" apps/desktop/src-tauri/src/lib.rs` matches (registered in invoke_handler)
    - `grep -n "pickElement\|pickElementCancel\|pickElementIsActive" apps/desktop/src/ipc/picker.ts | wc -l` ≥ 3
    - `grep -n "isPicked" apps/desktop/src/ipc/picker.ts` matches (type guard helper)
  </acceptance_criteria>
  <done>Rust driver wrappers + Tauri commands + IPC TS wrappers committed; serde round-trip tests cover all four response shapes (testid, role-object-value, cancelled-nav, cancelled-user, unsupported-url); Tauri commands route to the same AppState-held driver used by Plan 01-06; `emitted: String` wire-field guarded in place.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: editorController singleton + StoryEditor wire-up + desktop vitest (single-undo assertion)</name>
  <files>apps/desktop/src/features/editor/controller.ts, apps/desktop/src/features/editor/controller.test.ts, apps/desktop/src/features/editor/story-editor.tsx</files>
  <read_first>
    - apps/desktop/src/features/editor/story-editor.tsx (current cmRef pattern — see line 29)
    - apps/desktop/src/features/editor/codemirror-setup.ts (extensions — to understand doc.length semantics)
    - .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md §editorController §Insertion semantics
  </read_first>
  <behavior>
    - `editorController` is a module-level singleton object (NOT Zustand). API: `setView(view: EditorView | null)`, `clearView()`, `isReady(): boolean`, `insertAtCursor(text: string): { ok: true } | { ok: false, reason: string }`.
    - `insertAtCursor` with `isReady() === false` returns `{ ok: false, reason: "no-view" }` without throwing.
    - `insertAtCursor` issues ONE `view.dispatch({ changes, selection, userEvent: "input.pick" })` — atomic on the undo stack.
    - If the cursor is mid-line (not at line-end), insertion snaps to the line-end of the current line BEFORE inserting. The `\n` is appended by the caller, not by the controller.
    - After insert, the cursor sits at `from + text.length`.
    - Undo test: construct a fresh `EditorView`, set initial doc `"line1\nline2"`, position cursor at offset 0, call `insertAtCursor("click button \"Save\"\n")`, run `undo()`, assert doc returns EXACTLY to `"line1\nline2"` — single undo entry.
  </behavior>
  <action>
1. **Create `apps/desktop/src/features/editor/controller.ts`:**
   ```ts
   import type { EditorView } from "@codemirror/view";

   // Module-level singleton — NOT a React context, NOT Zustand. React refs in
   // Zustand are an anti-pattern (they don't trigger re-renders and add noise
   // to the store surface). This module is the seam.

   let currentView: EditorView | null = null;

   export const editorController = {
     setView(view: EditorView | null) {
       currentView = view;
     },
     clearView() {
       currentView = null;
     },
     isReady(): boolean {
       return currentView !== null;
     },
     insertAtCursor(text: string): { ok: true } | { ok: false; reason: "no-view" } {
       const v = currentView;
       if (!v) return { ok: false, reason: "no-view" };

       const sel = v.state.selection.main;
       const line = v.state.doc.lineAt(sel.head);
       // Snap mid-line cursors to line-end before insertion (per CONTEXT.md).
       const from = sel.head === line.to ? sel.head : line.to;

       v.dispatch({
         changes: { from, insert: text },
         selection: { anchor: from + text.length },
         userEvent: "input.pick",
       });
       v.focus();
       return { ok: true };
     },
   };

   export type EditorController = typeof editorController;
   ```

2. **Wire `StoryEditor`** in `apps/desktop/src/features/editor/story-editor.tsx`. Add a new `useEffect` that registers the view on mount and clears on unmount:
   ```tsx
   import { editorController } from "./controller";
   // ... inside StoryEditor:
   useEffect(() => {
     editorController.setView(cmRef.current?.view ?? null);
     return () => { editorController.clearView(); };
   }, [cmRef.current?.view]);
   ```
   Place this after the existing `jumpTarget` effect. Do not mutate any other behavior.

3. **Create `apps/desktop/src/features/editor/controller.test.ts`** — vitest. 5 tests as in original 07-03 Task 5: isReady() false when no view; insertAtCursor returns { ok: false, reason: "no-view" } when no view; snap-to-line-end positive case with fresh EditorView and initial doc "abc\ndef" cursor at 0 (insert lands at offset 3); undo returns doc to original proving SINGLE undo entry; two consecutive inserts + one undo undoes only the last.

   Use `@codemirror/state` + `@codemirror/view` + `@codemirror/commands` (for `undo`) to construct a test `EditorView` with a minimal DOM stub. Example bootstrap:
   ```ts
   import { EditorState } from "@codemirror/state";
   import { EditorView } from "@codemirror/view";
   import { undo, history, historyKeymap } from "@codemirror/commands";
   import { keymap } from "@codemirror/view";
   import { editorController } from "./controller";

   function makeView(doc = "abc\ndef") {
     const state = EditorState.create({
       doc,
       extensions: [history(), keymap.of(historyKeymap)],
     });
     const dom = document.createElement("div");
     return new EditorView({ state, parent: dom });
   }
   ```

   Add `// @vitest-environment jsdom` header so `document` exists.

4. **Acceptance gate:** `pnpm --filter @storycapture/desktop test -- controller.test.ts` exits 0, and all 5 tests green.
  </action>
  <verify>
    <automated>cd apps/desktop && (pnpm test -- controller.test.ts 2>&1 | tee /tmp/t7-03b-t2.log; grep -E "(passed|failed|Tests)" /tmp/t7-03b-t2.log | tail -5) && cd - && test -f apps/desktop/src/features/editor/controller.ts && grep -n "export const editorController" apps/desktop/src/features/editor/controller.ts && grep -n "userEvent: \"input.pick\"" apps/desktop/src/features/editor/controller.ts && grep -n "editorController.setView" apps/desktop/src/features/editor/story-editor.tsx && grep -n "editorController.clearView" apps/desktop/src/features/editor/story-editor.tsx</automated>
  </verify>
  <acceptance_criteria>
    - `apps/desktop/src/features/editor/controller.ts` exists and exports `editorController`
    - `grep -n "userEvent: \"input.pick\"" apps/desktop/src/features/editor/controller.ts` matches (atomic-undo marker)
    - `grep -n "line.to" apps/desktop/src/features/editor/controller.ts` matches (snap-to-line-end logic)
    - `grep -n "editorController.setView" apps/desktop/src/features/editor/story-editor.tsx` matches (wired on mount)
    - `grep -n "editorController.clearView" apps/desktop/src/features/editor/story-editor.tsx` matches (cleared on unmount)
    - `pnpm --filter @storycapture/desktop test -- controller.test.ts` passes all 5 tests
    - Undo test explicitly asserts `view.state.doc.toString() === originalDoc` after one `undo(view)` call post-insert
  </acceptance_criteria>
  <done>editorController module-level singleton committed with snap-to-line-end + single-dispatch atomic insertion; StoryEditor wires the CodeMirror view on mount and clears on unmount; 5 vitest assertions green including the single-undo atomicity proof.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: PickElementButton + picking banner + recording-view wiring + desktop vitest with Tauri mocks + regression</name>
  <files>apps/desktop/src/features/recorder/pick-element-button.tsx, apps/desktop/src/features/recorder/recording-view.tsx, apps/desktop/src/features/recorder/pick-element-button.test.tsx</files>
  <read_first>
    - apps/desktop/src/features/recorder/recording-view.tsx (imports + current toolbar structure)
    - apps/desktop/src/ipc/picker.ts (Task 1 output)
    - apps/desktop/src/features/editor/controller.ts (Task 2 output)
    - apps/desktop/src/state/recorder.ts (how to detect live sidecar session — use existing status field)
  </read_first>
  <behavior>
    - `<PickElementButton />` renders a button labeled "Pick element" with a crosshair icon. Disabled when `recorder.status !== 'recording' && recorder.status !== 'idle-ready'` (i.e. when sidecar is not live) — use whichever status value(s) already indicate "Playwright session alive" in the recorder store.
    - On click: button becomes disabled, sets local state `picking = true`, renders a top-anchored banner (portal to `document.body`): `<div role="status" aria-live="polite">PICKING — press Esc to cancel</div>`, then calls `await pickElement({ timeoutMs: 60000 })`.
    - On result:
      - `isPicked(r) === true` → `editorController.insertAtCursor(r.emitted + "\n")`; toast `sonner.toast.success("Inserted: " + r.emitted)`; banner removed; picking=false
      - `r.cancelled === true` with reason 'user-cancel' → toast neutral "Picking cancelled"; banner removed; picking=false
      - `r.cancelled` with reason 'navigation' → toast `toast.info("Picking cancelled - page navigated")`
      - `r.cancelled` with reason 'unsupported-url' → toast `toast.warning("Cannot pick on this page (unsupported URL)")`
      - `r.cancelled` with reason 'timeout' → toast `toast.info("Picking timed out")`
    - While `picking === true`, a `keydown` listener on `document` for Escape calls `pickElementCancel()` (the overlay Esc works too, but desktop Esc is a secondary UX safety net).
    - Button is rendered in `recording-view.tsx`'s toolbar area (alongside Record/Stop). Wire with minimal churn — add a single import + one JSX element in the existing toolbar div.
    - Vitest with `@tauri-apps/api/mocks`:
      - Mock `invoke("picker_start", ...)` → `{ emitted: 'click button "Save"', locator: {...}, candidates: [] }`
      - Assert `editorController.insertAtCursor` was called with `'click button "Save"\n'` (use a spy) — this is the FINAL PROOF that the sidecar wire-contract `emitted` field propagates to the editor.
      - Mock `invoke("picker_start", ...)` → `{ cancelled: true, reason: "user-cancel" }` → assert controller NOT called
      - Assert banner renders + disappears correctly
  </behavior>
  <action>
1. **Create `apps/desktop/src/features/recorder/pick-element-button.tsx`:**
   ```tsx
   import { useEffect, useState } from "react";
   import { createPortal } from "react-dom";
   import { Crosshair } from "lucide-react";
   import { toast } from "sonner";

   import { pickElement, pickElementCancel, isPicked } from "@/ipc/picker";
   import { editorController } from "@/features/editor/controller";
   import { useRecorderStore } from "@/state/recorder";

   export function PickElementButton() {
     const status = useRecorderStore((s) => s.status);
     const [picking, setPicking] = useState(false);
     // Enabled whenever a sidecar session is live. Adjust the predicate to match
     // the recorder store's actual states.
     const sessionLive = status === "recording" || status === "idle-ready";

     useEffect(() => {
       if (!picking) return;
       const onKey = (e: KeyboardEvent) => {
         if (e.key === "Escape") { pickElementCancel().catch(() => {}); }
       };
       document.addEventListener("keydown", onKey);
       return () => document.removeEventListener("keydown", onKey);
     }, [picking]);

     const onClick = async () => {
       if (picking) return;
       setPicking(true);
       try {
         const r = await pickElement({ timeoutMs: 60000 });
         if (isPicked(r)) {
           const res = editorController.insertAtCursor(r.emitted + "\n");
           if (res.ok) toast.success(`Inserted: ${r.emitted}`);
           else toast.error("Editor not ready - focus the editor first");
         } else {
           switch (r.reason) {
             case "user-cancel": toast("Picking cancelled"); break;
             case "navigation":  toast.info("Picking cancelled - page navigated"); break;
             case "unsupported-url": toast.warning("Cannot pick on this page (unsupported URL)"); break;
             case "timeout": toast.info("Picking timed out"); break;
             default: toast(`Picking ended: ${r.reason}`);
           }
         }
       } catch (e: any) {
         toast.error(`Pick failed: ${e?.message ?? String(e)}`);
       } finally {
         setPicking(false);
       }
     };

     return (
       <>
         <button
           type="button"
           onClick={onClick}
           disabled={!sessionLive || picking}
           className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
           aria-label="Pick element from browser"
         >
           <Crosshair className="h-4 w-4" />
           Pick element
         </button>
         {picking && typeof document !== "undefined" && createPortal(
           <div
             role="status"
             aria-live="polite"
             className="fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-full bg-orange-500 px-4 py-1.5 text-sm font-medium text-white shadow-lg"
           >
             PICKING - press Esc to cancel
           </div>,
           document.body,
         )}
       </>
     );
   }
   ```

2. **Wire into `recording-view.tsx`.** Add the import and render the button in the existing toolbar. Look for the Record/Stop button area; insert `<PickElementButton />` adjacent. No other churn to the file — this is additive.

3. **Create `apps/desktop/src/features/recorder/pick-element-button.test.tsx`** — vitest + React Testing Library + `@tauri-apps/api/mocks`. Header: `// @vitest-environment jsdom`.

   4 tests:
   - Renders with disabled button when `recorder.status` is not live
   - Click → mocks `invoke("picker_start")` returning `{ emitted: 'click button "Save"', locator: {...}, candidates: [] }` → spy on `editorController.insertAtCursor` — **FINAL GATE:** assert called with `'click button "Save"\n'` (proves 07-03a `result.emitted` → 07-03b editor insertion wire contract holds end-to-end)
   - Click → mocks return `{ cancelled: true, reason: "user-cancel" }` → spy NOT called; toast displays neutral message
   - Click → banner with `role="status"` appears; after result resolves, banner disappears

   Use `clearMocks` from `@tauri-apps/api/mocks` in `afterEach`. Stub the recorder store with a `useRecorderStore.setState({ status: "idle-ready" })` call in `beforeEach`. Mock `sonner` toast to a vi.fn().

4. **Full regression suite.** After implementation, run:
   ```bash
   cargo test --workspace 2>&1 | tail -20
   pnpm test 2>&1 | tail -20
   ```
   Both must exit 0.

5. **Create `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-03b-SMOKE.md`** with the manual runbook (content same as original 07-03 Task 7): happy path against https://example.com, 4 cancellation paths (Esc from desktop, Esc from browser, Navigation, Unsupported URL), Undo smoke, Known limitations (closed shadow DOM, cross-origin iframes, headless mode).
  </action>
  <verify>
    <automated>cd apps/desktop && (pnpm test -- pick-element-button.test.tsx 2>&1 | tee /tmp/t7-03b-t3.log; grep -E "(passed|failed|Tests)" /tmp/t7-03b-t3.log | tail -5) && cd - && test -f apps/desktop/src/features/recorder/pick-element-button.tsx && grep -n "PickElementButton" apps/desktop/src/features/recorder/recording-view.tsx && grep -n "editorController.insertAtCursor" apps/desktop/src/features/recorder/pick-element-button.tsx && grep -n "r.emitted" apps/desktop/src/features/recorder/pick-element-button.tsx && grep -n "aria-live=\"polite\"" apps/desktop/src/features/recorder/pick-element-button.tsx && grep -n "PICKING" apps/desktop/src/features/recorder/pick-element-button.tsx && grep -n "pickElementCancel" apps/desktop/src/features/recorder/pick-element-button.tsx && cargo test --workspace 2>&1 | tail -10 && pnpm test 2>&1 | tail -10 && test -f .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-03b-SMOKE.md</automated>
  </verify>
  <acceptance_criteria>
    - `apps/desktop/src/features/recorder/pick-element-button.tsx` exists
    - `grep -n "PickElementButton" apps/desktop/src/features/recorder/recording-view.tsx` matches (mounted in the recording view)
    - `grep -n "editorController.insertAtCursor" apps/desktop/src/features/recorder/pick-element-button.tsx` matches (insertion path wired)
    - `grep -n "r.emitted" apps/desktop/src/features/recorder/pick-element-button.tsx` matches (consumes wire-contract field)
    - `grep -n "aria-live=\"polite\"" apps/desktop/src/features/recorder/pick-element-button.tsx` matches (WCAG 2.1 AA: banner announces state change)
    - `grep -n "PICKING" apps/desktop/src/features/recorder/pick-element-button.tsx` matches (banner copy)
    - `grep -n "pickElementCancel" apps/desktop/src/features/recorder/pick-element-button.tsx` matches (Esc-on-desktop safety net)
    - `pnpm --filter @storycapture/desktop test -- pick-element-button.test.tsx` passes all 4 vitest cases — including the explicit assertion `editorController.insertAtCursor` was called with `'click button "Save"\n'` (end-to-end wire-contract proof)
    - `cargo test --workspace` exits 0 (no regression)
    - `pnpm test` exits 0 at workspace root
    - `07-03b-SMOKE.md` committed with all cancellation paths + undo smoke
  </acceptance_criteria>
  <done>PickElementButton + banner + desktop Esc handler committed; wired into recording-view; 4 vitest cases prove happy path → editor insertion using `result.emitted + "\n"`, cancel path (no insert), banner aria-live behavior, and disabled-when-not-live state; full cargo + pnpm test suites green; PHASE-7.4 MVP ready for operator dogfood.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Sidecar JSON-RPC → Rust `pick_element_start` | Deserialized into `PickElementResponse`; untagged enum with explicit Cancelled/Picked variants; malformed JSON fails decode cleanly. |
| Rust → Tauri IPC | New `picker_*` commands take a `timeout_ms: u64` primitive and forward to the sidecar driver. No user-controlled selector strings are forwarded from the frontend. |
| Tauri → React | `PickResult` union is typed; `isPicked` type-guard ensures the UI never dereferences `emitted` on a cancelled response. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-03b-01 | Injection | `editorController.insertAtCursor` accepts arbitrary text from the sidecar's `emitted` field | mitigate | The sidecar's ranked generator (07-03a) escapes quotes + backslashes via `escapeDslString`. The text is inserted verbatim into CodeMirror as plain text (no eval, no innerHTML). CodeMirror's `view.dispatch` treats it as text. |
| T-07-03b-02 | Tampering | Tauri command could be invoked by renderer with bogus `timeout_ms` | accept | Bounded by `u64`; sidecar has its own `pickElement.start` timeout cap of 60s in practice; no persistent side-effects. |
| T-07-03b-03 | Information Disclosure | `editorController` is a module singleton — any code in the bundle can call `insertAtCursor` | accept | Bundle is signed + notarized (Plan 01-10); only in-app code can import the module. |
</threat_model>

<verification>
1. `cargo test --workspace` exits 0 (all Rust tests including new pick_element_serde_tests)
2. `pnpm --filter @storycapture/desktop test` exits 0 (controller + PickElementButton)
3. `pnpm test` exits 0 at workspace root
4. `grep -n "editorController" apps/desktop/src/features/editor/story-editor.tsx` matches (view wire-up)
5. `grep -n "PickElementButton" apps/desktop/src/features/recorder/recording-view.tsx` matches (mounted)
6. `grep -n "emitted: String" crates/automation/src/playwright_driver.rs` matches (wire-contract field name enforced)
7. `grep -n "emitted" crates/automation/src/playwright_driver.rs` ≥ 1 hit
8. `07-03b-SMOKE.md` committed
</verification>

<success_criteria>
- [ ] Rust wrappers `pick_element_start/cancel/is_active` + `PickElementResponse` (Picked { emitted: String, locator, candidates } | Cancelled) + 5 serde round-trip tests
- [ ] Tauri commands `picker_start/cancel/is_active` registered and routed to AppState driver
- [ ] TS IPC module `apps/desktop/src/ipc/picker.ts` with typed `PickResult` union + `isPicked` guard + 3 wrappers
- [ ] `editorController` singleton committed; StoryEditor wires view on mount; 5 vitest cases incl. single-undo atomicity proof
- [ ] `PickElementButton` + aria-live banner + desktop Esc handler + recording-view mount; 4 vitest cases with `@tauri-apps/api/mocks` proving insert + cancel paths — including the end-to-end gate: mock `result.emitted = 'click button "Save"'` → `editorController.insertAtCursor` called with `'click button "Save"\n'`
- [ ] Wire-contract field `emitted: String` enforced in `PickElementResponse::Picked` (not `dsl_line`)
- [ ] MVP scope discipline: NO hoverPreview, NO `.story.targets.json`, NO step-id round-trip — all deferred to 07-04a/04b/04c
- [ ] `07-03b-SMOKE.md` committed with cancellation paths + undo smoke + known limitations
- [ ] PHASE-7.4 requirement met (final user-observable gate lives here)
</success_criteria>

<output>
After completion, create `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-03b-SUMMARY.md` capturing:
- Final list of files added/modified
- Cargo test output for `pick_element_serde_tests` (5 tests)
- Vitest output for `controller.test.ts` (5 tests) + `pick-element-button.test.tsx` (4 tests)
- Confirmation that `PickElementResponse::Picked.emitted` is the Rust field name — and that the final desktop vitest asserts end-to-end wire-contract flow from mock sidecar `result.emitted` through to `editorController.insertAtCursor`
- PHASE-7.4 acceptance gate: user-observable "pick element → DSL appears at cursor" works
</output>
