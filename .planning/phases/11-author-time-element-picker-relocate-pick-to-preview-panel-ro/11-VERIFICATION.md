---
phase: 11-author-time-element-picker-relocate-pick-to-preview-panel-ro
verified: 2026-04-24T09:48:00Z
status: human_needed
score: 12/14 must-haves verified (with 1 partial on PHASE-11.1/11.8)
overrides_applied: 0
gaps:
  - truth: "PHASE-11.1: Both commands/picker.rs and commands/simulator.rs acquire the same AuthorDriverRegistry lock"
    status: partial
    reason: "Only commands/picker.rs acquires AuthorDriverRegistry (picker.rs:526). simulator.rs only uses SimulatorRegistry and never locks or writes to AuthorDriverRegistry. The registry therefore never enters SimulatorRunning or SimulatorPaused from production code paths, which renders the host-side D-13/D-14/D-15 gates inert."
    artifacts:
      - path: "apps/desktop/src-tauri/src/commands/simulator.rs"
        issue: "simulator_start (line 269) does not acquire AuthorDriverRegistry — takes only State<'_, SimulatorRegistry>. No call to can_start_simulator(), no transition to SimulatorRunning, no writeback to SimulatorPaused on RunPaused, no restore on StoryEnded/Cancel."
    missing:
      - "Register Arc<AuthorDriverRegistry> as a State parameter on simulator_start, simulator_step_to, simulator_cancel."
      - "Inside simulator_start: lock the registry, call can_start_simulator()?, transition to SimulatorRunning{ session } on success."
      - "On RunPaused event: transition registry to SimulatorPaused{ session }."
      - "On StoryEnded/SimulatorCancelled/error: transition back to Idle or LivePreview{ stream_id }."
  - truth: "PHASE-11.8: Host-layer state machine enforces concurrency (can_start_simulator rejects when Picking)"
    status: partial
    reason: "can_start_simulator() exists as a helper on AuthorDriverState and is unit-tested (tests/author_driver_concurrency.rs CC-3 host_layer_guards_simulator_start_against_picking), but no production call site invokes it. simulator_start does not consult the registry. Pitfall 6 (two-layer defense) is therefore violated — Picking is blocked from entering via the picker path only, not when the user clicks Simulator Start while Pick is active. Renderer-side UI gating in authorDriverStore masks this in practice but is advisory only per store documentation (authorDriverStore.ts:3-29)."
    artifacts:
      - path: "apps/desktop/src-tauri/src/commands/simulator.rs"
        issue: "simulator_start never calls registry.state.lock() or can_start_simulator(). No host-layer guard against Picking."
    missing:
      - "Insert registry lock + can_start_simulator() check at the top of simulator_start, similar to picker_start_author_impl lines 458-465 in picker.rs."
