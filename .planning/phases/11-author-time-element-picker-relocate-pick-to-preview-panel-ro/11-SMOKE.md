# Phase 11 Smoke — Author-time element picker

**Supersedes record-path sections of:** `.planning/phases/07-…/07-03b-SMOKE.md`, `.planning/phases/07-…/07-04c-SMOKE.md`.

**Requires:** Phases 9-04, 10, and 11 all merged; a TCC-granted macOS host
for the author-session preview browser; a .story authored against a
public URL (example.com used below).

---

## Setup

1. Build and launch the desktop app:
   ```bash
   pnpm --filter @storycapture/desktop tauri dev
   ```
2. Open a project with a minimal `.story`:
   ```
   story "smoke"
   app = "https://example.com"
   scene "open"
     navigate "https://example.com"
     click button "More information..."
   ```
3. Confirm the Preview toolbar is present in the Live Preview rail
   (Phase 9-04 deliverable) and the **Live Preview** toggle is OFF.

---

## 1. Lazy-start pick (D-09)

**Pre-state:** Live Preview toggle OFF. No `authorStreamId` available.

1. Focus the editor and position the cursor on the `navigate` line.
2. Click the crosshair **Pick** button in the Preview toolbar.
3. **Expected:** a toast fires `Enable Live Preview first — Pick needs an
   author session` (since the button can only dispatch with a live
   author-session streamId in the final wired build).
4. Toggle **Live Preview: On**. Wait for the badge to read `live`.
5. Click **Pick** again.
6. **Expected:** button enters the active state (accent border, filled
   crosshair, inline `Esc` pill); a sticky 32px banner reads
   `PICKING — press Esc to cancel`; the author browser navigates to
   `https://example.com`.
7. Click the **More information…** anchor in the author viewport.
8. **Expected:** DSL line `click link "More information..."` (or a
   testid equivalent) is inserted at cursor; toast fires
   ``Added `click link "More information..."` · line <N>``; banner
   dismisses; the `.story.targets.json` file appears next to the story
   with the primary + fallback locators seeded.

**Pass criterion:** story bytes unchanged from user's pre-pick save
EXCEPT for the inserted DSL line; `.story.targets.json` now carries a
targets row keyed by the stamped UUIDv7.

---

## 2. Same-line re-pick (D-04 / Pitfall 5)

**Pre-state:** §1 completed; cursor on the line stamped in §1.

1. Note the `.story` mtime: `stat -f %m path/to/demo.story` (macOS) or
   equivalent on Windows.
2. Press **⌘⇧P** (keymap) to activate Pick. Pick a different element.
3. **Expected:** toast fires `Updated fallback for step <N>` (NOT the
   first-pick `Added ...` copy — this is the D-04 disambiguation
   proof).
4. Re-check `.story` mtime.

**Pass criterion:** `.story` mtime **unchanged** (Pitfall 5
invariant — re-picks never rewrite story bytes). `.story.targets.json`
mtime updated (new fallbacks seeded).

---

## 3. Cmd-Shift-P / Ctrl-Shift-P keymap (UI-SPEC §6)

**Pre-state:** Live Preview On; editor focused.

1. Press **⌘⇧P** (macOS) or **Ctrl-Shift-P** (Windows/Linux).
2. **Expected:** identical behavior to clicking the Pick button;
   banner appears, author browser waits for a click.
3. Press **Esc**.
4. **Expected:** pick cancels silently (no toast per UI-SPEC row 3);
   banner dismisses; button regains idle visual (crosshair outline,
   no accent border).

**Pass criterion:** keymap and click dispatch identical flows; Esc
symmetric with re-click cancel.

---

## 4. Simulator concurrency (D-13 / D-14 / D-15)

### 4a. Simulator paused → Pick permitted (D-14)

1. Right-click a scene line in the editor and choose **Preview to
   here**, OR press **⌘.** on the line. Wait for the simulator to land
   in `RunPaused` (the simulator banner reads
   `Simulator running — edits paused · Step X / Y`).
2. Hover the Pick button.
3. **Expected:** tooltip reads `Paused at step <N> — Pick will resume
   Preview after` (UI-SPEC §tooltip row 6).
