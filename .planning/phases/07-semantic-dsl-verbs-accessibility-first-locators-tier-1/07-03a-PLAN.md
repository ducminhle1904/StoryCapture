---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 03a
type: execute
wave: 3
depends_on:
  - 07-02
files_modified:
  - scripts/playwright-sidecar/picker/overlay/index.ts
  - scripts/playwright-sidecar/picker/overlay/finder-wrapper.ts
  - scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts
  - scripts/playwright-sidecar/picker/overlay/index.test.ts
  - scripts/playwright-sidecar/picker/generator.mjs
  - scripts/playwright-sidecar/picker/generator.test.mjs
  - scripts/playwright-sidecar/build-sea.mjs
  - scripts/playwright-sidecar/server.mjs
  - scripts/playwright-sidecar/server.test.mjs
  - scripts/playwright-sidecar/tests/fixtures/picker.html
  - scripts/playwright-sidecar/package.json
autonomous: true
requirements:
  - PHASE-7.4
tags: dsl, picker, overlay, sidecar
must_haves:
  truths:
    - "Overlay IIFE injected into every frame via addInitScript; window.__sc_picker.start/stop/isActive exposed to the page"
    - "User clicks a DOM element in the Playwright page so the overlay emits one event and the sidecar ranked generator produces ONE DSL line using Tier 1 syntax"
    - "Ranked emission order (first that verifies count()===1 wins): testid then role+name then field+label then text+visible then selector+css"
    - "Sidecar pickElement.start response.emitted field is the DSL line to be inserted by the desktop UI (07-03b)"
    - "User presses Esc while PICKING so the overlay deactivates and the sidecar returns { cancelled: true, reason: 'user-cancel' }"
    - "Picker refuses activation on chrome://, about:, view-source: URLs, returning { cancelled: true, reason: 'unsupported-url' }"
    - "Mid-pick framenavigated auto-cancels: sidecar resolves the pending pickElement.start with { cancelled: true, reason: 'navigation' } and overlay state is cleared"
    - "The overlay IIFE is inlined as a string constant inside the SEA binary at build time - strings <sea-binary> | grep __sc_picker matches at least one occurrence"
    - "Vitest + jsdom matrix covers 15 DOM shapes for the accessible-name subset"
    - "Real-Chromium vitest against picker.html fixture exercises all 5 ranks plus cancel + URL allowlist + framenavigated auto-cancel"
  artifacts:
    - path: "scripts/playwright-sidecar/picker/overlay/index.ts"
      provides: "Overlay IIFE entrypoint: window.__sc_picker.{start, stop, isActive}; click/hover/Esc handling; exposeBinding callback"
      contains: "__sc_picker"
    - path: "scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts"
      provides: "Subset of axe-core accessible-name algorithm covering 15 DOM shapes in the test matrix"
      contains: "accessibleName"
    - path: "scripts/playwright-sidecar/picker/generator.mjs"
      provides: "Ranked DSL emitter: testid then role+name then label then textExact then css; each verified via locator.count()"
      contains: "count"
    - path: "scripts/playwright-sidecar/build-sea.mjs"
      provides: "Extended SEA build pipeline inlining overlay IIFE as string constant before esbuild-to-CJS"
      contains: "OVERLAY_IIFE"
    - path: "scripts/playwright-sidecar/server.mjs"
      provides: "pickElement.{start,cancel,isActive} JSON-RPC handlers; exposeBinding('__sc_picker_emit'); addInitScript injection; framenavigated auto-cancel; URL allowlist. Response.emitted field is the wire contract for 07-03b."
      contains: "pickElement.start"
  key_links:
    - from: "server.mjs pickElement.start handler"
      to: "in-page overlay window.__sc_picker.start"
      via: "page.evaluate + context.addInitScript"
      pattern: "__sc_picker"
    - from: "overlay click handler"
      to: "server.mjs handler via exposeBinding"
      via: "window.__sc_picker_emit(candidatePayload)"
      pattern: "exposeBinding.*__sc_picker_emit"
    - from: "server.mjs receives candidate"
      to: "ranked generator (generator.mjs)"
      via: "emitDsl(page, candidate) - verifies count()===1 per rank"
      pattern: "emitDsl"
    - from: "ranked generator result"
      to: "JSON-RPC response `result.emitted`"
      via: "sidecar returns { emitted, locator, candidates } - WIRE CONTRACT consumed by 07-03b"
      pattern: "emitted"
---

<objective>
Ship the sidecar side of the Tier 2 MVP: the overlay IIFE bundle, the SEA embed, and the `pickElement.start/cancel/isActive` JSON-RPC surface whose response exposes a DSL line via `result.emitted`. The desktop-side consumption (Rust driver wrappers + Tauri commands + editor insertion + UI) lives in 07-03b.

Purpose: Produce a self-contained sidecar capability — overlay injects into any Playwright page, user click emits a candidate payload, ranked generator chooses the strongest Tier 1 locator that still resolves `count() === 1`, and the sidecar returns `{ emitted, locator, candidates }`. The desktop side in 07-03b treats `emitted` as the wire contract.

Output: Overlay TS bundle (esbuild IIFE inlined into the SEA binary at build time), ranked DSL generator, three new sidecar JSON-RPC methods (`pickElement.start/cancel/isActive`), vitest + jsdom accessible-name matrix (15 shapes), real-Chromium vitest covering all 5 ranks + cancel + URL allowlist + framenavigated.
</objective>

