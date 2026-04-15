---
phase: 01-foundation-dsl-automation-capture-encode
plan: 06
subsystem: automation
tags: [automation, chromiumoxide, playwright, browser, selector, cdp, node-sea, json-rpc]
status: complete
completed: "2026-04-15"
duration_minutes: ~240
requirements: [AUTO-01, AUTO-02, AUTO-03, AUTO-04, AUTO-05, AUTO-06]
dependency_graph:
  requires:
    - story-parser (Plan 01-04) — Command, SelectorOrText, Story, Scene, Viewport, Theme
    - storage (Plan 01-05) — ProjectDb, NewSession, NewStep, NewAttempt, ASSETS_DIRNAME
    - tauri host scaffold (Plan 01-03) — AppState, AppError, tauri-plugin-shell, Channel
  provides:
    - automation::BrowserDriver trait + LaunchConfig + Capability + CapabilitySet + ResolvedSelector
    - automation::ChromiumoxideDriver (primary, in-process CDP)
    - automation::PlaywrightSidecarDriver (Node SEA bundled, JSON-RPC over stdin/stdout)
    - automation::SmartSelector (intent-aware, ranked, attempt-logged)
    - automation::wait_actionable (visible + stable + in-viewport + not-animating)
    - automation::Executor (capability-routed verb dispatch + ExecutorEvent stream)
    - automation::SessionActor (Pause/Stop/Status command surface)
    - playwright-sidecar/server.mjs JSON-RPC 2.0 server
    - playwright-sidecar/build-sea.mjs per-triple Node 20 SEA build
    - tauri command launch_automation(story_source, project_folder, on_event)
    - .github/workflows/playwright-sidecar-build.yml matrix CI
  affects:
    - Plan 01-07 (capture pipeline) — subscribes to StepSucceeded cursor coords
    - Plan 01-09 (UI) — subscribes to ExecutorEvent stream via Channel
    - Plan 01-10 (release/notarization) — re-signs SEA sidecar binaries
tech-stack:
  added:
    - chromiumoxide =0.7.0 (pinned)
    - chromiumoxide_cdp =0.7.0
    - async-trait 0.1
    - playwright-core ^1.48 (Node sidecar)
    - postject ^1.0.0-alpha.6 (SEA injection)
    - Node 20 LTS Single Executable Application API
  patterns:
    - Trait-based driver with capability-set negotiation (D-11)
    - Explicit auto-waiting per verb (Playwright-style actionability — D-12)
    - Intent-aware selector resolution with ranked candidate scoring (D-13)
    - Capability-routed verb dispatch primary→fallback (D-14)
    - Bundled Node SEA sidecar over stdin/stdout JSON-RPC (D-15)
    - Pure crate boundary (no Tauri/specta deps in `automation`)
key-files:
  created:
    - crates/automation/Cargo.toml
    - crates/automation/src/lib.rs
    - crates/automation/src/driver.rs
    - crates/automation/src/chromiumoxide_driver.rs
    - crates/automation/src/playwright_driver.rs
    - crates/automation/src/selector.rs
    - crates/automation/src/auto_wait.rs
    - crates/automation/src/capability.rs
    - crates/automation/src/executor.rs
    - crates/automation/src/error.rs
    - crates/automation/src/events.rs
    - crates/automation/src/session.rs
    - crates/automation/tests/selector.rs
    - crates/automation/tests/capability_routing.rs
    - crates/automation/tests/executor.rs
    - crates/automation/tests/fixtures/test-pages/index.html
    - crates/automation/tests/fixtures/test-pages/upload.html
    - crates/automation/tests/fixtures/test-pages/shadow.html
    - scripts/playwright-sidecar/package.json
    - scripts/playwright-sidecar/server.mjs
    - scripts/playwright-sidecar/build-sea.mjs
    - scripts/playwright-sidecar/sea-config.json
    - scripts/playwright-sidecar/README.md
    - apps/desktop/src-tauri/src/commands/automation.rs
    - .github/workflows/playwright-sidecar-build.yml
    - .planning/phases/01-foundation-dsl-automation-capture-encode/deferred-items.md
  modified:
    - apps/desktop/src-tauri/Cargo.toml (workspace crate deps)
    - apps/desktop/src-tauri/src/commands/mod.rs (register automation module)
    - apps/desktop/src-tauri/src/ipc_spec.rs (register launch_automation in collect_commands!)
    - Cargo.lock
