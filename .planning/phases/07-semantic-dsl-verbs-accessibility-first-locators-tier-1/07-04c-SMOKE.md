# Plan 07-04c — Manual End-to-End Smoke (Self-Healing)

**Scope:** Final PHASE-7.5 acceptance gate — proves
`primary-miss → fallback-promoted → .story.targets.json rewritten`
against a real browser, complementing the CI mock-driver assertion at
`crates/automation/tests/self_healing.rs`.

## Prerequisites

- All prior Phase 7 plans merged (`07-01` … `07-04b`).
- Desktop app buildable and running in dev mode
  (`pnpm --filter desktop tauri:dev`).
- A test project with a `.story` file that targets a **local HTML file
  you control** — you'll rename an element id between runs.
- The editor toolbar has already wired `editorController.setStoryPath`
  to the currently-open `.story` file (see
  `apps/desktop/src/features/editor/controller.ts` — landed in plan
  07-04c). If your story is an unsaved buffer, save it first.

## Step 1 — First-pick step-id stamping

1. Create a simple test HTML (e.g. `demo.html`):
   ```html
   <!doctype html><html><body>
     <button id="save-v1">Save</button>
   </body></html>
   ```
2. Point the `.story`'s `meta.app:` at `file:///absolute/path/to/demo.html`.
3. Open the `.story` in the StoryCapture editor; place the cursor on an
   empty line inside a `scene` block.
4. Click **Pick element** → click the "Save" button in the preview.
5. **Expected:**
   - The editor inserts a line like:
     `click button "Save"  # @id=018f4c1e-…`
   - A sibling file appears at `<story>.story.targets.json` containing
     an entry keyed by that UUIDv7 with `primary` set to the picked
     locator and `fallbacks` mirroring the sidecar's ranked candidate
     list.

## Step 2 — Subsequent-pick target update (idempotent re-stamping)

1. Put the cursor on the **same line** that already has `# @id=<uuid>`.
2. Click **Pick element** and pick a DIFFERENT element this time.
3. **Expected:**
   - The `.story` source remains **unchanged** (the trailing `@id` is
     already stamped; `picker_stamp_step_id` is idempotent and reuses
     the existing id).
   - `<story>.story.targets.json` gains a second step entry under the
     original UUID's key with the newly picked primary + fallbacks.

Note: the current implementation stamps the UUID once per cursor line.
Re-picking from the same cursor reuses the stamped id and upserts the
targets entry — matching the "same step, new target" operator model
documented in 07-CONTEXT.md.

## Step 3 — Self-healing (PHASE-7.5 final acceptance gate)

1. **Edit the HTML** so the primary selector no longer matches:
   ```html
   <!doctype html><html><body>
     <!-- renamed id -->
     <button id="save-v2">Save</button>
   </body></html>
   ```
2. Run the story (desktop recorder or headless CLI).
3. **Expected — PHASE-7.5 gate is green iff all three hold:**
   - The click **succeeds** (no wait-actionable timeout surfaces to the
     user; the run completes normally).
   - The `.story` source file's bytes on disk are **unchanged** — open
     it and diff against the pre-run copy.
   - `<story>.story.targets.json` has been rewritten:
     - `primary` now references the fallback that passed (e.g. the
       `role=button:Save` candidate if the CSS-on-id fallback wasn't
       present, or `selector #save-v2` if the ranked list included it).
     - `fallbacks[0]` is the previous primary (`selector #save-v1`),
       demoted but retained so a future markup revert auto-re-promotes.
     - Any other pre-existing fallbacks remain in the array (order
       after the promoted slot is implementation-defined but no
       candidate is dropped).

If any of the three checks fails, **file a PHASE-7.5 regression** —
the automated CI proof at `crates/automation/tests/self_healing.rs`
covers the invariant against a mock driver, so a real-browser
regression means the Playwright sidecar's actionability check is
out of step with the mock (driver bug, not self-healing-algorithm
bug).

## Known limitations

- Free-form user comments in the `.story` source are NOT preserved by
  `story_parser::format_story` — documented in
  `crates/story-parser/src/formatter.rs` module doc. First-pick
  stamping passes through the formatter so any free-form comments the
  user added to the file will be collapsed on the first stamp.
  Subsequent self-healing runs do NOT touch the `.story` source and
  so do NOT collapse comments.
- Multi-fallback promotion is **conservative** — only the FIRST
  fallback that passes `wait_actionable` is promoted per run. If the
  ranked order is wrong for the current DOM, re-pick to re-seed the
  targets file.
- Drag destinations (`drag ... to X`) are **intentionally not
  self-healed** — the `to` side's identity is paired with the source,
  and promoting it in isolation would silently retarget the drop.
  Re-pick the drag verb to refresh both endpoints.
- `picker_stamp_step_id` needs an on-disk `.story` path. Unsaved
  buffers skip the stamp fire-and-forget (toasted once in Step 1 if
  the editor still holds an in-memory buffer); save the file first.

## Operator sign-off checklist

- [ ] Step 1 — first-pick stamped the UUIDv7 + seeded targets.json
- [ ] Step 2 — re-pick left source byte-identical + upserted targets
- [ ] Step 3 — PHASE-7.5 gate: primary miss → fallback promoted
      → targets.json rewritten with old primary at `fallbacks[0]`
      → `.story` source UNCHANGED

Record the commit SHA of the tested build in the ticket before
sign-off.
