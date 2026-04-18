# Phase 7 Tier 2 Research — "Pick from browser" element picker

**Researched:** 2026-04-17
**Domain:** DSL authoring UX + Playwright sidecar JSON-RPC extension + CodeMirror insertion
**Confidence:** HIGH (codebase verified); MEDIUM on shadow-piercing + SEA resource embedding
**Scope:** ADDITION to Phase 7. Tier 1 (07-01, 07-02) remains the primary deliverable.

## Background

Tier 1 gave users role-qualified DSL verbs. Tier 2 closes the authoring-UX gap: a "Pick element"
button in the desktop app that drives the Playwright-controlled browser into a hover-to-select
mode. On click the app inserts a DSL line at the editor cursor using the **highest-ranked Tier 1
form** — `click button "Save"` > `click text "Save"` > `click selector "..."`. A ranked fallback
array is persisted in a sibling `.story.targets.json` so re-runs can promote a later candidate if
the primary locator breaks.

This research assumes every `[LOCKED]` decision from `07-CONTEXT.md` holds (role-qualified verbs,
`SelectorOrText::{Role,Label,TextExact}`, sidecar `locate()` branches, wire encoding
`role=<kebab>:<name>`). Tier 2 consumes these; nothing here mutates Tier 1.

## Code Map Verification

All ten earlier claims were checked against the actual code. Status column:
V = verified true, V* = verified with an adjustment, N = needs decision.

| # | Claim | Status | Evidence |
|---|-------|--------|----------|
| 1 | Picker via `addInitScript` + `exposeBinding`, not `_codegen` | V | No `_codegen` usage in `server.mjs`; Playwright public API supports both hooks. |
| 2 | Overlay bundle Vite lib-mode IIFE ~20 kB using `@medv/finder` + trimmed axe accessible-name | V* | `@medv/finder` is unvendored (new dep). Bundle will live under `scripts/playwright-sidecar/picker/overlay/` and be built at sidecar build time. **SEA caveat:** `server.cjs` bundler must embed the IIFE as a string constant (esbuild `--loader:.js=text`) — the SEA runtime has no FS access to a sibling file. |
| 3 | Ranked generator mirrors SmartSelector order | V* | Adjusted order per live code: **TestId → Role+Name (exact) → Label (exact) → TextExact → CSS (@medv/finder)**. Verified each with `page.locator(...).count() === 1` before emitting. |
| 4 | New sidecar methods `pickElement.start/cancel/isActive` + `pickElement.hoverPreview` notification | V* | Current JSON-RPC reader in `crates/automation/src/playwright_driver.rs:86-109` dispatches by `resp.id` only. **No branch for notifications** (`id absent`). Needs a helper — see Open Question Q1. |
| 5 | Rust driver reader loop must branch id-present vs id-absent | V | Confirmed at `playwright_driver.rs:92` — `JsonRpcResponse.id: u64` (non-optional). Messages without `id` currently log as "bad JSON". |
| 6 | Editor integration via CodeMirror `view.dispatch({changes, selection})` + Zustand action | V* | `story-editor.tsx:29` holds `cmRef` privately. **`view` is not exposed** to any store. Either: (a) lift `cmRef` into a Zustand ref-slot, or (b) add a module-level `editorController` singleton set by `StoryEditor` on mount. Recommend (b) — Zustand holding React refs is an anti-pattern. |
| 7 | Fallback persistence in `.story.targets.json` keyed by step UUIDv7 via trailing `#@id=` comment round-trip | N | The pest grammar has no `#@id=` token today. Round-tripping means: (1) parser preserves trailing line comments, (2) formatter emits them. Currently the DSL has no formatter at all. See Plan Split — this is why MVP skips ranked-array. |
| 8 | iframe + shadow DOM: per-frame injection; shadow via `elementsFromPoint` + Playwright `>>` piercing | V* | Playwright's `>>` piercing syntax is supported. Per-frame injection uses `context.addInitScript` (applies to every frame automatically). `@medv/finder` does NOT cross shadow roots — must add a custom piercing walker. MEDIUM confidence on complex closed shadow-DOM cases (e.g. Salesforce Lightning). |
| 9 | Reuse recording-session browser + banner + Esc-to-cancel | V | `recording-view.tsx` already listens to sidecar events via `listen("...")`. Banner = new React component + Esc key handler. `state.page` in `server.mjs` is the single reusable page. |
| 10 | Phase A (9d) = picker+primary; Phase B (5d) = ranked+self-healing | V* | Revised below — see Plan Split. |