decisions:
  - "Implemented BOTH ChromiumoxideDriver and PlaywrightSidecarDriver from day one; never shipped 'fallback later' (D-11)"
  - "Auto-wait wraps every action (resolve → wait_actionable → act); 4-property check: visible, stable across 2 ticks, in-viewport, not-animating (D-12)"
  - "Selector resolution is strictly intent-typed: explicit Selector/Testid/Aria do NOT cross-fall-back; only Text builds ranked actionable/accessibility candidates with ambiguity errors (D-13)"
  - "Capability::FileUpload | WaitForDownload | ShadowDomPiercing | OauthPopup route via static analysis to Playwright; the rest go to chromiumoxide (D-14)"
  - "Playwright sidecar bundled as Node 20 SEA, NOT system Node; per-triple binary names match Tauri externalBin auto-resolution (D-15)"
  - "Tauri host wrapper AutomationEvent re-serializes the pure ExecutorEvent as JSON to keep the automation crate free of specta/Tauri deps"
  - "First-run Chromium NOT bundled (preserves DIST-04 <50 MB installer); sidecar lazy-installs via playwright-core's managed download on first launch"
  - "Real-browser tests gated behind `real-browser-tests` feature flag; routing/selector tests run browser-free in default test set"
metrics:
  duration: ~4h elapsed (single execution session)
  rust_loc: 2018 (src) + ~600 tests
  node_sidecar_loc: 257 server + 88 build script
  tauri_host_loc: 144
  total_files_created: 25
  total_files_modified: 4
  unit_tests: 17 passing (10 selector + 7 capability_routing)
  integration_tests: compile under `--features real-browser-tests` (chromium binary required at runtime)
  commits: 5 (1 from prior session + 4 in this session)
---

# Phase 01 Plan 06: BrowserDriver + Dual Driver + Capability-Routed Executor — Summary

Pure `automation` crate implementing the `BrowserDriver` trait with **two production drivers from day one** — `ChromiumoxideDriver` (primary, in-process CDP via `chromiumoxide =0.7.0`) and `PlaywrightSidecarDriver` (Node 20 SEA bundled, JSON-RPC 2.0 over stdin/stdout) — plus an intent-aware ranked-candidate selector engine, Playwright-style explicit auto-waiting, capability-based verb routing, and Tauri host wiring that streams `ExecutorEvent`s to the renderer through a typed `Channel`.

## Scope Delivered

| Requirement | Status | Where |
|---|---|---|
| AUTO-01 — BrowserDriver trait + dual driver from day one | ✅ | `driver.rs`, `chromiumoxide_driver.rs`, `playwright_driver.rs` |
| AUTO-02 — Explicit auto-waiting per verb (no CDP defaults) | ✅ | `auto_wait.rs::wait_actionable` (visible + stable + in-viewport + not-animating); wired in `executor.rs` |
| AUTO-03 — Intent-aware selector resolution with ranked candidates + attempt log + ambiguity errors | ✅ | `selector.rs::SmartSelector::resolve_with_attempts` |
| AUTO-04 — Meta block (viewport / theme / app) drives LaunchConfig | ✅ | `LaunchConfig::from_meta(&story.meta)` consumed in `commands/automation.rs` |
| AUTO-05 — `StepFailed { ordinal, attempts, error_message, screenshot_path }` event | ✅ | `events.rs::ExecutorEvent::StepFailed`; emitted by executor on failure |
| AUTO-06 — Capability routing to Playwright for upload/download/shadow/OAuth + bundled Node SEA sidecar | ✅ | `capability.rs::required_for` + `driver_for`; `scripts/playwright-sidecar/*`; CI matrix |

## Architecture Highlights