<scope>
**EXPLICITLY IN SCOPE (sidecar-side MVP):**
- Overlay injection via `context.addInitScript`.
- Overlay emits ONE click event; ranked generator picks the best single-match DSL line.
- Request/response only JSON-RPC surface (`pickElement.start/cancel/isActive`).
- Shadow-DOM piercing walker in the overlay; Playwright `>>` CSS piercing syntax.
- URL allowlist (refuse `chrome://`, `about:`, `view-source:`).
- Auto-cancel on `framenavigated` mid-pick.
- Real-Chromium vitest covering all 5 ranks + all cancel paths.

**EXPLICITLY OUT OF SCOPE (07-03b or later):**
- Rust driver wrappers (`pick_element_start` etc.) — 07-03b.
- Tauri commands `picker_*` + TS wrapper — 07-03b.
- `editorController` singleton + CodeMirror atomic insertion — 07-03b.
- `PickElementButton` + aria-live banner + Esc-on-desktop — 07-03b.
- `pickElement.hoverPreview` notifications — 07-04a.
- `.story.targets.json` persistence + step-id round-trip + self-healing — 07-04b/04c.

This plan ships the sidecar's wire contract (`result.emitted` is the DSL line). 07-03b holds the desktop side and the final user-observable acceptance test.
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
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-01-SUMMARY.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-02-SUMMARY.md
@CLAUDE.md

@scripts/playwright-sidecar/server.mjs
@scripts/playwright-sidecar/build-sea.mjs
@scripts/playwright-sidecar/package.json
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Overlay bundle — axe-accessible-name-lite + finder-wrapper + index.ts + jsdom vitest matrix</name>
  <files>scripts/playwright-sidecar/picker/overlay/index.ts, scripts/playwright-sidecar/picker/overlay/finder-wrapper.ts, scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts, scripts/playwright-sidecar/picker/overlay/index.test.ts, scripts/playwright-sidecar/package.json</files>
  <read_first>
    - scripts/playwright-sidecar/package.json (current deps; vitest presence; esbuild availability)
    - scripts/playwright-sidecar/server.mjs (how existing handlers access state.page and state.context)
    - .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md §Tier 2 MVP decisions
    - .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-RESEARCH-TIER2.md §Overlay bundle + §Risks#6
  </read_first>
  <behavior>
    - `axe-accessible-name-lite.accessibleName(el)` returns the correct name for all 15 DOM shapes in the matrix (enumerated in the action).
    - `inferRole(el)` returns the implicit role via tag + type attribute; `[role]` attribute wins over implicit.
    - `finder-wrapper.buildCss(el)` uses `@medv/finder` for light-DOM; for shadow-DOM walks up `shadowRoot.host` and emits Playwright piercing syntax (joins segments with ` >> `).
    - `window.__sc_picker.start()` installs capture-phase `mouseover`, `click`, `keydown` listeners on `document`; paints a fixed-position highlight div; blocks native click via `preventDefault()` + `stopImmediatePropagation()`.
    - `click()` builds `PickCandidatePayload { testId?, role?, accessibleName?, associatedLabel?, visibleText?, css, tagName, shadowDepth }` and calls `window.__sc_picker_emit(payload)`.
    - `keydown` Esc calls `window.__sc_picker_emit({ __cancel: true })` and `stop()`.
    - `stop()` removes listeners + highlight div; idempotent.
  </behavior>
  <action>
1. **Install overlay deps** in `scripts/playwright-sidecar/package.json` devDependencies: `@medv/finder@3.3.0` (exact pin per CLAUDE.md), and confirm `esbuild` + `vitest` + `jsdom` presence (jsdom may need adding: `-D jsdom`). Use: `pnpm --filter @storycapture/playwright-sidecar add -D @medv/finder@3.3.0 jsdom`.

2. **Create `scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts`.** Implement ONLY the subset needed for the 15-row matrix — NOT a full axe-core port. Algorithms required:
   - `aria-labelledby` chain (bounded depth 3 to prevent infinite recursion)
   - `aria-label` attribute
   - `<label for="id">` pointing at the element, OR wrapping `<label>Name <input></label>`
   - `<input placeholder>` (only when no label)
   - `<input type="submit|button" value="X">`
   - Inner text content, ignoring `aria-hidden="true"` subtrees and elements with `display: none` / `visibility: hidden`
   - `<img alt>`
   - Shadow slot projection: walk composed tree via `element.assignedSlot` / `shadowRoot.host`

   Signatures:
   ```ts
   export function accessibleName(el: Element, depth?: number): string;
   export function inferRole(el: Element): string | undefined;
   ```

   `inferRole` covers: button, link, heading (h1-h6), img, checkbox, radio, tab, menuitem, option, textbox (for input text/email/password/search/tel/url), combobox (for select). Prefer `[role]` attribute over implicit.