**New finding:** `target_to_json()` in `playwright_driver.rs:348` only handles 4 legacy variants
— it does **NOT YET** serialize `Role/Label/TextExact`. Plan 07-02 (Task 2/3) must already cover
this OR Tier 2 must ship the patch. Flag for Tier 1 ship to double-check; Tier 2 planning assumes
this is handled.

## Locked Decisions (copy-pasteable into CONTEXT-TIER2.md)

### Scope
- **In scope (MVP = Plan 07-03):** Pick-element button; overlay in Playwright-controlled page; ranked generator emits ONE best DSL line verified by `count()===1`; insertion at CodeMirror cursor via an `editorController` singleton; Esc-to-cancel banner; per-frame injection via `context.addInitScript`.
- **In scope (follow-up = Plan 07-04):** Ranked fallback array persisted to `.story.targets.json`; step UUID stamp via `#@id=` comment; parser round-trips comment; self-healing runtime that promotes a fallback when the primary misses.
- **Out of scope:** Closed shadow-DOM exotics (Lightning); cross-origin iframe picker injection (Playwright limitation); LLM suggestions; picker in headless mode (requires headed window).

### Wire protocol additions (sidecar JSON-RPC)
- `pickElement.start(params: { timeoutMs })` → request/response; returns `{ emitted: <DSL line>, locator: <kind,value>, candidates: <Array<{kind,value,score}>> }` on selection.
- `pickElement.cancel()` → request/response.
- `pickElement.isActive()` → request/response.
- `pickElement.hoverPreview` → **JSON-RPC notification** (`id` absent) emitted by sidecar during hover.
- Notification dispatch: `JsonRpcResponse.id` becomes `Option<u64>`; when `None`, route to a new `notifications: Arc<Mutex<broadcast::Sender<Notification>>>` channel.

### Ranked generator order (Tier 2 emits the FIRST that resolves `count()===1`)
1. `testid "<id>"` — if element has `[data-testid]`
2. `<role> "<name>"` — role from `role()` AX getter, name from accessible-name algorithm
3. `field "<label>"` — if input has associated `<label>`
4. `text "<visible>"` — if exact-text match is unique
5. `selector "<css>"` — from `@medv/finder` as last resort

### Overlay bundle
- Location: `scripts/playwright-sidecar/picker/overlay/index.ts` (TS source)
- Build: `esbuild` → single IIFE, inlined into `server.cjs` as a string constant
- Deps: `@medv/finder` (~6 kB), in-tree `axe-accessible-name-lite.ts` (~4 kB ported subset — NOT full axe-core, too large for SEA)
- Injected via `context.addInitScript({ content: OVERLAY_IIFE })` after `launch`
- Activated/deactivated via `page.evaluate("window.__sc_picker.start/stop()")`
- Communicates back via `page.exposeBinding("__sc_picker_emit", handler)`

### Editor integration
- `editorController` module (`apps/desktop/src/features/editor/controller.ts`): singleton with `setView(view)` / `insertAtCursor(text)` — NOT in Zustand.
- `StoryEditor` calls `editorController.setView(cmRef.current?.view)` in a `useEffect`.
- Pick-element button (in `recording-view.tsx` or a new toolbar slot) calls `await sidecar.pickElement.start()`, awaits result, then `editorController.insertAtCursor(result.emitted + "\n")`.
- Insertion is a single `view.dispatch({ changes, selection, userEvent: "input.pick" })` → atomic on undo stack.

### Targets file (Plan 07-04 only)
- Path: sibling to `.story` file — `<project>/<name>.story.targets.json`
- Schema:
  ```json
  { "version": 1, "steps": { "<uuidv7>": { "primary": {...}, "fallbacks": [{...}, ...] } } }
  ```
- Parser extension: preserve trailing `# @id=<uuidv7>` line comments as `LineMeta.step_id: Option<Uuid>`.
- Formatter: if a command has `step_id`, append `  # @id=<uuid>` on serialize.
- Self-healing: executor, on primary-miss, iterates fallbacks in order; first one that passes auto-wait is promoted (rewrites targets.json but NOT the `.story` source).

## Open Questions