human_verification:
  - test: "11-SMOKE.md §1 Lazy-start pick (D-09)"
    expected: "Pick click from a dormant session toggles Live Preview on, author browser boots, overlay picks an element, DSL line inserted, correct UI-SPEC toast fires, .story.targets.json seeded."
    why_human: "Requires TCC-granted macOS host, real Playwright sidecar Chromium launch, human interaction with the author viewport. Cannot be scripted inside the verifier."
  - test: "11-SMOKE.md §2 Same-line re-pick (D-04 / Pitfall 5)"
    expected: ".story mtime unchanged after re-pick; .story.targets.json mtime updated; toast reads \"Updated fallback for step N\" (NOT \"Added …\")."
    why_human: "Mtime + toast disambiguation requires a live browser session and human-driven click on a second element."
  - test: "11-SMOKE.md §3 Cmd-Shift-P / Ctrl-Shift-P keymap (UI-SPEC §6)"
    expected: "Keyboard shortcut activates Pick identically to button click; Esc cancels silently; banner dismisses."
    why_human: "OS-level keybinding behavior + focus routing through CodeMirror 6 is empirically verified; automated tests can't prove the end-to-end keyboard path against a real editor instance."
  - test: "11-SMOKE.md §4a Simulator paused → Pick permitted (D-14 restore)"
    expected: "Picker enters Picking with resume_to=SimulatorPaused; on pick completion, simulator banner returns (registry restores to SimulatorPaused)."
    why_human: "Because simulator.rs does NOT write SimulatorPaused into AuthorDriverRegistry (see gaps above), this test WILL FAIL in practice — the registry sees LivePreview when user invokes pick from a paused simulator, so end_pick() restores to LivePreview not SimulatorPaused. Operator must confirm whether the UX consequence (simulator loses resumable state across a pick) is acceptable, or file as a gap-closure follow-up."
  - test: "11-SMOKE.md §4b Simulator running → Pick disabled (D-13)"
    expected: "Pick button disabled with tooltip 'Simulator running — cancel to pick'; click is no-op at host layer."
    why_human: "Renderer-side gate works (authorDriverStore derivation), but the host-side gate is NOT wired (see PHASE-11.1 gap). Operator must verify that clicking Pick during a running simulator is blocked by the UI gate AND confirm via logs that the host never processes the pick request. If the UI gate is bypassed (e.g., by a race), the host currently has no fallback."
  - test: "11-SMOKE.md §4c Pick active → Simulator start blocked (D-15)"
    expected: "Simulator start via Cmd-. during active pick is rejected with AlreadyPicking error."
    why_human: "Because simulator.rs does NOT consult AuthorDriverRegistry (see gaps), this test is expected to FAIL — simulator_start will proceed while registry is in Picking. Operator must confirm whether simulator_start actually rejects, or escalate as a gap."
  - test: "11-SMOKE.md §5 Record-path read-only (D-06)"
    expected: "Record run with stale primary raises HUD destructive block with UI-SPEC copy + 'Open in Simulator →' link; .story.targets.json mtime unchanged."
    why_human: "Requires TCC-granted macOS host and a recording project with a seeded stale selector."
  - test: "11-SMOKE.md §7 Unsaved-buffer warning (D-10 W-5 fix)"
    expected: "Dirty buffer fires toast 'Unsaved changes — Pick will use the last saved version. Save first?' before Picking banner; user can proceed; replay uses on-disk bytes."
    why_human: "Requires an interactive editor buffer with unsaved modifications + live pick flow. Note: editorController.markSaved is documented as a known stub in 11-04 SUMMARY, so isDirty() may always return false until a save call wires it — if so, the toast never fires and the test will fail UX-wise."
---

# Phase 11: Author-time element picker relocate-Pick-to-Preview-panel Verification Report

**Phase Goal:** The element picker lives in the Preview panel (not the recording toolbar), routes clicks through the Phase 9-04 author-session with a shared AuthorDriverState FSM that coordinates with the Phase 10 simulator, and the recording path becomes a strictly read-only consumer of .story + .story.targets.json — self-healing is deferred to Simulator + Promote-to-fallback only.