3. **Create `scripts/playwright-sidecar/picker/overlay/finder-wrapper.ts`:**
   ```ts
   import { finder } from "@medv/finder";
   export function buildCss(el: Element): string {
     const segments: string[] = [];
     let current: Element | null = el;
     while (current) {
       const root = current.getRootNode();
       if (root instanceof ShadowRoot) {
         segments.unshift(finder(current, { root: root as any }));
         current = root.host;
       } else {
         segments.unshift(finder(current));
         current = null;
       }
     }
     return segments.join(" >> ");
   }
   ```
   The ` >> ` join is Playwright's piercing combinator; the sidecar passes the resulting string to `page.locator(...)` which natively understands it.

4. **Create `scripts/playwright-sidecar/picker/overlay/index.ts`** — the IIFE entry. It must:
   - Declare `window.__sc_picker = { start, stop, isActive }`
   - `start()` installs capture-phase listeners; paints a fixed-position 2px-solid-orange highlight div following the hovered element's bounding rect (updated via rAF)
   - On `click`: `event.preventDefault() + event.stopImmediatePropagation()`, build payload via `accessibleName`, `inferRole`, `buildCss`; call `window.__sc_picker_emit(payload)`
   - On `keydown` Escape: call `window.__sc_picker_emit({ __cancel: true })` and `stop()`
   - `stop()` removes listeners + highlight div, sets active=false, idempotent
   - No default export (esbuild `--format=iife` wraps the whole file)

5. **Create `scripts/playwright-sidecar/picker/overlay/index.test.ts`** — vitest with `// @vitest-environment jsdom` header. 15 rows as described:
   1. `<button>Save</button>` → name "Save", role "button"
   2. `<button aria-label="Close">X</button>` → name "Close", role "button"
   3. `<input aria-labelledby="x"><span id="x">Email</span>` → name "Email"
   4. `<label for="e">Email</label><input id="e">` → name "Email" (computed on input)
   5. `<label>Name <input></label>` → name "Name" (wrapping label)
   6. `<input placeholder="Search">` → name "Search"
   7. `<a href="#">Docs</a>` → name "Docs", role "link"
   8. `<img alt="Hero">` → name "Hero", role "img"
   9. `<h1>Dashboard</h1>` → name "Dashboard", role "heading"
   10. Nested aria-labelledby chain (depth 2) → use deepest resolved label
   11. aria-label wins over inner text when both present
   12. Empty/whitespace-only text → empty string
   13. `<button><span>Save</span> <span aria-hidden="true">X</span></button>` → name "Save" (aria-hidden ignored)
   14. `<input type="submit" value="Go">` → name "Go"
   15. Shadow DOM slot projection → name is from slotted child text

   Add a separate `describe` block for `inferRole` covering 8 rows (button, link, heading, img, checkbox, radio, tab, role-attribute-wins).
  </action>
  <verify>
    <automated>cd scripts/playwright-sidecar && (pnpm test -- picker/overlay/index.test.ts 2>&1 | tee /tmp/t7-03a-t1.log; grep -E "(passed|failed|Tests)" /tmp/t7-03a-t1.log | tail -10) && cd - && test -f scripts/playwright-sidecar/picker/overlay/index.ts && test -f scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts && test -f scripts/playwright-sidecar/picker/overlay/finder-wrapper.ts && grep -n "__sc_picker" scripts/playwright-sidecar/picker/overlay/index.ts && grep -n "accessibleName" scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts && grep -n "inferRole" scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts && grep -n "@medv/finder" scripts/playwright-sidecar/package.json</automated>
  </verify>
  <acceptance_criteria>
    - All 4 overlay files exist on disk
    - `pnpm --filter @storycapture/playwright-sidecar test -- picker/overlay/index.test.ts` exits 0 with all 15 name rows + 8 role rows green
    - `grep -n "window.__sc_picker" scripts/playwright-sidecar/picker/overlay/index.ts` matches (overlay namespace exposed)
    - `grep -n "preventDefault" scripts/playwright-sidecar/picker/overlay/index.ts` matches (click is blocked — native nav must not fire)
    - `grep -n "stopImmediatePropagation" scripts/playwright-sidecar/picker/overlay/index.ts` matches
    - `grep -n "aria-hidden" scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts` matches (subtree skip logic present)
    - `grep -n "shadowRoot" scripts/playwright-sidecar/picker/overlay/finder-wrapper.ts` matches (shadow piercing present)
    - `grep -n "@medv/finder" scripts/playwright-sidecar/package.json` matches with version `3.3.0` (exact pin)
    - `grep -n "jsdom" scripts/playwright-sidecar/package.json` matches (test env available)
  </acceptance_criteria>
  <done>Overlay bundle source + axe-lite name/role subset + shadow-piercing CSS builder committed; 15-row accessible-name vitest matrix green in jsdom; deps pinned.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: SEA build pipeline — esbuild overlay IIFE and inline as string constant into server.cjs</name>
  <files>scripts/playwright-sidecar/build-sea.mjs, scripts/playwright-sidecar/server.mjs</files>
  <read_first>
    - scripts/playwright-sidecar/build-sea.mjs (current esbuild step at line ~50: `npx esbuild server.mjs --bundle ...`)
    - scripts/playwright-sidecar/server.mjs (where OVERLAY_IIFE will be referenced — addInitScript call)
    - .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-RESEARCH-TIER2.md §Risks#1 (SEA-embedded overlay bundle)
  </read_first>
  <behavior>
    - At `build-sea.mjs` runtime: BEFORE the `esbuild server.mjs` step, a new preceding step builds `picker/overlay/index.ts` into a single IIFE string and writes `picker/overlay/overlay.iife.js` (temp file in the sidecar dir).
    - `server.mjs` reads that file contents at sidecar-boot time via `fs.readFileSync(new URL('./picker/overlay/overlay.iife.js', import.meta.url), 'utf8')` into a `OVERLAY_IIFE` module-level constant.
    - The `esbuild server.mjs --bundle` step uses the `--loader:.js=text` treatment for the overlay file so that when `server.cjs` is produced, the IIFE contents are inlined as a JS string literal inside the bundle — no sibling-file read at SEA runtime.
    - Final SEA binary contains the string: `strings <binary> | grep __sc_picker` returns ≥1 hit.
  </behavior>
  <action>