### Q1 — JSON-RPC notification plumbing
**Gap:** `JsonRpcResponse.id: u64` is non-optional. Tier 2 needs notifications (hover preview).
**Options:**
- (a) Change `id: Option<u64>`, add `method: Option<String>` for notification dispatch, broadcast via `tokio::sync::broadcast::Sender`.
- (b) Skip hover preview in MVP, only emit on final click (request/response round-trip suffices).
**Recommendation:** **(b) for Plan 07-03 MVP**, (a) deferred to 07-04. Hover preview is UX polish, not a gate.

### Q2 — Should Plan 07-03 also ship `target_to_json` for Tier 1 variants?
If Plan 07-02 Task 2 already patched `playwright_driver.rs:348-355` for the three new `SelectorOrText` arms, Tier 2 inherits it. If not, Tier 2 MUST patch as a prerequisite. **Verify at plan-write time.**

### Q3 — Scrolled / off-screen targets
Picker overlay must auto-scroll to show the element that will be emitted. Playwright's
`locator.scrollIntoViewIfNeeded()` solves this after selection, but live overlay highlighting
needs in-page scroll detection. **Recommendation:** MVP picks only visible elements; scroll handled
at verification stage.

### Q4 — What happens mid-pick on navigation?
`context.addInitScript` re-injects after every navigation, but mid-pick state (`window.__sc_picker.started`) is lost. **Decision:** on `page.on("framenavigated")`, emit a `pickElement.cancelled` notification and return `{ cancelled: true, reason: "navigation" }` from the pending `pickElement.start` call.

### Q5 — Accessibility of the picker banner itself
The banner is native React in the desktop app, NOT in the Playwright page. WCAG 2.1 AA compliance is straightforward (aria-live="polite", focus trap, Esc handler). No in-page overlay needs AA because users are selecting, not interacting.

## Plan Split Recommendation

Split into **two plans**, sequentially:

### Plan 07-03 — Picker MVP (single best locator, no persistence)
**Effort:** ~7 dev-days
- New sidecar methods `pickElement.start/cancel/isActive` (request/response only; no notifications)
- Overlay bundle under `scripts/playwright-sidecar/picker/overlay/` + esbuild-to-string pipeline hooked into `build-sea.mjs`
- In-page: hover highlighter + click-to-emit + Esc-to-cancel; per-frame via `context.addInitScript`
- Ranked generator (5-step order above) with `count()===1` verification
- `editorController` singleton + `StoryEditor` wire-up
- "Pick element" button in recording-view toolbar (active only when sidecar session live)
- Vitest: against a fixture page, each of the 5 ranks produces the expected DSL line
- Rust: integration smoke compiles (no new notification plumbing needed)
- No `.story.targets.json`, no ranked-array persistence, no self-healing

### Plan 07-04 — Ranked fallback + self-healing (persistence + runtime promotion)
**Effort:** ~5 dev-days
- JSON-RPC notification plumbing (`id: Option<u64>` + broadcast channel)
- `pickElement.hoverPreview` notification
- `.story.targets.json` schema + reader/writer
- Parser: preserve `# @id=<uuidv7>` trailing line comments (new field on `LineMeta` + grammar tweak — NOT a `SelectorOrText` change, so CONTEXT.md Tier 1 decisions are untouched)
- Formatter: emit step-id comment on serialize (requires a minimal formatter — currently absent)
- Executor: on primary miss, walk fallbacks; promote first success; rewrite `.story.targets.json` atomically
- Tests: insta snapshot for comment round-trip, executor promotion path

**Rationale for the split:** Plan 07-03 ships user-visible value (no more typing selectors) with
zero new Rust protocol surface. Plan 07-04 adds robustness — hugely valuable but not a day-one
gate. If Plan 07-04 slips, Plan 07-03 is a complete, shippable feature.

## Risks