**Verified:** 2026-04-24T09:48:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Picker lives in Preview panel (not recording toolbar) | VERIFIED | `PreviewPickerButton.tsx:1-560` mounted in `preview-panel.tsx:75` + `routes/editor.tsx:598`. `pick-element-button.{tsx,test.tsx}` both deleted (`ls` returns "No such file or directory"). `grep "PickElementButton\|pick-element-button" apps/desktop/src/features/recorder/` = 0 matches. |
| 2 | Picker routes through Phase 9-04 author-session via picker_start_author | VERIFIED | `picker.rs:524 pub async fn picker_start_author` registered in `ipc_spec.rs:69`. TS wrapper `pickElementAuthor` at `picker.ts:204`. Sidecar `pickElement.start` at `server.mjs:1045` routes by streamId to `state.authorSessions` (lines 1053-1062). New RPC `author.navigateTo` at `server.mjs:877-906`. |
| 3 | Shared AuthorDriverState FSM exists with 5 variants (D-16) | VERIFIED | `author_driver.rs:33-49` defines Idle / LivePreview / Picking{resume_to} / SimulatorRunning / SimulatorPaused verbatim. Registry at `author_driver.rs:57-66`. Registered in `lib.rs:148`. |
| 4 | FSM coordinates with Phase 10 simulator (both commands acquire the same lock) | **PARTIAL (gap)** | picker.rs acquires registry (line 526) and gates via `can_start_pick()` (picker_start_author_impl line 460). **simulator.rs does NOT acquire the registry** — `grep AuthorDriverRegistry apps/desktop/src-tauri/src/commands/simulator.rs` returns zero matches. `SimulatorRunning`/`SimulatorPaused` states are never written from production code. See gaps section. |
| 5 | Recording path is read-only consumer of .story + .story.targets.json (self_heal=false) | VERIFIED | `commands/automation.rs:287` passes `/* self_heal */ false` to `Executor::run_with_story_path`. `HealPolicy::RaiseOnMiss` in `executor.rs:39-43, 79-85` short-circuits before try_promote_fallback (executor.rs:509-518). Integration test `tests/record_path_self_heal_false.rs` asserts byte + mtime invariance (2 tests passing). |
| 6 | Primary-miss during recording raises typed error with UI-SPEC copy | VERIFIED | `error.rs:62-67` defines `PrimaryMissNoHeal { step_ordinal, step_id, verb }` with verbatim UI-SPEC §Record-path primary-miss Display string. Raise site at `executor.rs:509-518`. |
| 7 | HUD surfaces D-06 copy + "Open in Simulator →" action | VERIFIED | `features/recorder/hud.tsx:7, 46-55, 96` + source-of-truth constant at `features/recorder/primary-miss-copy.ts:19-26` (`RECORD_PATH_MISS_BODY` / `RECORD_PATH_MISS_MARKER`). `grep -c "Open in Simulator" hud.tsx` = 7 matches. |
| 8 | picker_stamp_step_id byte-idempotent on re-pick + returns was_freshly_stamped flag | VERIFIED | `PickerStampResultDto { step_id, was_freshly_stamped }` registered in `ipc_spec.rs:178`. TS wrapper returns `{ stepId, wasFreshlyStamped }` (`picker.ts:163-185`). Regression test `tests/picker_stamp_idempotent_source_bytes.rs` (2 passing) asserts byte + mtime identity on re-pick. |
| 9 | Host-layer FSM gates can_start_pick / can_start_simulator | **PARTIAL (gap)** | Helpers exist (`author_driver.rs:81-95`) and are unit-tested (15 tests across author_driver_state_machine + author_driver_concurrency, all passing). **can_start_simulator is never called from a production code path** — simulator_start never consults the registry. See gaps section. |
| 10 | Picking from SimulatorPaused carries resume_to box | VERIFIED (in-code), untestable (in-practice) | `author_driver.rs:100-110` `begin_pick` boxes prior state when it was `SimulatorPaused`. Unit test SM-2 in `author_driver_state_machine.rs` asserts restore round-trip. **In practice the registry never enters SimulatorPaused** since simulator.rs doesn't write it — so the runtime resume_to path is dead code end-to-end. |
| 11 | resume_author_preview invoked on all exit paths (D-12) | VERIFIED | `picker.rs:489` fires `resume_author_preview` regardless of pick outcome (captured result pattern, steps 5-8 of picker_start_author_impl). 6 tests in `tests/author_driver_picker_pause_resume.rs` cover happy / user-cancel / unsupported-url / driver-error / panic / ordering paths (all passing). |
| 12 | replay_navigate_verbs walks story AST up to cursor_line + falls back to meta.app | VERIFIED | `picker.rs:395, 423` + `compute_navigate_urls`. 5 tests in `tests/replay_navigate_verbs.rs` cover RN-1…RN-5 (all passing). |
| 13 | Cmd-Shift-P / Ctrl-Shift-P triggers pick via CodeMirror keymap | VERIFIED | `codemirror-setup.ts:41 key: "Mod-Shift-p"` + `Prec.high(keymap.of([...]))` wrap. `triggerPickFromEditor()` import at line 25. No `document.addEventListener` usage (grep returns 0 matches in codemirror-setup.ts). |
| 14 | Recorder-side picker deleted | VERIFIED | `pick-element-button.tsx` + `pick-element-button.test.tsx` both DELETED. `recording-view.tsx` has no PickElementButton import/mount. |
| 15 | 11-SMOKE.md supersedes 07-03b / 07-04c record-path sections | VERIFIED | File exists (7.8 K) with 7 sections covering D-09, D-04/Pitfall 5, UI-SPEC §6 keymap, D-13/14/15, D-06, D-11, D-10 W-5. Supersession note at line 3. |