1. **Edit `scripts/playwright-sidecar/build-sea.mjs`.** Insert a new step labeled "Step -1/5: bundle overlay IIFE" BEFORE the existing `Step 0/5: esbuild server.mjs`. It should:
   ```js
   console.log('[playwright-sidecar] Step -1/5: bundle overlay IIFE');
   const overlayOut = resolve(__dirname, 'picker', 'overlay', 'overlay.iife.js');
   execSync(
     `npx --yes esbuild picker/overlay/index.ts --bundle --format=iife --platform=browser --target=es2022 --outfile=${JSON.stringify(overlayOut)}`,
     { cwd: __dirname, stdio: 'inherit' },
   );
   ```

2. **In the existing esbuild server step**, add a `--loader:.iife.js=text` flag so imports ending in `.iife.js` are inlined as string literals:
   ```js
   execSync(
     `npx --yes esbuild server.mjs --bundle --platform=node --format=cjs --external:playwright-core --loader:.iife.js=text --outfile=server.cjs`,
     { cwd: __dirname, stdio: 'inherit' },
   );
   ```

3. **In `scripts/playwright-sidecar/server.mjs`**, import the overlay as text at the top of the file:
   ```js
   // The overlay IIFE is built by build-sea.mjs (Task 2 of Plan 07-03a) into
   // picker/overlay/overlay.iife.js. esbuild's `--loader:.iife.js=text` setting
   // inlines the file contents as a string literal at SEA build time, so the
   // sidecar does NOT read a sibling file at runtime (SEA has no FS access
   // to bundle-relative paths).
   import OVERLAY_IIFE from './picker/overlay/overlay.iife.js';
   ```
   Note: for dev (pre-SEA) runs, Node's ESM loader does NOT understand the `text` loader — so ALSO provide a fallback for `node server.mjs` dev mode. Handle it with a small wrapper:
   ```js
   import { readFileSync } from 'node:fs';
   import { fileURLToPath } from 'node:url';
   let OVERLAY_IIFE;
   try {
     OVERLAY_IIFE = (await import('./picker/overlay/overlay.iife.js', { assert: { type: 'text' } })).default;
   } catch {
     // Dev-mode fallback: read the file from disk relative to this module.
     const overlayPath = fileURLToPath(new URL('./picker/overlay/overlay.iife.js', import.meta.url));
     OVERLAY_IIFE = readFileSync(overlayPath, 'utf8');
   }
   ```
   The `try/catch` means dev `pnpm test` works without the `text` import assertion (which is not universally supported), and the SEA bundle succeeds via the esbuild text loader's substitution of the `import` with the inlined string.

4. **Add a pre-test script** in `scripts/playwright-sidecar/package.json`: `"pretest": "npx --yes esbuild picker/overlay/index.ts --bundle --format=iife --platform=browser --target=es2022 --outfile=picker/overlay/overlay.iife.js"` — ensures the IIFE exists before vitest runs (Task 3 tests need it).