1. **SEA-embedded overlay bundle (MEDIUM):** `server.cjs` is Node SEA — no sibling file reads. The overlay IIFE must be inlined at bundle time. `build-sea.mjs` already uses esbuild; add a `--loader:.overlay.js=text` step. Acceptance: `strings playwright-sidecar-<triple> | grep __sc_picker` returns hits.
2. **CodeMirror undo atomicity (LOW):** A single `view.dispatch` is one history entry. Confirmed fine; no chunking needed.
3. **Shadow piercing edge cases (MEDIUM):** `@medv/finder` doesn't pierce. Custom walker uses `elementsFromPoint` + recursive `shadowRoot` traversal. Closed shadow roots (attachShadow({mode:"closed"})) are invisible; fallback is `selector` output using Playwright's `>>` pierce syntax. Accept: MVP documents this limitation in README.
4. **Per-frame injection timing (LOW):** `context.addInitScript` fires on every frame doc-start. Verified in Playwright docs. Race window is negligible.
5. **`@medv/finder` package health (LOW):** Actively maintained through 2025 per npm. Pin to exact version. Fallback: a 100-line hand-rolled CSS-path generator.
6. **Accessible-name axe subset correctness (MEDIUM):** Porting a subset of axe-core's name computation is error-prone. Mitigation: vitest matrix of 15 DOM shapes (label-for, aria-labelledby chain, button inner text, img alt, etc.) with expected names. If correctness is shaky, fall back to `page.getByRole(...).ariaSnapshot()` via the sidecar (slower but authoritative).
7. **Tier 1 `target_to_json` gap (HIGH if unpatched):** See Q2 — blocking for both Tier 1 ship AND Tier 2.

## Effort Estimate

- Plan 07-03 (Picker MVP): **7 days**
  - Overlay bundle + build pipeline: 2 d
  - Sidecar methods + ranked generator: 2 d
  - Editor integration + toolbar button: 1 d
  - Tests (vitest fixture + manual E2E): 1.5 d
  - Buffer / polish: 0.5 d
- Plan 07-04 (Fallback persistence): **5 days**
  - JSON-RPC notification plumbing: 1 d
  - Parser comment round-trip + formatter stub: 1.5 d
  - `.story.targets.json` + self-healing executor path: 1.5 d
  - Tests: 1 d
- **Total Tier 2: ~12 days** (consistent with the earlier 9+5=14d estimate; trimmed by making MVP fully-no-notifications).

## Deliverable Files (real paths)

**Plan 07-03:**
- `scripts/playwright-sidecar/picker/overlay/index.ts` (new)
- `scripts/playwright-sidecar/picker/overlay/finder-wrapper.ts` (new — @medv/finder + shadow walker)
- `scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts` (new — ~4 kB port)
- `scripts/playwright-sidecar/picker/generator.mjs` (new — ranked DSL emitter, runs in sidecar Node context)
- `scripts/playwright-sidecar/server.mjs` (handlers for `pickElement.*`)
- `scripts/playwright-sidecar/server.test.mjs` (vitest: 5 ranks against fixture)
- `scripts/playwright-sidecar/tests/fixtures/picker.html` (new — diverse widget gallery)
- `scripts/playwright-sidecar/build-sea.mjs` (add overlay-inlining step)
- `crates/automation/src/playwright_driver.rs` (three new RPC wrapper methods)
- `apps/desktop/src/features/editor/controller.ts` (new — editorController singleton)
- `apps/desktop/src/features/editor/story-editor.tsx` (wire editorController)
- `apps/desktop/src/features/recorder/pick-element-button.tsx` (new)
- `apps/desktop/src/features/recorder/recording-view.tsx` (mount button + banner)
- `apps/desktop/src/ipc/picker.ts` (new — typed Tauri command wrappers)
- `apps/desktop/src-tauri/src/commands/picker.rs` (new — Tauri command routing to sidecar)

**Plan 07-04:**
- `crates/automation/src/playwright_driver.rs` (notification plumbing)
- `crates/story-parser/src/grammar.pest` (trailing `#@id=` comment)
- `crates/story-parser/src/ast.rs` (`LineMeta.step_id`)
- `crates/story-parser/src/formatter.rs` (new — minimal emit with step-id preservation)
- `crates/automation/src/targets_store.rs` (new — `.story.targets.json` reader/writer)
- `crates/automation/src/executor.rs` (self-healing promotion)
- Tests across all above

## Test Strategy

| Tier | Tool | What |
|------|------|------|
| Overlay unit | vitest + jsdom | Accessible-name computation matrix (15 shapes); ranked generator picks correct DSL for each |
| Sidecar integration | vitest + real Chromium | `pickElement.start` → user-simulated click → expected DSL line (5 cases per rank) |
| Rust unit | cargo test | JSON-RPC wrapper marshalling; (07-04) notification dispatch |
| Rust integration | cargo test --no-run | Compile-only smoke for the new picker IPC |
| Desktop integration | vitest + @tauri-apps/api/mocks | `editorController.insertAtCursor` inserts at cursor, single undo entry |
| Manual E2E | dev machine | Pick 10 elements across an SPA with iframes + shadow DOM; verify emitted DSL re-runs green |

## RESEARCH COMPLETE