**Score:** 12/14 verified + 2 partial (PHASE-11.1, PHASE-11.8).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/desktop/src-tauri/src/author_driver.rs` | FSM + registry + guard + transition table | VERIFIED | 186 lines. 5-variant enum lines 33-49. Registry lines 57-66. AuthorDriverError lines 68-77. PickerResumeGuard lines 140-186 with shutdown-safe Drop. Transition-table doc-comment lines 7-24. |
| `apps/desktop/src-tauri/tests/author_driver_state_machine.rs` | D-13/14/15/16 helpers | VERIFIED | 4.7K. SM tests passing. |
| `apps/desktop/src-tauri/tests/author_driver_concurrency.rs` | Registry races + Drop guard | VERIFIED | 4.9K. CC-1 / CC-2a / CC-2b / CC-3 tests passing. |
| `apps/desktop/src-tauri/tests/picker_stamp_idempotent_source_bytes.rs` | Byte + mtime idempotence | VERIFIED | 3.8K. 2 tests passing. |
| `apps/desktop/src-tauri/tests/record_path_self_heal_false.rs` | Record path invariance | VERIFIED | 9.8K. 2 tests passing. |
| `apps/desktop/src-tauri/tests/replay_navigate_verbs.rs` | D-10 coverage | VERIFIED | 5.4K. 5 tests passing. |
| `apps/desktop/src-tauri/tests/author_driver_picker_pause_resume.rs` | D-12 exit paths | VERIFIED | 10.2K. 6 tests passing. |
| `crates/automation/src/error.rs` | `PrimaryMissNoHeal` variant | VERIFIED | Line 62. Display string verbatim UI-SPEC. |
| `crates/automation/src/executor.rs` | self_heal gate + HealPolicy | VERIFIED | `HealPolicy` enum (line 39); `run_with_story_path_policy` / `run_simulator_policy` (lines 79-93); raise site (line 509). Post-merge glue commit `e0a4488`. |
| `apps/desktop/src-tauri/src/commands/automation.rs` | self_heal=false on record | VERIFIED | Line 287. picker_stamp_step_id call sites: 0. |
| `apps/desktop/src-tauri/src/commands/picker.rs` | picker_start_author + AuthorPreviewControl trait | VERIFIED | Lines 312-559. Trait seam at 334-352. Compute helpers + orchestration + Tauri command. |
| `apps/desktop/src-tauri/src/commands/simulator.rs` | Acquires AuthorDriverRegistry, gates on can_start_simulator, writes SimulatorRunning/SimulatorPaused | **NOT WIRED** | Zero AuthorDriverRegistry references. See gaps. |
| `scripts/playwright-sidecar/server.mjs` | streamId routing + author.navigateTo | VERIFIED | pickElement.start at line 1045 routes via `state.authorSessions`. author.navigateTo at line 877. 24 authorSessions references. |
| `scripts/playwright-sidecar/server.test.mjs` | 3 streamId cases | VERIFIED (per 11-03 SUMMARY) | 76 sidecar tests green. |
| `apps/desktop/src/ipc/picker.ts` | pickElementAuthor + PickerStampResult | VERIFIED | Lines 163-185 (stamp DTO) + 204 (pickElementAuthor). |
| `apps/desktop/src/features/recorder/hud.tsx` | Destructive block + Open-in-Simulator | VERIFIED | primary-miss-copy.ts sourced. 7 grep hits. |
| `apps/desktop/src/features/recorder/primary-miss-copy.ts` | Source-of-truth copy constants | VERIFIED | File exists. `RECORD_PATH_MISS_MARKER`, `RECORD_PATH_MISS_BODY`, `parsePrimaryMiss` helper. |
| `apps/desktop/src/features/editor/PreviewPickerButton.tsx` | 5 states + UI-SPEC copy | VERIFIED | 19.3K. Constants block lines 66-75 covers all 6 tooltips + toast copy. aria-keyshortcuts line 379. |
| `apps/desktop/src/features/editor/PreviewPickerButton.test.tsx` | D-13/14/04 + Esc + copy | VERIFIED | 7 tests passing. |
| `apps/desktop/src/features/editor/authorDriverStore.ts` | 5-variant projection + deriveVariant | VERIFIED | 5 variants lines 33-38. `deriveVariant` helper lines 77-85. |
| `apps/desktop/src/features/editor/preview-panel.tsx` | Mount button + banner | VERIFIED | Mount at line 75 + banner at line 110. |
| `apps/desktop/src/routes/editor.tsx` | Mount in real live-preview rail | VERIFIED | Imports (lines 36-42), derivation useEffect (lines 199-213), button mount (line 598), banner (line 639). |
| `apps/desktop/src/features/editor/codemirror-setup.ts` | Cmd-Shift-P keymap | VERIFIED | Mod-Shift-p binding at line 41; no document.addEventListener (confirmed by grep). |
| `apps/desktop/src/features/editor/controller.ts` | isDirty / getCursorLine / getStepOrdinalForLine / markSaved / setStepOrdinalLookup | VERIFIED (with Known Stubs) | Methods added. Note: `markSaved` and `setStepOrdinalLookup` are not yet CALLED from any caller (documented in 11-04 SUMMARY Known Stubs) — non-breaking but isDirty() returns false until first save call is wired, and the re-pick toast falls back to lineNumber. |
| `apps/desktop/src/features/recorder/recording-view.tsx` | PickElementButton import + mount removed | VERIFIED | grep returns 0 matches. |
| `apps/desktop/src/features/recorder/pick-element-button.tsx` | DELETED | VERIFIED | File does not exist. |
| `apps/desktop/src/features/recorder/pick-element-button.test.tsx` | DELETED | VERIFIED | File does not exist. |
| `.planning/phases/11-…/11-SMOKE.md` | 7-section operator runbook | VERIFIED | 7.8K, 7 sections. Supersession note present. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `lib.rs:148 setup()` | `AuthorDriverRegistry::default()` | `.manage(Arc::new(...))` | WIRED | `grep -n "AuthorDriverRegistry" lib.rs` → line 148. |
| `picker.rs:524 picker_start_author` | `author_driver::AuthorDriverRegistry` | `tauri::State<'_, Arc<AuthorDriverRegistry>>` | WIRED | Line 526. |
| `picker.rs` | `commands::automation::pause_author_preview / resume_author_preview` | `AuthorPreviewControl` trait (picker.rs:339) + SidecarAuthorPreviewControl adapter | WIRED | Trait + impl + Tauri command wiring; orchestration at picker_start_author_impl. |
| `server.mjs pickElement.start` | `state.authorSessions` | streamId lookup | WIRED | Lines 1045, 1053-1062. |
| `picker.rs replay_navigate_verbs` | `story_parser::Command::Navigate` | AST walk filtered by `meta().line <= cursor_line` | WIRED | picker.rs `compute_navigate_urls` line 395. 5 tests pass. |
| `PreviewPickerButton.tsx onClick` | `pickElementAuthor` | `invoke('picker_start_author', ...)` | WIRED | Line 275. |
| `preview-panel.tsx header` | `PreviewPickerButton` | JSX mount | WIRED | Line 75. |
| `routes/editor.tsx` toolbar | `PreviewPickerButton` | JSX mount (real surface) | WIRED | Line 598. |
| `codemirror-setup.ts keymap` | `triggerPickFromEditor` | `keymap.of([{ key: "Mod-Shift-p", run: () => { triggerPickFromEditor(); return true; } }])` | WIRED | Lines 25, 38-46. |
| `recording-view.tsx` | `PickElementButton` | (DELETED) | DELETED AS REQUIRED | 0 references. |
| `simulator.rs simulator_start` | `AuthorDriverRegistry` | (NOT WIRED) | **NOT WIRED (gap)** | No registry acquisition; no can_start_simulator call; no SimulatorRunning writeback. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `PreviewPickerButton.tsx` state `variant` | `useAuthorDriverStore(s => s.variant)` | `setSnapshot` from `routes/editor.tsx` useEffect (derives from `authorStreamId` + `simulatorRunState`) | Yes — upstream stores are live | FLOWING |
| `PreviewPickerButton.tsx` state `streamId` | `useAuthorDriverStore(s => s.streamId)` | Same derivation + `useEditorLivePreview` (Phase 9-04 exposed streamId) | Yes — Phase 9-04 ships the hook | FLOWING |
| `picker_start_author_impl` `story_src` parameter | Renderer passes `useEditorStore.getState().source` | CM6 editor buffer | Yes — buffer is populated on project load | FLOWING |
| `replay_navigate_verbs` URLs | `compute_navigate_urls(story_src, cursor_line)` walks parsed AST | story-parser AST | Yes — parse produces real Commands | FLOWING |
| Record-path HUD `primaryMiss` state | `parsePrimaryMiss(step_failed.error_message)` | `ExecutorEvent::StepFailed` from executor | Yes — record run produces real events | FLOWING |
| `editorController.isDirty()` | `lastSavedSource` vs live doc | `markSaved()` caller | **NO — markSaved not wired** | STATIC (documented Known Stub in 11-04 SUMMARY) |
| `editorController.getStepOrdinalForLine()` | `stepOrdinalLookup` registered fn | `setStepOrdinalLookup` caller | **NO — setStepOrdinalLookup not wired** | STATIC (documented Known Stub) |
| `AuthorDriverRegistry.state` | Written by `picker_start_author_impl` (Picking transitions) | picker command only | Partial — picker writes, simulator doesn't | HOLLOW for SimulatorRunning / SimulatorPaused variants |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| FSM + registry + guard tests | `cargo test -p storycapture --test author_driver_state_machine --test author_driver_concurrency` | 15 passed (2 suites) | PASS |
| Picker stamp byte idempotence (D-04 / Pitfall 5) | `cargo test -p storycapture --test picker_stamp_idempotent_source_bytes` | 2 passed | PASS |
| Record-path self_heal=false invariance | `cargo test -p storycapture --test record_path_self_heal_false` | 2 passed | PASS |
| Navigate-replay (D-10) | `cargo test -p storycapture --test replay_navigate_verbs` | 5 passed | PASS |
| Pause/resume all exit paths (D-12) | `cargo test -p storycapture --test author_driver_picker_pause_resume` | 6 passed | PASS |
| PreviewPickerButton UI states + copy + keymap dispatch | `./node_modules/.bin/vitest run PreviewPickerButton` | 7 passed | PASS |
| Sidecar streamId routing (PHASE-11.6) | (per 11-03 SUMMARY) `pnpm --filter playwright-sidecar test` | 76 passed (not re-run here; summary commits 9581572/cc6795b attest) | PASS (reported) |

