# Phase 10-03 Operator Smoke Checklist

5 steps, ~3 min. Verifies the simulator UI against a real author Live Preview session.

## Prereqs

- Run `pnpm --filter @storycapture/desktop tauri dev`.
- Open any project with a 3+ step story (e.g. a scene with `navigate`, `click "Save"`, `wait 500`).

## Steps

1. **Enable Live Preview + run full simulator**
   - Editor → toggle Live Preview ON (Right-rail switch). Wait for "live" badge.
   - Click **Run simulator** in the Simulator panel header.
   - Expect: banner appears at editor top — "Simulator running — edits paused · Step N / M"; editor becomes read-only (try typing: no effect); filmstrip fills with frame cards as they complete; Preview rail swaps Live canvas → static screenshot with accent-primary bbox + yellow cursor dot.
   - Expect: on completion the banner DISAPPEARS (D-08); filmstrip remains scrubable.

2. **Scrub the timeline**
   - Drag the scrubber slider under the filmstrip or click a frame card.
   - Expect: Preview image crossfades (100ms); bbox + cursor reposition; CodeMirror highlights the matching step line with the accent-primary left stripe.

3. **Preview to here (Cmd-.)**
   - Editor → move caret onto step 2.
   - Press **Cmd-.** (macOS) or **Ctrl-.** (Windows).
   - Expect: simulator starts with `stopAfterOrdinal=2`, banner appears, filmstrip fills to 2 frames, then banner unmounts on paused.
   - Right-click a step line → verify "Preview to here" menu item with ⌘. kbd hint appears; disabled with "— run in progress" suffix if still running.

4. **Promote fuzzy match to fallback**
   - Use a story whose selectors will fuzzy-match (e.g. deliberately mistyped button label) — OR inject a fuzzy match via backend.
   - On a frame card with a **fuzzy** match (dashed warning border), locate the small ↗ icon in the bottom-right corner.
   - Click → expect sonner success toast: "Fallback added to .story.targets.json for step N."
   - Expect: primary-matched frames have NO promote icon; none-matched frames have NO promote icon; icon hides after click within the same run.

5. **Failed-run UX (error bar, not banner)**
   - Modify the story so step 3 targets a non-existent selector. Run simulator.
   - Expect at step 3: filmstrip stops advancing; failed frame card has 2px danger border + AlertTriangle overlay; **banner UNMOUNTS** (D-08); inline red error bar appears under filmstrip: "Step 3: {error} " with a Copy icon for the matched_selector.
   - Expect: scrubber can still move across captured frames 1..2.

## Known co-existence

Phase 3 DryRunPanel (Vietnamese strings, "Chạy thử" button) remains visible unchanged. The Simulator is the canonical runner; Dry-Run will be deprecated in a later phase.
