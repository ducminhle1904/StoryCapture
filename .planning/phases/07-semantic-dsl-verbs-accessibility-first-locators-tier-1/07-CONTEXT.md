# Phase 7: Semantic DSL verbs + element picker (Tier 1 + Tier 2) - Context

**Gathered:** 2026-04-17 (Tier 1); extended 2026-04-17 (Tier 2)
**Status:** Ready for planning
**Source:** Direct research in-session. Tier 2 research lives in `07-RESEARCH-TIER2.md`.

<domain>
## Phase Boundary

**In scope — Tier 1 (plans 07-01, 07-02):**
- Extend pest grammar with role-qualified target rules and a `fill ... with ...` sugar verb
- Extend AST (`SelectorOrText` + new `AriaRole` enum) and the lenient tokenizer
- Extend SmartSelector with three explicit short-circuit strategies
- Extend the Playwright sidecar's `locate()` + `targetToLocator()` with matching branches
- Extend `playwright_driver.rs::target_to_json()` to serialize the three new variants (required for Tier 1 to compile; fold into 07-02)
- Preserve full backwards compatibility with `selector`/`testid`/`aria`/bare-string forms

**In scope — Tier 2 MVP (plan 07-03):**
- "Pick element" button in the recording view toolbar
- Overlay injected into the Playwright-controlled page via `context.addInitScript` (per-frame automatic)
- Sidecar JSON-RPC methods `pickElement.start` / `pickElement.cancel` / `pickElement.isActive` (request/response only — NO notifications in MVP)
- Ranked generator emits ONE best DSL line: TestId → Role+Name → Label → TextExact → CSS (via `@medv/finder`); each verified with `count() === 1`
- `editorController` module-level singleton for CodeMirror insertion; `StoryEditor` wires `cmRef.current?.view` on mount
- Esc-to-cancel + top-of-page picking banner in the React shell (aria-live="polite")
- Reuse the active recording-session browser; refuse activation on `chrome://`/`about://` URLs
- Auto-cancel on `framenavigated` mid-pick; return `{ cancelled: true, reason: "navigation" }`

**In scope — Tier 2 robustness (plan 07-04):**
- JSON-RPC notification plumbing: `JsonRpcResponse.id` becomes `Option<u64>`; add `method: Option<String>`; id-absent messages dispatch to a `tokio::sync::broadcast` channel
- `pickElement.hoverPreview` notification streamed during hover (UI shows a preview chip)
- `.story.targets.json` sidecar file keyed by UUIDv7 step id with `{primary, fallbacks[]}` schema
- Parser preserves trailing `# @id=<uuidv7>` line comments as `LineMeta.step_id`
- Minimal `story-parser` formatter that round-trips step-id comments on serialize
- Executor self-healing: on primary-miss, iterate fallbacks, promote first success, atomically rewrite `.story.targets.json`

**Out of scope (deferred to later phases):**
- Tier 3: LLM fallback resolver + AX-tree caching
- Editor autocomplete for new role keywords (nice-to-have polish)
- Closed shadow-DOM (`attachShadow({mode:"closed"})`) — document as known limitation
- Cross-origin iframe picker injection (Playwright limitation)
- Picker in headless mode (requires headed window)
- Scroll-to-element during active picking (MVP picks only already-visible elements; Playwright `scrollIntoViewIfNeeded` handles execution-time scroll)
- TypeScript AST mirror regeneration — byproduct, not a standalone deliverable

</domain>

<decisions>
## Implementation Decisions (LOCKED)

### DSL surface
- **New role-qualified forms** added as first-class:
  - `click button "Save"` → `getByRole('button', { name: 'Save', exact: true })`
  - `click link "Docs"` → `getByRole('link', { name: 'Docs', exact: true })`
  - `click image "Dashboard preview"` (and `img` alias) → `getByRole('img', ...)`
  - `click text "Learn more"` → `getByText('Learn more', { exact: true })` (distinct from bare `click "Learn more"` which remains ranked/fuzzy)
  - `fill field "Email" with "alice@x"` → desugars to existing `Type` command with `Label("Email")` target; sidecar emits `getByLabel('Email', { exact: true }).fill(...)`
  - `hover image "..."`, `hover button "..."`, etc. — all verbs that accept a target gain the role-qualified forms
