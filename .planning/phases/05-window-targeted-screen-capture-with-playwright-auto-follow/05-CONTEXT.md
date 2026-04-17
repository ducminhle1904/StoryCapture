# Phase 5: Window-targeted screen capture with Playwright auto-follow - Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the current xcap full-display capture with window-aware capture so StoryCapture records the Playwright-driven Chromium window alone — eliminating manual window-staging from the recording workflow.

**In scope:**
- macOS SCK streaming implementation (replacing the `SckBackend` stub)
- Window enumeration IPC + capture-target dropdown UI
- Playwright-PID → SCK-window bridge for auto-follow
- Windows WGC window targeting parity

**Out of scope (future phases or deferred):**
- Region/crop capture (user-drawn rect)
- Multi-window composition (side-by-side)
- Cursor/trackpad gesture overlays (Phase 2 territory)
- Audio capture (video-only for 5.x; audio is its own phase)

</domain>

<decisions>
## Implementation Decisions

### Capture target defaults
- **D-01:** Default capture target is **sticky** — stored in `app_settings.json`, first-run default is "Playwright browser (auto)". Subsequent runs restore the user's last choice.
- **D-02:** "Auto-browser" is the *recommended* option in the picker UI (highlighted/badged) but not forced — users who want full-screen or a specific window should be one click away.

### Target-lifecycle behavior
- **D-03:** If the target window closes/crashes mid-capture, stop recording and finalize the MP4 with frames captured so far. Surface a toast: `"Target window closed — recording stopped early"`. No fallback to full display mid-stream (too jarring visually).
- **D-04:** Target window crossing display boundaries mid-capture — capture follows the window. Rely on SCK's native `SCContentFilter::with_window` behavior which binds to the `SCWindow`, not a display. No pin-to-display semantics.

### Visual content
- **D-05:** Include all window chrome (OS title bar + browser tab bar + URL bar). Simplest SCK path, matches user expectations for demo recordings. Chrome-stripping (via `--app` mode Chromium launch or CSS injection) is a v2 concern.
- **D-06:** Cursor is always captured on window targets. Matches the current full-screen default behavior and what users expect in demo videos. Per-recording toggle is a v2 concern.

### Error recovery
- **D-07:** If SCK fails to start a window-targeted stream (TCC glitch, stale window id, macOS API error), silently fall back to xcap full-display and emit a warning toast: `"Window capture unavailable — recorded full screen"`. Don't block the recording — the user's story still completes, just with a wider recording.
- **D-08:** On repeated SCK failures (2+ consecutive attempts in the same session), show a modal explaining the situation with "Open System Settings" and "Use full-screen instead" buttons. Surface the root cause from the SCK error string.

### UI shape
- **D-09:** Single "Target" dropdown replaces the current "Display" dropdown. Flat list grouped by type:
  ```
  ▶ Playwright browser (auto)       [recommended, shown first when enabled]
  ▶ Full screen
    • Display 1 — Built-in Retina (3600×2338)
    • Display 2 — External Monitor (2560×1440)
  ▶ Specific window
    • Google Chrome — demo.acme.com
    • Safari — docs.apple.com
    • Arc — Gmail
    [... filtered to visible on-screen windows]
  ```
- **D-10:** The "Target" dropdown is visually identical to the existing shadcn Select component used elsewhere — don't introduce a new pattern.

### Phase breakdown (locked from research recommendation)
- **D-11:** Ship as **3 plans** (not 4 as originally scoped):
  - `05-01-PLAN.md` — macOS SCK streaming + window/display picker UI (merged — picker is 2hr of React atop enumeration API)
  - `05-02-PLAN.md` — Playwright window auto-follow (PID → SCWindow bridge, sidecar verb, defaults)
  - `05-03-PLAN.md` — Windows WGC parity (separate due to thin `windows-capture` 2.0.0 docs — 3 days old)

### Claude's Discretion

- **Exact `CaptureTarget` enum shape** — research suggests `Display(DisplayId)` / `Window(WindowId)` / `AppWindow(Pid)`; planner refines based on what flows cleanly through the Tauri IPC layer.
- **Window list refresh cadence** — the picker needs to re-enumerate visible windows periodically or on open. Planner picks (on-open-only vs 2s interval vs event-driven).
- **Window title truncation / deduplication** in the picker when many browser tabs are open.
- **Whether the recorder UI shows a live thumbnail** of the selected window before recording starts — nice-to-have, defer if it blows complexity budget.
- **How frame-pump backpressure interacts with window capture** — SCK callback runs on a GCD queue; `try_send` semantics already recommended in research. Planner formalizes.

</decisions>

<specifics>
## Specific Ideas

- **Reference products** users mentally map to: Tella, Screen Studio, Loom. Both default to "browser auto-follow" for demo workflows. We should match that mental model (D-01/D-02).
- **Today's pain** (as observed in live testing): StoryCapture covers the Chromium window → recording shows StoryCapture UI instead of the demo. Phase 5 exists because this friction is real and blocks the product from feeling effortless.
- **RESEARCH.md found `scap` crate as a reference implementation** — Rust SCK wrapper in CapSoftware. Planner should study `scap/src/capturer/engine/mac/mod.rs` for the minimum viable SCStream wiring (trait + delegate pattern already proven).

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 5 research
- `.planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/05-RESEARCH.md` — Prescriptive stack (screencapturekit=1.5.4, windows-capture=2.0.0), real-world pitfalls, minimum-viable code snippets, Playwright bridge design

