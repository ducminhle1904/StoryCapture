# Phase 7 Plan 03b — Element Picker Smoke Runbook

Manual end-to-end verification for the desktop ↔ sidecar picker flow.
Run after building the SEA sidecar + `pnpm tauri dev`.

## Prerequisites

1. `pnpm --filter playwright-sidecar build:overlay` (compiles `overlay.iife.js`)
2. `pnpm --filter playwright-sidecar build:sea` (produces SEA binary in `apps/desktop/src-tauri/binaries/`)
3. `pnpm --filter @storycapture/desktop tauri:dev`

## Happy Path — example.com testid

1. Open or create a project; switch to Editor.
2. Author a minimal story:
   ```
   meta {
     app: "https://example.com"
   }
   scene "open" {
     navigate "/"
   }
   ```
3. Click **Record** → wait for the Playwright window to open `https://example.com`.
4. Verify the **Pick element** button (crosshair icon) is **enabled** in the toolbar.
5. Click **Pick element**. The aria-live banner appears at the top of the desktop window:
   `PICKING — press Esc to cancel`.
6. Inside the Playwright window, click the **More information...** link.
7. **Expected:** the banner disappears; the editor receives a new line at cursor:
   - either `click link "More information..."` (rank 2 role+name)
   - or `click testid "..."` if the page emits a data-testid (example.com does not)
8. **Expected:** `sonner` success toast: `Inserted: <emitted DSL>`.
9. **Expected:** the new line is exactly one undo away — press ⌘Z; the line vanishes.

## Cancellation Paths

### Esc from desktop window
1. Start a recording → click **Pick element** → banner appears.
2. Without leaving the desktop window, press **Esc**.
3. **Expected:** banner disappears; `Picking cancelled` neutral toast; no line inserted.

### Esc from browser
1. Start a recording → click **Pick element** → banner appears.
2. Click into the Playwright Chromium window so it has focus.
3. Press **Esc** inside the browser window.
4. **Expected:** sidecar resolves with `{ cancelled: true, reason: "user-cancel" }`; banner disappears; same toast as above.

### Mid-pick navigation
1. Start a recording with `meta.app: "https://example.com"`.
2. Click **Pick element** → banner appears.
3. In the Playwright window, type a new URL into the address bar (e.g. `https://www.iana.org`) and press Enter — i.e. trigger a `framenavigated` while picking.
4. **Expected:** sidecar resolves with `{ cancelled: true, reason: "navigation" }`; banner disappears; toast: `Picking cancelled — page navigated`.

### Unsupported URL
1. Start a recording.
2. In the Playwright window, navigate to `about:blank` (or `chrome://settings`).
3. Click **Pick element**.
4. **Expected:** sidecar resolves immediately with `{ cancelled: true, reason: "unsupported-url" }`; toast: `Cannot pick on this page (unsupported URL)`.

### Timeout
1. Start a recording → click **Pick element**.
2. Do nothing for 60 s.
3. **Expected:** banner disappears at 60 s; toast: `Picking timed out`.

## Undo Smoke

Pick → undo → repick → undo:

1. Pick a real element. Verify line appears.
2. Press ⌘Z. Verify line is gone (single undo entry — proves the
   `userEvent: "input.pick"` + single dispatch).
3. Repeat the pick.
4. Press ⌘Z. Verify the second pick is undone.
5. Press ⌘Z again. Verify the cursor lands at the position the editor had
   before the very first pick (only if you'd typed earlier).

## Known Limitations

- **Closed shadow DOM** (`attachShadow({mode:"closed"})`): elements
  inside closed roots are not reachable by the overlay's
  `elementsFromPoint` walker. The picker ignores them; CSS rank 5
  fallback may emit a brittle outer-shell selector. Documented; out of scope.
- **Cross-origin iframes**: Playwright's `addInitScript` injects per-context;
  cross-origin frames live in a different context the overlay isn't in.
  Picker resolves with `{ cancelled: true, reason: "user-cancel" }` if the
  user clicks inside one (the click never reaches the overlay).
- **Headless mode**: the overlay requires a headed window. Picker disables
  in headless launches.
- **Already-visible elements only**: MVP picker doesn't scroll-to-element
  during active picking. The user must scroll first; runtime
  `scrollIntoViewIfNeeded` handles execution-time scroll.