### Requirements Coverage

| Requirement | Source Plan | Description (abbrev.) | Status | Evidence |
|-------------|-------------|----------------------|--------|----------|
| PHASE-11.1 | 11-01 | Shared AuthorDriverRegistry acquired by BOTH commands/picker.rs AND commands/simulator.rs | **PARTIAL** | picker.rs acquires (picker.rs:526). simulator.rs does NOT acquire — 0 references. Registry is owner-asymmetric. |
| PHASE-11.2 | 11-01 | PickerResumeGuard RAII cleanup + Pitfall 2 shutdown-safety | SATISFIED | author_driver.rs:140-186. Drop uses `tokio::runtime::Handle::try_current().ok()` (line 173). |
| PHASE-11.3 | 11-02 | Record path passes self_heal=false | SATISFIED | automation.rs:287. HealPolicy integration commit e0a4488 (post-merge fix). |
| PHASE-11.4 | 11-02 | AutomationError::PrimaryMissNoHeal raised; try_promote_fallback unreachable on record | SATISFIED | error.rs:62-67. Raise site executor.rs:509-518 (gated by HealPolicy::RaiseOnMiss before try_promote_fallback). Display string matches UI-SPEC verbatim. |
| PHASE-11.5 | 11-02 | HUD surfaces D-06 copy + "Open in Simulator →" (no auto-start) | SATISFIED | hud.tsx + primary-miss-copy.ts. 7 "Open in Simulator" matches. |
| PHASE-11.6 | 11-03 | Sidecar pickElement.start streamId routing; unknown streamId → -32000; no fall-through to state.page; authorBrowser untouched | SATISFIED | server.mjs:1045-1070. `state.authorSessions` lookup + typed error + no fallback. |
| PHASE-11.7 | 11-01 | picker_stamp_step_id byte-idempotent on re-pick + was_freshly_stamped flag | SATISFIED | PickerStampResultDto in ipc_spec.rs:178. Tests asserting byte + mtime identity. |
| PHASE-11.8 | 11-01 | Host-layer FSM enforces can_start_pick + can_start_simulator gates | **PARTIAL** | can_start_pick is called from picker_start_author_impl (enforced). **can_start_simulator is never called from any production code path** — helper exists, unit-tested, but no call site in simulator.rs. Pitfall 6 two-layer defense is one-way. |
| PHASE-11.9 | 11-03 | picker_start_author command orchestrates acquire → transition → replay → pause → pick → resume (all exits) | SATISFIED | picker.rs:448-512. 6 D-12 tests pass. |
| PHASE-11.10 | 11-03 | replay_navigate_verbs walks AST ≤ cursor_line; meta.app fallback; best-effort on sidecar errors | SATISFIED | picker.rs:395-442. 5 RN tests pass. |
| PHASE-11.11 | 11-03 | author.navigateTo sidecar RPC with bounded networkidle | SATISFIED | server.mjs:877-906. `waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})`. |
| PHASE-11.12 | 11-04 | PreviewPickerButton mounted in preview-panel.tsx with 5 visual states + verbatim copy | SATISFIED | PreviewPickerButton.tsx 19.3 K. All 6 tooltips + 7 toasts in COPY constants block. Mounted in preview-panel.tsx:75 + routes/editor.tsx:598. |
| PHASE-11.13 | 11-04 | Cmd-Shift-P / Ctrl-Shift-P via CodeMirror 6 keymap (NOT document.addEventListener); editor-focus + state-aware behavior | SATISFIED | codemirror-setup.ts:41 Mod-Shift-p. 0 document.addEventListener usages. |
| PHASE-11.14 | 11-04 | Recorder picker files deleted; 11-SMOKE.md supersedes 07-03b / 07-04c record-path sections | SATISFIED | Both files deleted. 11-SMOKE.md created with supersession header. |