5. **Smoke check.** After a local SEA build (`node build-sea.mjs --target aarch64-apple-darwin` on macOS or the appropriate triple), confirm `strings apps/desktop/src-tauri/binaries/playwright-sidecar-<triple> | grep __sc_picker` returns ≥1 hit. This check is captured in `<verify>` as a best-effort (skipped if the binaries dir lacks a fresh build).
  </action>
  <verify>
    <automated>cd scripts/playwright-sidecar && npx --yes esbuild picker/overlay/index.ts --bundle --format=iife --platform=browser --target=es2022 --outfile=picker/overlay/overlay.iife.js 2>&1 | tail -5 && test -f picker/overlay/overlay.iife.js && grep -c "__sc_picker" picker/overlay/overlay.iife.js && cd - && grep -n "OVERLAY_IIFE" scripts/playwright-sidecar/server.mjs && grep -n "Step -1/5" scripts/playwright-sidecar/build-sea.mjs && grep -n "loader:.iife.js=text" scripts/playwright-sidecar/build-sea.mjs && grep -n "\"pretest\"" scripts/playwright-sidecar/package.json</automated>
  </verify>
  <acceptance_criteria>
    - `scripts/playwright-sidecar/picker/overlay/overlay.iife.js` can be generated by `npx esbuild` (the verify block does so)
    - `grep -c "__sc_picker" scripts/playwright-sidecar/picker/overlay/overlay.iife.js` ≥ 1 (overlay namespace present in built IIFE)
    - `grep -n "OVERLAY_IIFE" scripts/playwright-sidecar/server.mjs` matches ≥ 1 (constant exported and referenced)
    - `grep -n "Step -1/5" scripts/playwright-sidecar/build-sea.mjs` matches (new build step present)
    - `grep -n "loader:.iife.js=text" scripts/playwright-sidecar/build-sea.mjs` matches (text loader wired into server.cjs bundle step)
    - `grep -n "pretest" scripts/playwright-sidecar/package.json` matches (overlay IIFE built before vitest runs)
    - On a system that ran `node build-sea.mjs` to completion, `strings apps/desktop/src-tauri/binaries/playwright-sidecar-<triple> | grep __sc_picker | wc -l` ≥ 1 (documented in SUMMARY; not asserted in the automated verify to keep CI green on platforms without SEA)
  </acceptance_criteria>
  <done>Overlay IIFE is built as a pre-test step + inlined into server.cjs via esbuild's text loader; OVERLAY_IIFE module constant references it with a dev-mode fs-read fallback; SEA build pipeline has a new Step -1/5 that produces the IIFE.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Ranked DSL generator + pickElement sidecar handlers + real-Chromium vitest + picker.html fixture</name>
  <files>scripts/playwright-sidecar/picker/generator.mjs, scripts/playwright-sidecar/picker/generator.test.mjs, scripts/playwright-sidecar/server.mjs, scripts/playwright-sidecar/server.test.mjs, scripts/playwright-sidecar/tests/fixtures/picker.html</files>
  <read_first>
    - scripts/playwright-sidecar/server.mjs (handler dispatch table + state.page/state.context)
    - scripts/playwright-sidecar/server.test.mjs (existing spawnSidecar helper + test structure)
    - scripts/playwright-sidecar/tests/fixtures/tier1.html (existing fixture pattern from 07-02)
    - .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md §Tier 2 MVP §Ranked generator
  </read_first>
  <behavior>
    - `emitDsl(page, payload)` returns `{ emitted: string, locator: { kind, value }, candidates: Array<{ kind, value, score }> }`
    - Ranked order (FIRST resolving count()===1 wins):
      1. `click testid "<payload.testId>"` (if payload.testId)
      2. `click <role> "<accessibleName>"` (if payload.role and payload.accessibleName) — verified via `page.getByRole(role, { name, exact: true }).count() === 1`
      3. `click field "<payload.associatedLabel>"` (if payload.associatedLabel) — verified via `page.getByLabel(label, { exact: true }).count() === 1`
      4. `click text "<payload.visibleText>"` (if payload.visibleText) — verified via `page.getByText(text, { exact: true }).count() === 1`
      5. `click selector "<payload.css>"` — ALWAYS available as last resort
    - MVP uses the `click` verb for all emissions. Users edit the verb after insertion if they want `fill` or `hover`.
    - `pickElement.start({ timeoutMs })` handler:
      - Refuses on `chrome:` / `about:` / `view-source:` → `{ cancelled: true, reason: 'unsupported-url' }`
      - Installs `exposeBinding('__sc_picker_emit', handler)` on the page
      - Registers a `framenavigated` listener that resolves the pending start with `{ cancelled: true, reason: 'navigation' }`
      - Calls `page.evaluate(() => window.__sc_picker.start())`
      - Awaits the exposeBinding callback or timeout
      - On callback with `{ __cancel: true }` → `{ cancelled: true, reason: 'user-cancel' }`
      - On callback with a real payload → runs `emitDsl(page, payload)` and returns its result
      - Always cleans up: unregisters binding, removes framenavigated listener, calls `page.evaluate(() => window.__sc_picker?.stop())`
    - `pickElement.cancel()` → calls `page.evaluate(() => window.__sc_picker?.stop())` and resolves the pending start promise with `{ cancelled: true, reason: 'user-cancel' }`; returns `{ ok: true }`
    - `pickElement.isActive()` → returns `{ active: <boolean> }` based on `state.pickerPending` flag
    - Per-frame injection: `context.addInitScript({ content: OVERLAY_IIFE })` is called ONCE on context creation (move this into the existing `launch` handler immediately after `browser.newContext(...)`)
    - **WIRE CONTRACT** (consumed by 07-03b): the `pickElement.start` success response always has a `emitted: string` field. This is the DSL line the desktop UI will insert at cursor. The contract comment in `server.mjs` above the handler MUST read: `// CONTRACT: pickElement.start response.emitted is the DSL line to insert at cursor. Drift breaks 07-03b UI flow.`
  </behavior>
  <action>