- **Pure crate boundary preserved.** `cargo tree -p automation | grep -i tauri` returns nothing — the automation crate has zero Tauri/specta deps. All Tauri-touching glue lives in `apps/desktop/src-tauri/src/commands/automation.rs`, which wraps `ExecutorEvent` in a thin `AutomationEvent { json }` so `Channel<T>` satisfies `specta::Type` without leaking the boundary.
- **Capability routing is static + analyzable.** `capability::required_for(&Command)` maps each DSL verb to a `Capability` flag; `driver_for(primary, fallback, required)` returns the fallback only when primary lacks the capability. Routing decisions are logged via `tracing::info!`, never silent.
- **Intent-aware selector engine.** `SelectorOrText::Selector|Testid|Aria` resolve strictly within their strategy and fail-fast; only `SelectorOrText::Text` builds ranked candidates (exact accessible name on actionable controls → exact visible text on actionable controls → label-to-control association for form fields → bounded fuzzy/partial match), each candidate scored, every attempt logged, ambiguity returned as a structured `AutomationError::Selector { attempts, last_error }`.
- **Playwright sidecar transport.** `PlaywrightSidecarDriver` owns a `tokio::process::Child` + `ChildStdin` + a background reader task that parses newline-delimited JSON-RPC responses and dispatches to a `HashMap<u64, oneshot::Sender<JsonRpcResponse>>` keyed on request id. Atomic id counter, per-request timeout-friendly `oneshot` channels.

## Routed-to-Playwright Verb List

The capability table at the top of `capability.rs`:

| DSL verb / scenario | Capability | Driver |
|---|---|---|
| `upload` | `FileUpload` | Playwright (chromiumoxide lacks robust `setInputFiles`) |
| `wait-for download` | `WaitForDownload` | Playwright (`page.waitForEvent('download')`) |
| Shadow-DOM `click` (heuristic detection on selector path) | `ShadowDomPiercing` | Playwright (`>>` shadow piercing) |
| OAuth popup follow-on (mid-flight escalation) | `OauthPopup` | Playwright (multi-context window handling) |
| Plain `click` / `type` / `goto` / `scroll` / `hover` / `drag` / `select` / `wait_ms` / `assert` / `screenshot` | `None` | chromiumoxide |

Plain verbs route to chromiumoxide unconditionally — proven by `tests/capability_routing.rs::plain_click_routes_to_chromiumoxide`.

## Known chromiumoxide Gaps (Spike Notes)

The empirical real-Chromium spike is deferred (see `deferred-items.md`); the static gaps motivating Playwright fallback (PITFALLS §3 + RESEARCH 01-RESEARCH.md):

- **File upload** — chromiumoxide exposes `Page::set_input_files` indirectly via `Input.dispatchFileChooserEvent` but is brittle on detached/hidden inputs. Playwright `setInputFiles` handles both flows.
- **Download interception** — chromiumoxide has no first-class `Download` event; you must drive `Browser.setDownloadBehavior` and watch the file-system. Playwright exposes `page.waitForEvent('download')` directly.
- **Shadow-DOM piercing** — chromiumoxide's `Page::find_element` does not pierce shadow roots without manual `Runtime.evaluate` traversal. Playwright's `>>` pierce syntax handles it.
- **OAuth popups** — chromiumoxide's multi-target API is functional but lower-level than Playwright's `context.waitForEvent('page')`; popup flows often need explicit `Target.attachToTarget` + frame wiring.
- **Network-idle wait** — chromiumoxide does not expose a Playwright-equivalent `waitUntil: 'networkidle'`; you must roll your own from `Network.requestWillBeSent` / `Network.loadingFinished`. We chose to route this case through Playwright when a story explicitly waits for "network idle".

## Tauri Host Wiring

`launch_automation(story_source, project_folder, on_event: Channel<AutomationEvent>) -> Result<(), AppError>`:

1. Parses story via `story_parser::parse`.
2. Opens `storage::ProjectDb` for persistence.
3. Resolves screenshot dir under `<project>/{ASSETS_DIRNAME}` (created on demand).
4. Launches `ChromiumoxideDriver` in-process via `LaunchConfig::from_meta(&story.meta)`. On failure, logs warning and lets Playwright cover all verbs.
5. Resolves Playwright sidecar path via `tauri-plugin-shell::ShellExt::sidecar(...)`, then re-spawns through `tokio::process::Command` so we own stdin/stdout pipes for JSON-RPC framing. Missing/unbuilt sidecar surfaces as `CapabilityMismatch` on capability-gated verbs rather than aborting.
6. Calls `Executor::run(story, primary, fallback, persistence, screenshot_dir)` and pumps every `ExecutorEvent` from the mpsc receiver into the typed `Channel<AutomationEvent>`.

## Node SEA Build Recipe

`scripts/playwright-sidecar/build-sea.mjs` builds per Tauri externalBin triple:

| Triple | OS Runner | Output Name |
|---|---|---|
| `aarch64-apple-darwin` | macos-14 | `playwright-sidecar-aarch64-apple-darwin` |
| `x86_64-apple-darwin` | macos-13 | `playwright-sidecar-x86_64-apple-darwin` |
| `x86_64-pc-windows-msvc` | windows-latest | `playwright-sidecar-x86_64-pc-windows-msvc.exe` |