4. Click Pick. Pick an element.
5. **Expected:** pick succeeds; after resolution the simulator banner
   returns (host resume_author_preview fires per D-12 exit invariant).

### 4b. Simulator running → Pick disabled (D-13)

1. Start a full simulator run via **⌘⇧.** or the Run button.
2. While simulator `runState === "running"`, hover Pick.
3. **Expected:** button is disabled (opacity 60, cursor not-allowed);
   tooltip reads `Simulator running — cancel to pick`.
4. Click Pick.
5. **Expected:** no-op (no IPC fires, no banner appears).

### 4c. Pick active → Simulator start blocked (D-15)

1. Click Pick to enter the active state.
2. While the banner shows `PICKING — press Esc to cancel`, attempt to
   start the simulator via **⌘.**.
3. **Expected:** simulator start is rejected by the host registry
   (AuthorDriverRegistry.can_start_simulator returns
   `AlreadyPicking`); no new simulator session appears in the store.

**Pass criterion:** all three branches match the FSM gates.

---

## 5. Record-path read-only (D-06)

**Pre-state:** Record route (`/recorder/:projectId`) open with an
existing recording project.

1. Confirm **no Pick button** is visible in the record toolbar (D-05
   deletion).
2. Record a story that exercises a click against an element whose
   primary locator has gone stale.
3. **Expected:** the HUD surfaces the destructive block:
   ```
   Step N: "click 'X'" could not match any element.
   Self-healing is disabled during recording. Open this story in
   Simulator, use "Promote to fallback" on step N, then try again.
   ```
   with an **Open in Simulator →** action link on the right.
4. Note the `.story.targets.json` mtime before clicking the link.
5. Click **Open in Simulator →**.
6. **Expected:** editor opens on step N; no simulator auto-start.
7. Re-check the `.story.targets.json` mtime.

**Pass criterion:** `.story.targets.json` mtime **unchanged** (record
path is strictly read-only per D-06 / 11-02 invariance test).

---

## 6. D-11 idle-timeout (Phase 9-04 ownership)

Per CONTEXT §Deferred Ideas (2026-04-19 amendment), the 10-minute
author-session idle timeout is owned by Phase 9-04, not Phase 11.
Phase 11 smoke does NOT verify the timeout duration.

Sanity check only:

1. After a successful Pick in §1, leave the app idle for longer than
   the 9-04-configured idle threshold (nominally 10 minutes).
2. Click Pick.
3. **Expected:** the lazy-start flow from §1 runs again (a fresh
   author session is warmed).

**Pass criterion:** a Pick after idle reaps always succeeds via
lazy-start. A shorter-than-10-minute reaping is NOT a Phase 11
regression.

---

## 7. Unsaved-buffer warning (D-10 W-5 fix)

**Pre-state:** §1 completed. Live Preview On. The picker reads story
bytes supplied by the renderer.

1. Modify the `.story` in the editor (e.g. add a comment) but do NOT
   save.
2. Click Pick.
3. **Expected:** a toast fires `Unsaved changes — Pick will use the
   last saved version. Save first?` BEFORE the Picking banner appears.
4. Proceed with the pick anyway.
5. **Expected:** navigate-replay uses the on-disk bytes (not the CM6
   buffer), so the picker sees whatever URL the saved `navigate` line
   references.

**Pass criterion:** warning toast is non-blocking; replay remains
faithful to on-disk source; no silent buffer-vs-disk divergence.

---

## Pass / Fail

All seven sections pass: **smoke green**.

Any FAIL:
1. Capture the Preview-panel screenshot with the Pick button state.
2. Capture the Picking banner screenshot (if active).
3. Capture the Record-path HUD block (if §5 fails).
4. Save the `tauri dev` terminal output.
5. File a follow-up plan under `--gaps` mode referencing the failing
   §N above.

---

## Artifact checklist (for the human verifier)

- [ ] Screenshot of Preview panel with Pick button in Idle / LivePreview state.
- [ ] Screenshot of Picking banner during active pick (§1 step 6).
- [ ] Screenshot of Record-path HUD error block with the Open-in-Simulator link (§5 step 3).
- [ ] Terminal transcript showing `.story` mtime unchanged across §2 re-pick.
- [ ] Terminal transcript showing `.story.targets.json` mtime unchanged across §5 record-path run.