1. **Create `scripts/playwright-sidecar/picker/generator.mjs`:**
   ```js
   // Ranked DSL generator. Each candidate is verified via locator.count()===1
   // before emission. Returns the FIRST that resolves uniquely.
   //
   // Input: { testId?, role?, accessibleName?, associatedLabel?, visibleText?, css, tagName, shadowDepth }
   // Output: { emitted: string, locator: { kind, value }, candidates: Array<{ kind, value, score }> }

   function escapeDslString(s) {
     // DSL strings are double-quoted; escape backslash and double-quote.
     return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
   }

   async function isUnique(locator) {
     try { return (await locator.count()) === 1; } catch { return false; }
   }

   export async function emitDsl(page, payload) {
     const candidates = [];
     const tryRank = async (kind, value, dsl, locator, score) => {
       const unique = await isUnique(locator);
       candidates.push({ kind, value, score, unique });
       if (unique) return { emitted: dsl, locator: { kind, value } };
       return null;
     };

     // 1. TestId
     if (payload.testId) {
       const hit = await tryRank(
         'testid', payload.testId,
         `click testid "${escapeDslString(payload.testId)}"`,
         page.getByTestId(payload.testId), 1.0,
       );
       if (hit) return { ...hit, candidates };
     }

     // 2. Role + accessible name
     if (payload.role && payload.accessibleName) {
       const hit = await tryRank(
         'role', { role: payload.role, name: payload.accessibleName },
         `click ${payload.role} "${escapeDslString(payload.accessibleName)}"`,
         page.getByRole(payload.role, { name: payload.accessibleName, exact: true }), 0.9,
       );
       if (hit) return { ...hit, candidates };
     }

     // 3. Associated label
     if (payload.associatedLabel) {
       const hit = await tryRank(
         'label', payload.associatedLabel,
         `click field "${escapeDslString(payload.associatedLabel)}"`,
         page.getByLabel(payload.associatedLabel, { exact: true }), 0.8,
       );
       if (hit) return { ...hit, candidates };
     }

     // 4. Exact visible text
     if (payload.visibleText) {
       const hit = await tryRank(
         'text_exact', payload.visibleText,
         `click text "${escapeDslString(payload.visibleText)}"`,
         page.getByText(payload.visibleText, { exact: true }), 0.5,
       );
       if (hit) return { ...hit, candidates };
     }

     // 5. Fallback CSS
     const cssDsl = `click selector "${escapeDslString(payload.css)}"`;
     candidates.push({ kind: 'selector', value: payload.css, score: 0.1, unique: true });
     return { emitted: cssDsl, locator: { kind: 'selector', value: payload.css }, candidates };
   }
   ```

2. **Add `scripts/playwright-sidecar/picker/generator.test.mjs`.** Unit tests for the `escapeDslString` helper and for the fallback-to-CSS behavior. 5 tests:
   - Escape double quote: `input 'Hello "world"'` → `Hello \"world\"`
   - Escape backslash: `input 'C:\\x'` → `C:\\\\x`
   - testId wins when unique (stubbed `count()` mock)
   - role+name wins when testId absent but role+name unique
   - CSS fallback when all higher ranks non-unique

3. **Extend `scripts/playwright-sidecar/server.mjs`.** Add new handlers plus modify the `launch` handler to call `context.addInitScript({ content: OVERLAY_IIFE })`:
   ```js
   // Inside launch handler, immediately after `state.context = await browser.newContext(...)`:
   await state.context.addInitScript({ content: OVERLAY_IIFE });

   // New handlers + state additions at top of file:
   state.pickerPending = null;  // { resolve, reject, timeoutHandle, framenavListener }

   // CONTRACT: pickElement.start response.emitted is the DSL line to insert at cursor. Drift breaks 07-03b UI flow.
   handlers['pickElement.start'] = async ({ timeoutMs = 60000 } = {}) => {
     if (!state.page) throw new Error('no page - call launch first');
     const url = state.page.url() || '';
     if (/^(chrome|about|view-source):/.test(url)) {
       return { cancelled: true, reason: 'unsupported-url' };
     }
     if (state.pickerPending) throw new Error('picker already active');

     return await new Promise(async (resolve, reject) => {
       const framenavListener = () => {
         cleanup();
         resolve({ cancelled: true, reason: 'navigation' });
       };
       const timeoutHandle = setTimeout(() => {
         cleanup();
         resolve({ cancelled: true, reason: 'timeout' });
       }, timeoutMs);
       const cleanup = async () => {
         clearTimeout(timeoutHandle);
         try { state.page.off('framenavigated', framenavListener); } catch {}
         try { await state.page.evaluate(() => window.__sc_picker?.stop()); } catch {}
         try { await state.page.unrouteAll?.(); } catch {}  // ignore
         state.pickerPending = null;
       };
       state.pickerPending = { resolve, cleanup };
       state.page.on('framenavigated', framenavListener);

       await state.page.exposeBinding('__sc_picker_emit', async ({ }, payload) => {
         if (!state.pickerPending) return;
         await cleanup();
         if (payload && payload.__cancel) {
           resolve({ cancelled: true, reason: 'user-cancel' });
           return;
         }
         try {
           const { emitDsl } = await import('./picker/generator.mjs');
           const result = await emitDsl(state.page, payload);
           resolve(result);
         } catch (e) {
           resolve({ cancelled: true, reason: `generator-error: ${e.message}` });
         }
       }).catch(() => { /* already exposed is OK */ });

       try {
         await state.page.evaluate(() => window.__sc_picker.start());
       } catch (e) {
         await cleanup();
         reject(e);
       }
     });
   };

   handlers['pickElement.cancel'] = async () => {
     if (state.pickerPending) {
       await state.pickerPending.cleanup();
       state.pickerPending.resolve({ cancelled: true, reason: 'user-cancel' });
     }
     return { ok: true };
   };

   handlers['pickElement.isActive'] = async () => ({ active: !!state.pickerPending });
   ```