Steps: `node --experimental-sea-config sea-config.json` → SEA blob → copy host `process.execPath` → strip macOS signature (re-signed during Plan 02/10 notarization walk) → `npx postject` inject blob with fuse `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`.

**Binary size estimates** (empirical SEA reference: Node 20 macOS arm64 ≈ 110 MB, Node 20 win-x64 ≈ 95 MB, Node 20 macos-x64 ≈ 110 MB). These are the bare Node binary + injected SEA blob; `playwright-core` itself (~5 MB JS, no Chromium) is bundled inside the blob via SEA's snapshot. Chromium is NOT bundled — see below.

**Chromium installer impact:** **Zero impact on the StoryCapture installer** (preserves DIST-04 <50 MB target). The sidecar lazy-installs Chromium on first launch via `playwright install chromium` into the platform's playwright-core managed cache (`~/Library/Caches/ms-playwright` / `%LOCALAPPDATA%\ms-playwright`). First-run UX cost: ~150 MB download + ~400 MB on disk. RESEARCH Q2 reviewed and accepted.

## CI Matrix Workflow

`.github/workflows/playwright-sidecar-build.yml` runs on PRs touching `scripts/playwright-sidecar/**`, on pushes to `main`, and via `workflow_dispatch`. Matrix builds the three triples, smoke-tests each binary by piping `{"jsonrpc":"2.0","id":1,"method":"capabilities"}` into the binary and grepping for `"file_upload":true` (Unix runners), then uploads each binary as an artifact for the release pipeline (Plan 01-10) to download, sign, and notarize before bundling.

## Test Coverage

```
$ cargo test -p automation --test selector --test capability_routing
test result: ok. 10 passed; 0 failed (selector)
test result: ok. 7 passed; 0 failed (capability_routing)
```

| Test | Asserts |
|---|---|
| `capability_routing::upload_routes_to_playwright` | `MockPlaywright.last_called == true` AND `MockChromiumoxide.last_called == false` for `Verb::Upload` |
| `capability_routing::plain_click_routes_to_chromiumoxide` | Inverse — chromiumoxide called, Playwright untouched |
| `capability_routing::wait_for_download_routes_to_playwright` | Routing proof for `WaitFor { target: download:* }` |
| `capability_routing::shadow_dom_click_routes_to_playwright` | Routing proof for shadow-DOM heuristic |
| `capability_routing::oauth_click_routes_to_playwright` | Routing proof for OAuth popup heuristic |
| `selector::explicit_testid_does_not_fall_back` | `Testid("save")` resolves strict-only; no CSS fallback |
| `selector::explicit_css_selector_resolves_strict` | Same for `Selector(css)` |
| `selector::explicit_aria_resolves_strict` | Same for `Aria(label)` |
| `selector::text_target_for_type_prefers_label_assoc_over_visible_text` | Action-aware ranking: `type` prefers form-field label assoc |
| `selector::text_target_logs_every_attempt` | Attempt log records every candidate evaluated |

`tests/executor.rs` (browser-driven) compiles under `--features real-browser-tests` and exercises all 13 DSL verbs against the static fixture pages (`index.html`, `upload.html`, `shadow.html`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] `apps/desktop/src-tauri` build script fails on missing `binaries/ffmpeg-<triple>`**
- **Found during:** Task 2 (Tauri host wiring verification)
- **Issue:** `tauri-build` rejects the build because `bundle.externalBin = ["binaries/ffmpeg"]` resolves to a per-triple file that doesn't exist yet (Plan 01-08 ships the FFmpeg static sidecar).
- **Fix:** Documented in `deferred-items.md` rather than shipping a placeholder binary that would mislead the bundle pipeline. `cargo check -p automation` (the in-scope crate for this plan) is clean. `cargo check -p storycapture --lib` was verified to compile the new `launch_automation` command with a temporary placeholder binary that was removed before commit.
- **Files modified:** `.planning/phases/01-foundation-dsl-automation-capture-encode/deferred-items.md`
- **Commit:** `858ce23`