### Existing capture / encode architecture
- `crates/capture/src/backend.rs` — `CaptureBackend` trait that Phase 5 implementations satisfy
- `crates/capture/src/fallback/xcap_backend.rs` — Working reference implementation (polled) — shows the frame → mpsc → Frame wire contract
- `crates/capture/src/macos/sck_backend.rs` — Existing stub with RAII + TCC preflight already wired (replace `start()` body, keep the rest)
- `crates/capture/src/frame.rs` — `Frame { pts, width_px, height_px, format, data, sequence }` — what every backend emits
- `crates/capture/src/pipeline.rs` — How frames flow from backend → encoder (mpsc channel + ByteBoundedQueue)

### Automation / Playwright bridge
- `scripts/playwright-sidecar/server.mjs` — Where the new `browserProcess` JSON-RPC verb lands (exposes `state.browser.process().pid`)
- `crates/automation/src/playwright_driver.rs` — Rust side; adds matching Rust method that calls the new verb
- `apps/desktop/src-tauri/src/commands/automation.rs` — Host wiring; Playwright launch flow where the PID-→window-id resolution happens

### UI components
- `apps/desktop/src/components/ui/select.tsx` — Base UI Select (match this pattern for the Target dropdown)
- `apps/desktop/src/features/recorder/recording-view.tsx` — Where the Target dropdown replaces the current Display dropdown
- `apps/desktop/src/ipc/capture.ts` — IPC wrappers; extend with `listWindows()`, new `CaptureTarget` types

### Project constraints
- `CLAUDE.md` — Cargo.lock pin `screencapturekit = "=1.5.4"` (correct) vs STACK.md's outdated `1.70.x` claim
- `.planning/PROJECT.md` — Perf/bundle constraints still apply (<2s cold start, <300MB idle)
- `.planning/STATE.md` — Historical decisions; the SckBackend stubbing is documented there with the reasoning we're now overriding

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `XcapBackend` (`crates/capture/src/fallback/xcap_backend.rs`) — Stays as the SCK-failure fallback per D-07; no changes needed beyond keeping the trait surface compatible.
- `SckBackend` skeleton (`crates/capture/src/macos/sck_backend.rs`) — TCC preflight, `CVPixelBufferHandle` RAII wrapper, trait impl shell. Replace `start()`/`stop()` bodies only.
- Existing `DisplayInfoDto` and `list_displays` IPC — pattern to mirror for `WindowInfoDto` / `list_windows`.
- `Select` + `SelectContent` + `SelectItem` + `SelectGroup` from Base UI — supports grouped options natively, no new component needed for D-09.
- `app_settings.json` + `get_app_settings` / `set_browser_executable` infrastructure (Phase 1 follow-up) — extend with `capture_target: CaptureTargetSpec` for D-01 stickiness.

### Patterns to Follow
- Tauri IPC commands live in `src-tauri/src/commands/*.rs`, typed DTOs use `#[derive(specta::Type)]`, registered in `ipc_spec.rs`.
- Playwright sidecar verbs: add handler in `server.mjs`, add matching call site in `playwright_driver.rs`.
- Recorder UI state lives in `src/state/recorder.ts` (Zustand); don't bypass it for capture-target state.

### Anti-Patterns to Avoid
- **Don't reintroduce chromiumoxide** — we deleted it intentionally in `refactor(automation): remove chromiumoxide dead code`. Window capture has nothing to do with the automation driver; keep the separation.
- **Don't block the async runtime from the SCK callback** — it fires on a GCD dispatch queue, not a tokio worker. Use `tokio::sync::mpsc::Sender::try_send()`, not `.send().await`.
- **Don't hand-roll CGWindow enumeration** — `SCShareableContent.windows()` is sufficient; skipping it for raw Quartz APIs is the trap earlier crates fell into.
- **Don't ship SckBackend without the xcap fallback** — D-07 requires SCK failure → xcap. Planner must wire this as part of 05-01, not as "we'll fix it later."

</code_context>

<deferred>
## Deferred Ideas

- **Audio capture** — Researcher found a specific bug (pyobjc #647, `EXC_BAD_ACCESS` on long audio streams). Keep video-only for 5.x. Audio capture is its own phase (6.x).
- **Region capture** — user-drawn rect. Interesting but not in phase scope.
- **Multi-window composition** — side-by-side recording of two windows. Not requested.
- **Chromium chrome-hiding** — launching via `--app` mode or CSS injection to hide tab bar / URL bar. Nice-to-have; wait for user demand.
- **Per-recording cursor toggle** — v2 polish; default behavior (D-06) covers 95% of demo-video cases.
- **Live preview thumbnail** of the target window before recording — defer unless it comes cheap in 05-01.
- **Mac App Store distribution** — MAS sandboxing rules out SCK for apps that want Screen Recording. Already a global project constraint; noted for the reader.

</deferred>

---

*Phase: 05-window-targeted-screen-capture-with-playwright-auto-follow*
*Context gathered: 2026-04-17 via /gsd-discuss-phase*