- **Backwards compat:** all existing forms (`selector "#x"`, `testid "x"`, `aria "x"`, bare `"text"`) keep their grammar rules, AST variants, tokenizer output, scoring path, and sidecar handlers unchanged.

### Supported ARIA roles (pragmatic subset, ~20)
`button, link, heading, image (+img alias), checkbox, radio, tab, menuitem, menu, option, combobox, listbox, dialog, alert, tooltip, switch, slider, row, cell, navigation, main`. Additional roles can be added later without a breaking grammar change.

### Grammar changes (`crates/story-parser/src/grammar.pest`)
- New rules added BEFORE `target_text` (the bare-string fallback), so role-qualified forms win:
  - `target_role = { role_kw ~ string }`
  - `target_field = { "field" ~ string }`
  - `target_text_kw = { "text" ~ string }`
  - `role_kw` as an atomic rule enumerating the supported role keywords
- New `cmd_fill = { "fill" ~ target ~ "with" ~ string }` added to `command` alternatives. `fill` desugars to `Type` in the semantic pass — no new AST command variant.

### AST changes (`crates/story-parser/src/ast.rs`)
- `SelectorOrText` gains three new variants (serde-tagged, kebab-case where tag values render):
  - `Role { role: AriaRole, name: String }`
  - `Label(String)`
  - `TextExact(String)`
- New `AriaRole` enum with the supported subset + `#[serde(rename_all = "kebab-case")]` + `as_kebab()` method.
- `RawTarget` in `lenient_tokenize.rs` gains parallel stringly-typed variants (`Role { role: String, name: String }`, `Label(String)`, `TextExact(String)`) — validated against `AriaRole` at layer 2 with did-you-mean suggestions for typos.

### SmartSelector changes (`crates/automation/src/selector.rs`)
- `SelectorStrategy` (in `crates/automation/src/events.rs`) gains three new variants: `Role`, `Label`, `TextExact`.
- `explicit_strategy()` handles the new `SelectorOrText` variants by emitting:
  - `SelectorStrategy::Role`, value `role=<role>:<name>` (confidence 1.0, single attempt)
  - `SelectorStrategy::Label`, value `label=<name>` (confidence 1.0, single attempt)
  - `SelectorStrategy::TextExact`, value `text=<name>` (confidence 1.0, single attempt)
- The existing ranked fallback chain for bare `Text(s)` is UNCHANGED.

### Sidecar changes (`scripts/playwright-sidecar/server.mjs`)
- `locate(page, strategy, selector)` adds three highest-precedence branches:
  - `role=<role>:<name>` → `page.getByRole(role, { name, exact: true })`
  - `label=<name>` → `page.getByLabel(name, { exact: true })`
  - `text=<name>` → `page.getByText(name, { exact: true })`
- `targetToLocator()` (used by `wait-for`, `auto-wait`, and `elementState`) receives the same three branches so the wait paths stay consistent.
- The existing bare-string `aria-name=` chained `.or()` fallback for `Text(s)` is UNCHANGED.

### Error handling
- Unknown role keyword (e.g. `click buton "Save"`) → parse-layer-2 diagnostic using the existing `suggest.rs` Levenshtein mechanism. Known roles listed in a single `KNOWN_ROLES` constant in `suggest.rs`.
- Role mismatch at runtime (e.g. `click button "Foo"` but element is actually a link) → normal `wait_actionable` timeout with existing error path. No special error class needed.

### Testing
- Unit tests extend `crates/story-parser` (parser + semantic) with:
  - Positive parse cases for every supported role + `field` + `text` keyword
  - Negative parse cases with did-you-mean (typo on role_kw)
  - `fill ... with ...` desugaring snapshot
