---
status: partial
phase: 11-author-time-element-picker-relocate-pick-to-preview-panel-ro
source: [11-VERIFICATION.md]
started: 2026-04-24T09:55:00Z
updated: 2026-04-24T09:55:00Z
---

## Current Test

[awaiting human testing on a TCC-granted macOS host with real Playwright sidecar Chromium]

## Tests

### 1. 11-SMOKE.md §1 First-pick happy path (D-04 / D-08 / D-10 / D-12)
expected: Picking banner enters; click target; toast "Added fallback for step N"; banner exits; story buffer gains `# @id=<uuid>` on target line; targets.json grows by one fallback entry.
result: [pending]

### 2. 11-SMOKE.md §2 Same-line re-pick (D-04 / Pitfall 5)
expected: `.story` mtime unchanged after re-pick; `.story.targets.json` mtime updated; toast reads "Updated fallback for step N" (NOT "Added …").
result: [pending]

### 3. 11-SMOKE.md §3 Cmd-Shift-P / Ctrl-Shift-P keymap (UI-SPEC §6)
expected: Keyboard shortcut activates Pick identically to button click; Esc cancels silently; banner dismisses.
result: [pending]

### 4. 11-SMOKE.md §4a Simulator paused → Pick permitted (D-14 restore)
expected: Picker enters Picking with resume_to=SimulatorPaused; on pick completion, simulator banner returns (registry restores to SimulatorPaused).
result: [pending]
known_risk: simulator.rs does NOT write SimulatorPaused into AuthorDriverRegistry (verification PHASE-11.1 partial gap). This test is expected to FAIL — registry will see LivePreview when user invokes pick from a paused simulator, so end_pick() restores to LivePreview not SimulatorPaused. UX consequence: simulator loses resumable state across a pick. Confirm if acceptable or file gap-closure.

### 5. 11-SMOKE.md §4b Simulator running → Pick disabled (D-13)
expected: Pick button disabled with tooltip "Simulator running — cancel to pick"; click is no-op at host layer.
result: [pending]
known_risk: Renderer-side gate works (authorDriverStore deriveVariant). Host-side gate is NOT wired (simulator.rs does not write SimulatorRunning). Verify: clicking Pick during a running simulator is blocked by the UI gate AND confirm via logs that the host never processes the pick request. If UI gate is bypassed by a race, the host has no fallback.

### 6. 11-SMOKE.md §4c Pick active → Simulator start blocked (D-15)
expected: Simulator start via Cmd-. during active pick is rejected with AlreadyPicking error.
result: [pending]
known_risk: Because simulator.rs does NOT consult AuthorDriverRegistry, this test is expected to FAIL — simulator_start will proceed while registry is in Picking. Confirm whether simulator_start actually rejects, or escalate as a gap.

### 7. 11-SMOKE.md §5 Record-path read-only (D-06)
expected: Record run with stale primary raises HUD destructive block with UI-SPEC copy + "Open in Simulator →" link; `.story.targets.json` mtime unchanged.
result: [pending]

### 8. 11-SMOKE.md §7 Unsaved-buffer warning (D-10 W-5 fix)
expected: Dirty buffer fires toast "Unsaved changes — Pick will use the last saved version. Save first?" before Picking banner; user can proceed; replay uses on-disk bytes.
result: [pending]
known_risk: editorController.markSaved is a known stub in 11-04 SUMMARY — `isDirty()` may always return false until a save call wires it. If so, the toast never fires and the test will fail UX-wise.

## Summary

total: 8
passed: 0
issues: 0
pending: 8
skipped: 0
blocked: 0

## Gaps

(populated during/after operator runs of 11-SMOKE.md)