4. **Create `scripts/playwright-sidecar/tests/fixtures/picker.html`** — a widget gallery covering all 5 rank cases:
   ```html
   <!doctype html>
   <html><head><title>Picker Fixture</title></head><body>
     <!-- Rank 1: testid -->
     <button data-testid="save-btn">Save</button>
     <!-- Rank 2: role+name (no testid) -->
     <a href="#docs">Docs</a>
     <!-- Rank 3: field/label (form input with <label for>) -->
     <label for="email">Email</label><input id="email" type="email">
     <!-- Rank 4: exact visible text (non-interactive span) -->
     <span>Learn more about it</span>
     <!-- Rank 5: CSS fallback (generic div, no useful a11y signals) -->
     <div class="mystery-widget" style="width:60px;height:20px;background:#eee"></div>
     <!-- Decoys: substring-near-miss for exact-text rank -->
     <p>Learn more</p>
     <p>Learn more stuff</p>
   </body></html>
   ```

5. **Extend `scripts/playwright-sidecar/server.test.mjs`** with a Tier 2 MVP block that drives real Chromium — all 9 cases from original 07-03 Task 3 (rank 1–5, user-cancel, URL allowlist, framenavigated auto-cancel, isActive transitions). Use `__test_simulate_pick` / `__test_simulate_pick_cancel` helper handlers (Task 3 step 6 below) to synthesize DOM events deterministically.

   Assertions identical to original 07-03 Task 3 (rank 1 emits `'click testid "save-btn"'`; rank 2 `'click link "Docs"'`; rank 3 `'click field "Email"'`; rank 4 `'click text "Learn more about it"'`; rank 5 `locator.kind === "selector"`; user-cancel → `{ cancelled: true, reason: 'user-cancel' }`; about:blank → `unsupported-url`; mid-pick navigate → `navigation`; isActive reflects state).

6. **Add two test-only hook handlers** in `server.mjs` to simulate overlay clicks without flaky mouse coordination in CI:
   ```js
   handlers['__test_simulate_pick'] = async ({ selector }) => {
     await state.page.evaluate((sel) => {
       const el = document.querySelector(sel);
       if (!el) throw new Error('no element for ' + sel);
       el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
     }, selector);
     return { ok: true };
   };
   handlers['__test_simulate_pick_cancel'] = async () => {
     await state.page.evaluate(() => {
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     });
     return { ok: true };
   };
   ```
   These are guarded by the `__test_` prefix convention already used by `__test_set_remote_browser`.

   Document that these handlers are test-only at the top of the handlers table:
   ```js
   // Handlers prefixed `__test_` are test-only hooks. The Rust driver never
   // calls them. They exist because vitest needs deterministic simulation
   // of user input that would otherwise be flaky in headless CI.
   ```
  </action>
  <verify>
    <automated>cd scripts/playwright-sidecar && (pnpm test 2>&1 | tee /tmp/t7-03a-t3.log; grep -E "(Phase 7 Tier 2 MVP|passed|failed)" /tmp/t7-03a-t3.log | tail -15) && cd - && test -f scripts/playwright-sidecar/picker/generator.mjs && test -f scripts/playwright-sidecar/tests/fixtures/picker.html && grep -n "emitDsl" scripts/playwright-sidecar/picker/generator.mjs && grep -n "pickElement.start" scripts/playwright-sidecar/server.mjs && grep -n "pickElement.cancel" scripts/playwright-sidecar/server.mjs && grep -n "pickElement.isActive" scripts/playwright-sidecar/server.mjs && grep -n "addInitScript.*OVERLAY_IIFE" scripts/playwright-sidecar/server.mjs && grep -n "framenavigated" scripts/playwright-sidecar/server.mjs && grep -n "unsupported-url" scripts/playwright-sidecar/server.mjs && grep -n "__test_simulate_pick" scripts/playwright-sidecar/server.mjs && grep -n "result.emitted" scripts/playwright-sidecar/server.mjs && grep -n "CONTRACT: pickElement.start response.emitted" scripts/playwright-sidecar/server.mjs</automated>
  </verify>
  <acceptance_criteria>
    - `scripts/playwright-sidecar/picker/generator.mjs` exists and exports `emitDsl`
    - `scripts/playwright-sidecar/tests/fixtures/picker.html` exists and contains all 5 rank shapes (testid, link, label+input, visible span, mystery-widget div)
    - `grep -c "pickElement.start" scripts/playwright-sidecar/server.mjs` ≥ 1
    - `grep -c "pickElement.cancel" scripts/playwright-sidecar/server.mjs` ≥ 1
    - `grep -c "pickElement.isActive" scripts/playwright-sidecar/server.mjs` ≥ 1
    - `grep -n "addInitScript" scripts/playwright-sidecar/server.mjs` matches in the launch handler context (OVERLAY_IIFE injected per context)
    - `grep -n "framenavigated" scripts/playwright-sidecar/server.mjs` matches (auto-cancel)
    - `grep -n "unsupported-url" scripts/playwright-sidecar/server.mjs` matches (URL allowlist)
    - `grep -n "exposeBinding.*__sc_picker_emit" scripts/playwright-sidecar/server.mjs` matches
    - **Wire contract:** `grep -n "result.emitted" scripts/playwright-sidecar/server.mjs` returns ≥1 hit AND the CONTRACT comment `// CONTRACT: pickElement.start response.emitted is the DSL line to insert at cursor. Drift breaks 07-03b UI flow.` appears above the `pickElement.start` handler
    - `pnpm --filter @storycapture/playwright-sidecar test` exits 0 with all 9 Tier 2 MVP cases + all pre-existing cases green (including Tier 1 from 07-02 — regression)
    - Generator unit tests (5) green
  </acceptance_criteria>
  <done>Ranked generator + three pickElement handlers + per-context overlay injection via addInitScript + URL allowlist + framenavigated auto-cancel all implemented; real-Chromium vitest against picker.html covers all 5 ranks, cancel, unsupported-url, framenavigated, and isActive; wire contract for `result.emitted` documented above the handler; no notification plumbing added (scope reduction explicit).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Playwright page DOM ↔ overlay IIFE | Overlay runs with page privileges (document.* APIs). Injected via `addInitScript` (not a MAIN-world injection from CDP). The overlay writes to `window.__sc_picker_emit` which is an `exposeBinding` function — calling it crosses into the sidecar Node process. |