- Unit tests extend `crates/automation/src/selector.rs` with:
  - `Role`/`Label`/`TextExact` short-circuit behavior (confidence, single attempt, no fallback chain)
- Sidecar vitest (`scripts/playwright-sidecar/server.test.mjs` or equivalent) covers the three new `locate()` branches against a synthetic page.
- An `insta` snapshot for the updated grammar + two golden `.story` fixtures (one new-style, one legacy-style) round-tripping through parse → semantic → executable command.

### TypeScript AST mirror
- Regenerate via the existing `ts-rs` pipeline (already wired in `crates/story-parser/src/ast.rs`). Verify `packages/story-dsl/src/ast.ts` reflects the new variants. No hand-edits.

### Non-goals (Tier 1)
- No executor/driver changes expected — they consume `ResolvedSelector { strategy, value }` opaquely.
- No UI changes (no new editor autocomplete entries required for v1; can be added later).
- No migration of existing story files — backwards compat means they keep working.

### Tier 1 prerequisite (MUST land in Plan 07-02)
- **Patch `crates/automation/src/playwright_driver.rs::target_to_json()`** to serialize the three new `SelectorOrText` variants:
  - `Role { role, name }` → `json!({ "kind": "role", "value": { "role": <kebab>, "name": <name> } })` OR `json!({ "kind": "role", "value": format!("role={}:{}", role.as_kebab(), name) })` — pick one and document; sidecar must match.
  - `Label(s)` → `json!({ "kind": "label", "value": s })`
  - `TextExact(s)` → `json!({ "kind": "text_exact", "value": s })`
- Without this patch, any `.story` using new verbs fails to serialize for `waitFor`/`assert` at runtime (compile-passes, runtime-panics on unreachable arm).

### Tier 2 MVP decisions (Plan 07-03) — LOCKED
- **Ranked generator emission order** (first candidate with `count() === 1` wins):
  1. `testid "<id>"` if element has `[data-testid]`
  2. `<role> "<name>"` using Tier 1 syntax — role from in-overlay role inference; name from ported accessible-name-lite algorithm
  3. `field "<label>"` for form inputs with an associated `<label>` / `aria-labelledby`
  4. `text "<visible-text>"` if exact trimmed text uniquely matches
  5. `selector "<css>"` from `@medv/finder`
- **Overlay bundle:** TS source at `scripts/playwright-sidecar/picker/overlay/index.ts`; `esbuild` → single IIFE; inlined into the sidecar SEA binary as a string constant at build time (SEA cannot read sibling files at runtime). Add an esbuild `text` loader step in `scripts/playwright-sidecar/build-sea.mjs`.
- **Accessible-name:** ship an in-tree `scripts/playwright-sidecar/picker/overlay/axe-accessible-name-lite.ts` implementing the subset needed for the 15 DOM shapes in the fixture (label-for, aria-labelledby, aria-label, button inner text, img alt, placeholder). NOT the full axe-core port.
- **Shadow DOM:** custom walker using `elementsFromPoint` + recursive `shadowRoot` traversal. Emit Playwright `>>` piercing syntax for the CSS fallback path. Closed shadow roots are documented as unsupported.
- **Injection:** `browserContext.addInitScript({ content: OVERLAY_IIFE })` after `launch()` — applies to every frame including future navigations automatically.
- **Activation / communication:**
  - Activate/deactivate via `page.evaluate("window.__sc_picker.start()" / ".stop()")`
  - Overlay → sidecar callback via `page.exposeBinding("__sc_picker_emit", handler)` (one-shot on final click)
  - **No `pickElement.hoverPreview` notification in MVP** — deferred to 07-04 because `JsonRpcResponse.id` is currently `u64` (non-optional)
- **Sidecar JSON-RPC surface (request/response only for MVP):**
  - `pickElement.start({ timeoutMs? })` → `{ emitted: <DSL line>, locator: { kind, value }, candidates: [{ kind, value, score }], cancelled?: boolean, reason?: string }`
  - `pickElement.cancel()` → `{ ok: true }`
  - `pickElement.isActive()` → `{ active: boolean }`