**Orphaned requirements:** None. All 14 PHASE-11.* IDs accounted for.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/desktop/src-tauri/src/author_driver.rs` | 181-183 | TODO comment for `resume_author_preview` wiring from PickerResumeGuard::drop | Info | Documented in 11-01 SUMMARY. Orchestration fires resume on the happy path (picker.rs:489); Drop path restores FSM only (no screencast resume on panic). Paused screencast remains paused until user invokes Live Preview again. Low-risk corner case. |
| `apps/desktop/src-tauri/src/commands/simulator.rs` | — | Missing AuthorDriverRegistry integration | **Blocker (for PHASE-11.1 / 11.8)** | See gaps section. |
| `apps/desktop/src/features/editor/controller.ts` | markSaved/setStepOrdinalLookup | Added but never called from any caller (Known Stubs per 11-04 SUMMARY) | Warning | `isDirty()` always returns false until first save wires it (D-10 dirty-buffer warning never fires in practice). `getStepOrdinalForLine()` returns null so re-pick toast substitutes line number for step ordinal (toast copy still renders verbatim — only the numeric ordinal is degraded). Non-breaking but sub-optimal UX. |

### Human Verification Required

See `human_verification` in frontmatter. Eight items require operator walkthrough on a TCC-granted host, including:

1. **11-SMOKE.md §1** — Lazy-start pick with real Chromium.
2. **11-SMOKE.md §2** — Same-line re-pick mtime + disambiguation toast.
3. **11-SMOKE.md §3** — Cmd-Shift-P / Ctrl-Shift-P keymap.
4. **11-SMOKE.md §4a** — D-14 Pick from SimulatorPaused **— expected to expose the PHASE-11.1 gap** (registry never in SimulatorPaused state; end_pick restores to LivePreview, not SimulatorPaused, because simulator.rs never writes SimulatorPaused in the first place).
5. **11-SMOKE.md §4b** — D-13 Pick disabled during Simulator running. Renderer-side gate works; host-side gate is inert (see gaps).
6. **11-SMOKE.md §4c** — D-15 Simulator start blocked during Pick **— expected to expose the PHASE-11.1 gap** (simulator_start does not consult the registry).
7. **11-SMOKE.md §5** — Record-path read-only HUD flow.
8. **11-SMOKE.md §7** — Unsaved-buffer warning (likely affected by the `markSaved` Known Stub).

### Gaps Summary

**Two partials — one root cause: simulator.rs integration into AuthorDriverRegistry never happened.**

PHASE-11.1 ("Both commands/picker.rs and commands/simulator.rs acquire the same lock") and PHASE-11.8 ("Host-layer state machine enforces concurrency") are both partial because `commands/simulator.rs` has zero references to `AuthorDriverRegistry`. The consequences:

1. **D-13 host gate is inert.** When a simulator is running, `AuthorDriverRegistry.state` is still whatever the picker last left it in (Idle / LivePreview). `picker_start_author_impl.can_start_pick()` will see Idle/LivePreview and PERMIT the pick. The renderer-side gate in `authorDriverStore` (which IS derived from `simulatorStore.runState`) disables the button, but this is UI-only defense — exactly the Pitfall 6 scenario the FSM was supposed to prevent.

2. **D-14 resume_to is dead code end-to-end.** `begin_pick` boxes prior state when it's `SimulatorPaused`, but since `simulator.rs` never writes `SimulatorPaused` into the registry, the runtime branch is never exercised. A user invoking Pick from a paused simulator will end in LivePreview, not restored to SimulatorPaused — losing simulator resumability.

3. **D-15 host gate is absent.** `can_start_simulator()` exists as a helper but has no production caller. A user invoking Simulator Start while a pick is active (e.g., via Cmd-. during Picking) will proceed at the host level; only the UI gate stops them.

**This is NOT documented as deferred** in 11-CONTEXT.md Deferred Ideas, 11-04 SUMMARY Known Stubs, or `deferred-items.md` — `deferred-items.md` covers only unrelated pre-existing test failures. The simulator-side wiring appears to have been implicit in PHASE-11.1 but no Phase 11 plan explicitly picks it up; 11-01's scope is the helper + registry + picker.rs wiring, 11-03's scope is picker orchestration, 11-04 is renderer. The simulator call-site is an orphaned edit from the phase boundary.

**Recommendation:** close via a focused gap-closure plan (`/gsd-plan-phase 11 --gaps`) that adds 5-10 lines to `simulator_start` / `simulator_cancel` / step-to handlers to acquire the registry, validate via `can_start_simulator()`, and write `SimulatorRunning{session}` / `SimulatorPaused{session}` state transitions in lockstep with the SimulatorRegistry events. Total surface: ~3 files, ~50 lines.

**Integration note acknowledged:** Wave 1 post-merge fix `e0a4488` (HealPolicy split) is the correct integration glue between Phase 10's "don't persist" semantics and Phase 11's "don't probe" semantics. This is NOT a deviation — it is the in-tree reconciliation and is fully integrated into the passing tests. `Executor::run_with_story_path(self_heal: bool)` and `Executor::run_simulator(self_heal: bool)` public surfaces are preserved.

---

_Verified: 2026-04-24T09:48:00Z_
_Verifier: Claude (gsd-verifier)_