| Sidecar Node ↔ Rust host | Existing JSON-RPC; new methods `pickElement.*` are fixed-vocabulary and do not accept selector strings from untrusted sources — the payload is computed by the overlay inside the same page, then transmitted to the sidecar for verification (count() checks) before emission. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-03a-01 | Injection | Overlay emits DSL strings containing user-chosen accessible names or label text | mitigate | `generator.mjs` escapes `\` and `"` via `escapeDslString` before interpolating into the DSL line. The DSL is not `eval`'d anywhere — it flows through the pest parser which literal-matches strings. |
| T-07-03a-02 | Tampering | Overlay IIFE runs in any page including potentially-hostile sites | accept | The user explicitly drives the Playwright browser to the target URL; the overlay is only active during explicit PICKING mode (windowed by the user clicking Pick); hostile pages cannot silently activate it because `addInitScript` gates activation via `window.__sc_picker.start()` which is only called by the sidecar in response to a Tauri command. |
| T-07-03a-03 | Information Disclosure | Overlay reads DOM contents the user just chose | accept | Data stays in-process; only the constructed DSL line + locator metadata crosses back to the desktop app. No network egress. |
| T-07-03a-04 | Denial of Service | `count()` verification on Rank 4 (exact text) is O(n) over text nodes; very large pages may be slow | accept | Per-rank verification is gated by prior rank failure; most picks resolve at Rank 1 or 2. Timeout defaults to 60s. |
| T-07-03a-05 | Elevation of Privilege | `exposeBinding` bridges page → Node; a hostile page could spam `__sc_picker_emit` | mitigate | The handler checks `state.pickerPending` is non-null and consumes it exactly once (cleanup + resolve). After the first call the binding effectively no-ops. Additional calls don't corrupt state. |
| T-07-03a-06 | Tampering | SEA-embedded overlay IIFE could be tampered by bundle injection | accept | Same trust boundary as the rest of the sidecar — covered by the existing Developer ID signing + notarization in Plan 01-10. |
</threat_model>

<verification>
1. `pnpm --filter @storycapture/playwright-sidecar test` exits 0 (all sidecar vitest incl. 15-row jsdom + 9 real-Chromium Tier 2 cases + Tier 1 regression)
2. SEA overlay embed: on a local build, `strings apps/desktop/src-tauri/binaries/playwright-sidecar-<triple> | grep __sc_picker` ≥ 1 hit (documented in SUMMARY; not a CI gate because building the SEA requires platform-specific tooling)
3. `grep -n "addInitScript" scripts/playwright-sidecar/server.mjs` matches (per-context overlay injection)
4. `grep -n "pickElement.start" scripts/playwright-sidecar/server.mjs` matches
5. **Wire contract**: `grep -n "result.emitted" scripts/playwright-sidecar/server.mjs` returns ≥1 hit AND the CONTRACT comment appears above the `pickElement.start` handler
</verification>

<success_criteria>
- [ ] Overlay bundle (axe-lite + finder-wrapper + index.ts) + 15-row jsdom matrix green
- [ ] SEA build pipeline has new overlay IIFE step; text loader wired; OVERLAY_IIFE module constant referenced in server.mjs with dev-mode fs fallback
- [ ] `pickElement.start/cancel/isActive` JSON-RPC handlers; per-context `addInitScript(OVERLAY_IIFE)`; URL allowlist; framenavigated auto-cancel; exposeBinding plumbing
- [ ] Real-Chromium vitest against picker.html green for all 5 ranks + cancel + unsupported-url + framenavigated + isActive (9 cases)
- [ ] Wire contract between sidecar and 07-03b: CONTRACT comment above `pickElement.start` handler documents `result.emitted` as the DSL line; grep verifies both comment and usage
- [ ] MVP scope discipline: NO `pickElement.hoverPreview`, NO `.story.targets.json`, NO Rust wrappers (07-03b), NO desktop UI
</success_criteria>

<output>
After completion, create `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-03a-SUMMARY.md` capturing:
- Final list of files added/modified
- Overlay bundle size (KB) after esbuild
- `strings` grep result against the SEA binary (if built locally)
- Vitest run command + timing for the 15-row matrix + the 9 real-Chromium cases
- Any quirks encountered with `addInitScript`, `exposeBinding`, or `framenavigated` timing
- Explicit confirmation of the `result.emitted` wire contract — this is the field 07-03b will consume
</output>