- **Navigation mid-pick:** on `page.on("framenavigated")` the sidecar auto-resolves the pending `pickElement.start` with `{ cancelled: true, reason: "navigation" }` and clears overlay state.
- **URL allowlist:** picker refuses activation on `chrome://`, `about:`, `view-source:` URLs with a `{ cancelled: true, reason: "unsupported-url" }` response.
- **Desktop UI wiring:**
  - **`editorController` singleton** at `apps/desktop/src/features/editor/controller.ts` — module-level, NOT in Zustand. `StoryEditor` sets the CodeMirror `view` via `useEffect` on mount; clears on unmount. API: `setView(view)`, `insertAtCursor(text)`, `isReady()`.
  - **Insertion semantics:** single `view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.pick" })` — atomic on undo stack. If the cursor is mid-line, snap insertion to line-end first. Append `"\n"` to the emitted DSL.
  - **"Pick element" button** as a new `apps/desktop/src/features/recorder/pick-element-button.tsx` component, mounted in `recording-view.tsx`. Disabled unless sidecar session is live. Esc closes the picker.
  - **Picking banner:** top-anchored React banner outside the Playwright page; `aria-live="polite"`; shows "PICKING — press Esc to cancel".
  - **Tauri command** at `apps/desktop/src-tauri/src/commands/picker.rs` routes to sidecar JSON-RPC; TS wrapper at `apps/desktop/src/ipc/picker.ts`.
- **Tests:**
  - Overlay vitest + jsdom: 15-row accessible-name matrix; ranked generator selects expected DSL per shape.
  - Sidecar vitest + real Chromium: 5 ranks against a fixture page (`scripts/playwright-sidecar/tests/fixtures/picker.html`) simulating a click and asserting the emitted DSL line.
  - Rust: cargo test on the new JSON-RPC wrapper marshalling; compile-only smoke for picker IPC crate surface.
  - Desktop: vitest with `@tauri-apps/api/mocks` asserting `editorController.insertAtCursor` inserts at cursor and produces a single undo entry.

### Tier 2 robustness decisions (Plan 07-04) — LOCKED
- **JSON-RPC notification plumbing:**
  - `JsonRpcResponse.id` becomes `Option<u64>`; add `method: Option<String>` and `params: Option<Value>`.
  - Id-absent messages dispatch to a `tokio::sync::broadcast::Sender<Notification>` on the driver; consumers subscribe to receive hover preview events.
- **`pickElement.hoverPreview`** fired on every hover with the top candidate so the React shell can render a live preview chip anchored near the cursor. Throttled at 30 Hz via `requestAnimationFrame` in the overlay.
- **Targets sidecar file:**
  - Path: `<story-path-without-extension>.story.targets.json` (sibling to the `.story`).
  - Schema: `{ "version": 1, "steps": { "<uuidv7>": { "primary": { kind, value }, "fallbacks": [{ kind, value }, ...] } } }`.
  - Written atomically via temp-file + rename.
- **Step-id round-trip:**
  - Grammar extension: `command_line` optionally ends with a trailing comment of the form `# @id=<uuidv7>`. Parser preserves it as `LineMeta.step_id: Option<Uuid>` (NEW field on the existing line-meta struct — NOT a `SelectorOrText` change; Tier 1 LOCKED decisions untouched).
  - New minimal formatter at `crates/story-parser/src/formatter.rs` that serializes an AST back to DSL text preserving comments and indentation. Used ONLY when writing IDs back after first pick (formatter is not invoked on user-authored files until they pick).
  - UUIDv7 chosen for monotonic order-by-creation without central coordination.