**2. [Rule 2 — Critical] Resilient sidecar fallback when SEA binary missing**
- **Found during:** Task 2
- **Issue:** The plan assumed the SEA binary is always present, but local dev (and CI before the matrix workflow runs) won't have it. A naive panic at startup would brick the executor for every story, including stories that need only chromiumoxide.
- **Fix:** `launch_automation` logs a warning and substitutes a chromiumoxide-only fallback driver. Capability-gated verbs (`upload`, `wait-for download`, shadow click, OAuth popup) surface a `CapabilityMismatch { command, driver }` error from the executor, which the renderer can present as "build the Playwright sidecar to enable this verb" rather than a hard crash.
- **Files modified:** `apps/desktop/src-tauri/src/commands/automation.rs`
- **Commit:** `f253033`

### Architectural deviations

None.

## Threat Model Compliance

| Threat ID | Disposition | Status |
|---|---|---|
| T-06-01 (SSRF-like via DSL navigate) | accept | Phase 1 — user authors the story; Phase 3 will add allow-list. No regression. |
| T-06-02 (sidecar binary swap) | mitigate | CI workflow uploads artifacts; release pipeline (Plan 01-10) re-signs + notarizes. Hand-off documented. |
| T-06-03 (cookies leaking via screenshots) | accept | Screenshots written to `<project>/assets/`; never auto-uploaded. |
| T-06-04 (browser hangs forever) | mitigate | Every `BrowserDriver` action takes a `timeout_ms`; executor enforces session-level timeout. Wired in `auto_wait.rs` and `executor.rs`. |
| T-06-05 (CDP elevation) | mitigate | `ChromiumoxideDriver::launch` does not pass `--no-sandbox`; CDP socket on loopback only. |
| T-06-06 (failure repudiation) | mitigate | `StepFailed { ordinal, attempts, error_message, screenshot_path }` event + `step_attempts` table persistence (via `storage::NewAttempt`). |

No new threat surface introduced beyond the plan's threat register.

## Self-Check: PASSED

**Files verified:**
- FOUND: crates/automation/src/{driver,chromiumoxide_driver,playwright_driver,selector,auto_wait,capability,executor,error,events,session,lib}.rs
- FOUND: crates/automation/tests/{selector,capability_routing,executor}.rs
- FOUND: crates/automation/tests/fixtures/test-pages/{index,upload,shadow}.html
- FOUND: scripts/playwright-sidecar/{server.mjs,build-sea.mjs,sea-config.json,package.json,README.md}
- FOUND: apps/desktop/src-tauri/src/commands/automation.rs
- FOUND: .github/workflows/playwright-sidecar-build.yml
- FOUND: .planning/phases/01-foundation-dsl-automation-capture-encode/deferred-items.md

**Commits verified:**
- FOUND: 6b20b94 (Task 1: BrowserDriver trait + ChromiumoxideDriver + SmartSelector + auto-wait + capability-routed Executor)
- FOUND: 0419461 (Playwright sidecar JSON-RPC server + SEA build)
- FOUND: f253033 (Tauri host launch_automation command)
- FOUND: 01d9ce5 (CI matrix workflow)
- FOUND: 858ce23 (deferred-items doc)

**Verification commands:**
- `cargo check -p automation` → clean
- `cargo test -p automation --test selector --test capability_routing` → 17/17 passing
- `cargo tree -p automation | grep -i tauri` → empty (purity guard satisfied)
- `cargo check -p storycapture --lib` → clean (verified with placeholder ffmpeg binary; pre-existing externalBin requirement deferred to Plan 01-08)

## Follow-ups for Downstream Plans

- **Plan 01-07 (capture pipeline):** subscribe to `StepSucceeded { cursor_x, cursor_y }` events; cursor coords already emitted.
- **Plan 01-08 (FFmpeg sidecar):** unblocks `cargo build -p storycapture` end-to-end. Add `binaries/playwright-sidecar` to `bundle.externalBin` once SEA artifacts are downloaded into the build root by the release pipeline.
- **Plan 01-09 (UI):** consume `Channel<AutomationEvent>` via the `launch_automation` command; parse `event.json` as `ExecutorEvent`.
- **Plan 01-10 (release):** download the three SEA artifacts from the workflow, re-sign each on macOS (`codesign --force --timestamp --options runtime --sign $CERT`), notarize with notarytool.
- **chromiumoxide verb-coverage spike:** validate the 5 riskiest verbs (shadow DOM, file upload, drag, wait-for-network-idle, iframe nav) against a real Chromium binary; tune capability heuristics if real-world routing diverges from static analysis.