- **Self-healing executor path:**
  - Plumbing: when primary locator fails `wait_actionable`, consult `.story.targets.json` for that step's fallbacks.
  - Iterate fallbacks in order; the first that passes `wait_actionable` becomes the new primary.
  - Write-back: rewrite `.story.targets.json` (NOT the `.story` source) with the promoted candidate as new primary, preserving the old primary as a fallback entry.
- **Tests:**
  - `insta` snapshot for parser comment round-trip (write → read → write == identical).
  - Executor unit test with an intentionally-stale primary locator and a valid fallback; asserts promotion + file rewrite.
  - Rust unit for JSON-RPC notification dispatch (multi-subscriber broadcast, lost-message behavior).

### Claude's Discretion
- Exact `AriaRole` variant names (PascalCase in Rust, kebab-case in serde output)
- Internal helper function signatures
- Test fixture markup inside `picker.html` (must cover the 5 rank cases + shadow DOM + iframe + `:`-in-name)
- Ordering of grammar alternatives as long as `target_role`/`target_field`/`target_text_kw` precede `target_text`
- Specific throttle cadence for hover preview (30 Hz target; any rAF-based throttle acceptable)
- Specific error codes for JSON-RPC failure cases (use existing convention in `server.mjs`)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### DSL parser
- `crates/story-parser/src/grammar.pest` — current grammar
- `crates/story-parser/src/ast.rs` — `SelectorOrText` definition + ts-rs annotations
- `crates/story-parser/src/lenient_tokenize.rs` — `RawTarget`, walk_scene_block, parse_target_pair, parse_command
- `crates/story-parser/src/semantic.rs` — layer-2 build_command / validation
- `crates/story-parser/src/suggest.rs` — Levenshtein did-you-mean; KNOWN_ROLES goes here
- `crates/story-parser/src/parser.rs` — Rule enum

### Automation
- `crates/automation/src/selector.rs` — SmartSelector, `explicit_strategy`, ranked fallback
- `crates/automation/src/events.rs` — `SelectorStrategy` enum
- `crates/automation/src/driver.rs` — `ResolvedSelector`, `BrowserDriver` trait
- `crates/automation/src/auto_wait.rs` — wait_actionable (unchanged but may reference strategy)
- `crates/automation/src/executor.rs` — confirms no changes needed

### Sidecar
- `scripts/playwright-sidecar/server.mjs` — `locate()`, `targetToLocator()`, `elementState` routing, JSON-RPC loop

### TS mirror
- `packages/story-dsl/src/ast.ts` — regenerated output; verify after AST change

### Project
- `CLAUDE.md` — project stack + conventions
- `.planning/ROADMAP.md` Phase 7 entry

</canonical_refs>

<specifics>
## Specific Ideas

- Example DSL showing the new verbs side-by-side with legacy:
  ```
  # New (Tier 1)
  click button "Save"
  fill field "Email" with "alice@example.com"
  click link "Docs"
  hover image "Dashboard preview"
  click text "Learn more"

  # Legacy (still works)
  click selector ".save-btn"
  click testid "save"
  click aria "Save"
  click "Save"
  ```

- SmartSelector value encoding chosen to match sidecar routing: `role=<role>:<name>` uses `:` as the first delimiter so names containing `=` are preserved. Code splits on the first `:` only.

- `fill` sugar is planner-time: the lenient tokenizer emits a `ParsedCommand::Type { target, text }` with `RawTarget::Label(name)`; semantic.rs builds `Command::Type` with `SelectorOrText::Label(name)`. No new executor path.

</specifics>

<deferred>
## Deferred Ideas

- Tier 2 (browser element picker, `.story.targets.json` fallback arrays, self-healing) — future phase
- Tier 3 (LLM fallback resolver + AX-tree caching) — future phase
- Editor autocomplete for new role keywords — nice-to-have polish, not a Phase 7 gate
- Pragma-style `#[ai]` opt-in for LLM tier — deferred with Tier 3
- DSL formatter/prettifier pass — out of scope

</deferred>

---

*Phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1*
*Context gathered: 2026-04-17 (from in-session Tier 1 research)*
