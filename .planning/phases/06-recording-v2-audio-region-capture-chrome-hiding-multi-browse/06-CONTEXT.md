# Phase 6: Recording v2 — audio, region capture, chrome-hiding, multi-browser, live preview - Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Polish the recording pipeline to production-grade quality by shipping the features intentionally deferred from Phase 5's window-capture MVP. This is a grab-bag of independently-scoped enhancements that share a single surface (the recorder + capture pipeline) but not a single user story — each feature lands its own plan and is separately testable.

**Shipping in this phase:**
1. Microphone audio capture (optional, user-opt-in)
2. Region/crop capture (user-drawn rect)
3. Chromium chrome-hiding (tab bar + URL bar suppression for demo recordings)
4. Multi-browser auto-follow (Edge, Brave, Chrome Canary — not just Chromium)
5. Live preview thumbnail of the target window before recording
6. Per-recording cursor toggle
7. Windows real-capture E2E tests in CI (operator-triggered infra)
8. Edge/Brave `title_hint` in Playwright auto-follow

**Why grouped into one phase:** Each item was individually deferred from Phase 5 as "nice-to-have, not MVP-blocking." Together they form the "make recording feel polished" work that naturally comes after the window-capture MVP lands.

**Out of scope (pushed to future phases):**
- **Multi-window composition** (side-by-side recording) — needs timeline-layer compositing, belongs in Phase 2's post-production domain
- **Windows ARM64** — separate phase due to different `windows-capture` API surface
- **Screen recording on Mac App Store** — architecturally forbidden (sandbox ≠ screen recording). Global project constraint, not this phase's problem.
- **Reintroducing chromiumoxide** — deliberately deleted; stays deleted

</domain>

<decisions>
## Implementation Decisions

### Audio capture (1)
- **D-01:** Microphone audio only in this phase — no system audio. System audio on macOS requires virtual audio drivers (BlackHole / Aggregate Device) or Screen Recording entitlement upgrade; both are their own problem. Ship mic-only first.
- **D-02:** Opt-in at recording start (not sticky). Default off. Avoids accidentally recording someone's voice when they just wanted a silent demo.
- **D-03:** Work around pyobjc #647 (`EXC_BAD_ACCESS` on long SCK audio streams) by NOT using SCK audio. Use a separate mic capture path (CoreAudio / `cpal` crate) and mux with FFmpeg at encode time. Two independent streams, one output MP4.
- **D-04:** Audio device picker lives next to the Target dropdown. Defaults to system-default input. "No audio" option always present.

### Region capture (2)
- **D-05:** User draws a rectangle over the selected Display target — region is always relative to a display, not a window. Windows are already first-class targets (Phase 5); regions are for partial-display capture.
- **D-06:** Region is stored as `(display_id, x, y, w, h)` in logical pixels; resolver converts to physical at capture time.
- **D-07:** Use SCK's `SCContentFilter` with content rect + `scale_content_to_fit` for macOS. Windows equivalent via WGC crop rect. No custom FFmpeg crop filter — let the platform API do it so we don't waste bandwidth on captured-then-cropped frames.
- **D-08:** Picker UI: when user selects a Display target, a secondary "Crop to region..." action becomes available, opens a transparent fullscreen selection overlay (standard screenshot-tool pattern).

### Chrome-hiding (3)
- **D-09:** Use Chromium's `--app=<url>` launch flag when Playwright's target URL is known. Drops tab bar + URL bar + back/forward buttons. Keeps OS title bar.
- **D-10:** Off by default. Toggle in the recorder: "Hide browser chrome". When on, StoryCapture passes `--app=<meta.app>` through to Playwright's `chromium.launch({ args: [...] })`.
- **D-11:** Doesn't work for Safari / Firefox (no equivalent flag). Surface that in the UI — toggle is only enabled when the active Playwright browser is Chromium-family.
- **D-12:** OS title bar suppression is a v3 concern. Requires platform-native tricks (NSWindow.titleBarAppearsTransparent or similar). Not worth the complexity here.

### Multi-browser auto-follow (4, 8)
- **D-13:** Playwright's pid-to-window resolution currently hardcodes `title_hint: "Chromium"`. Replace with per-browser hint map: `chromium → "Chromium"`, `msedge → "Microsoft Edge"`, `chrome → "Google Chrome"`, `chrome-beta → "Google Chrome Beta"`, etc.
- **D-14:** Hint selection is driven by the existing `BrowserRow` setting (the browser-executable preset). When user picks "Edge" preset, auto-follow searches for Edge windows instead of Chrome.
- **D-15:** Fallback: if title-based match fails, fall back to "any window owned by the Playwright pid" (already the primary path). Title hint is a tiebreaker for multi-window cases.

### Live preview thumbnail (5)
- **D-16:** Shows in the recorder UI between the Target dropdown and the Start Recording button. Single static frame, refreshed every 2s while the recorder view is visible.
- **D-17:** Uses the same `SCShareableContent` enumeration path — call `SCScreenshotManager.captureImage(contentFilter:configuration:)` once per refresh, cache until the next tick.
- **D-18:** No live-streaming preview (continuous frames). Adds visual polish but burns CPU/battery for a use case that resolves in ~5 seconds. Defer to v3.

### Per-recording cursor toggle (6)
- **D-19:** Toggle in the recorder next to the Target dropdown. Defaults to "include cursor" (matches Phase 5 D-06).
- **D-20:** Not sticky — reset to default each recording. Cursor preference is per-story, not global.

### Windows E2E infrastructure (7)
- **D-21:** New GitHub Actions workflow runs on self-hosted graphical Windows runner. Triggered by `workflow_dispatch` + label `needs-windows-e2e`, not on every PR.
- **D-22:** Test matrix: launch Playwright, spawn Chrome window, run `list_windows + select + record 3s + verify MP4`. One happy-path per WGC target type (display / window).
- **D-23:** If we don't have a graphical Windows runner available at planning time, mark this as "infra-pending" and ship just the workflow stub + documented manual test script.

### Plan breakdown
- **D-24:** Ship as **4 plans** (grouping naturally-coupled features):
  - `06-01-PLAN.md` — Audio capture (1) — largest, most risk
  - `06-02-PLAN.md` — Region + chrome-hiding + cursor toggle (2, 3, 6) — all three are UI toggles + capture-config knobs; coherent vertical slice
  - `06-03-PLAN.md` — Multi-browser auto-follow + live preview (4, 5, 8) — both extend Phase 5's recorder UI and share enumeration code
  - `06-04-PLAN.md` — Windows E2E CI infrastructure (7) — standalone, infra-only

### Claude's Discretion
- **Audio codec / bitrate defaults** — AAC 128kbps mono is standard for voiceover; planner can override if research surfaces better.
- **Region-selection UX micro-details** — keyboard shortcuts (Esc to cancel, Enter to confirm), magnifier at corners, snap-to-pixel guides. Planner picks what's cheap.
- **Live-preview refresh cadence** — D-16 says 2s; planner may tune to 1s if SCScreenshotManager is fast enough, or 5s if it's expensive.
- **Chromium `--app` URL source** — D-09 says "when known from `meta.app`." If the story uses relative paths (rare), planner picks a fallback.

</decisions>

<specifics>
## Specific Ideas

- **Reference tools for chrome-hiding:** Screen Studio does this via Chromium `--app=<url>` — that's our blueprint.
- **Reference for region capture UX:** macOS built-in Cmd+Shift+4 — the transparent overlay + crosshair + live dimensions display. Match that interaction model, not a novel one.
- **Reference for audio opt-in flow:** Loom's "record with microphone" toggle next to start button — visible but not pushy.
- **Reference for live preview:** QuickTime's "New Screen Recording" dialog shows a thumbnail; set visual expectation from that.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 5 artifacts (Phase 6 builds on this)
- `.planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/05-CONTEXT.md` — locked decisions that Phase 6 inherits; D-05/D-06 (chrome + cursor always-on) are *relaxed* here
- `.planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/05-RESEARCH.md` — pyobjc #647 audio bug citation (drives D-03); SCShareableContent patterns
- `.planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/05-01-PLAN.md` — `CaptureTarget` enum shape that region capture extends
- `.planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/05-02-PLAN.md` — `browserProcess` verb + `title_hint` that multi-browser auto-follow extends
- `.planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/05-03-PLAN.md` — Windows WGC path that region capture extends

### Existing capture surface (all extended in this phase)
- `crates/capture/src/backend.rs` — trait
- `crates/capture/src/macos/sck_backend.rs` — macOS impl (Phase 5 output); audio not wired here, region not wired here
- `crates/capture/src/windows/wgc_backend.rs` — Windows impl (Phase 5 output)
- `crates/capture/src/frame.rs` — Frame shape (unchanged)

### Audio (D-03)
- `cpal` crate — canonical Rust audio I/O crate; cross-platform mic capture
- pyobjc issue #647 — SCK audio EXC_BAD_ACCESS on long streams (see 05-RESEARCH.md)
- FFmpeg `-map` + audio stream muxing — plan references encoder crate

### Recorder UI (D-09, D-10, D-16, D-19)
- `apps/desktop/src/features/recorder/recording-view.tsx` — where toggles + thumbnail land
- `apps/desktop/src/components/ui/select.tsx` — audio device picker reuses this
- `apps/desktop/src/features/settings/BrowserRow.tsx` — browser-executable preset (drives D-13/D-14)

### Playwright bridge (D-13)
- `scripts/playwright-sidecar/server.mjs` — `browserProcess` verb added in Phase 5; extend here
- `crates/automation/src/playwright_driver.rs`

### Infrastructure (D-21, D-22)
- `.github/workflows/capture-windows.yml` — from 05-03, extended here for real-capture E2E

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- All of Phase 5's capture plumbing — Phase 6 extends, doesn't rewrite.
- `app_settings.json` + get/set pattern (Phase 1) — extend with `audio_device_id`, `chrome_hiding_default` if desired.
- `BrowserRow` preset-click validation pattern — replicate for audio-device picker.

### Patterns to Follow
- Audio muxing: FFmpeg sidecar (encoder crate) accepts multiple inputs via `-i`. Don't reinvent.
- Region overlay: overlay window pattern already exists for panic-modal / onboarding tutorials — borrow.
- Chrome `--app` flag passing: Playwright launch args flow through existing `LaunchConfig.executable` path (Phase 1 follow-up). Extend `LaunchConfig` with `args: Vec<String>` field.

### Anti-Patterns to Avoid
- **Don't use SCK audio** — pyobjc #647 (D-03). Use `cpal`.
- **Don't make audio sticky by default** — D-02 is explicit opt-in; resist the temptation to "remember last choice."
- **Don't re-enter Phase 5's territory** — this phase does NOT touch `CaptureTarget` enum shape, Target picker UI layout, or the core SCK streaming path. Those are locked.
- **Don't build custom video crop filters** — D-07: use platform crop (SCK content rect / WGC crop rect), not FFmpeg `-vf crop`.

</code_context>

<deferred>
## Deferred Ideas

- **System audio capture** — virtual audio driver dependency (BlackHole / Aggregate Device) or Screen Recording entitlement upgrade. Own phase.
- **Live-streaming preview** (continuous frames vs static thumbnail) — v3 polish.
- **Multi-window composition** (side-by-side) — post-production territory (Phase 2 land).
- **Windows ARM64 capture support** — separate `windows-capture` API surface.
- **Safari / Firefox chrome-hiding** — no equivalent to Chromium's `--app` flag. Would require private WebKit APIs or Firefox command-line args that don't exist.
- **OS title bar suppression on chromium captures** — NSWindow-level trickery; v3.
- **Cursor visual overlay effects** (highlight ring, click pulse) — that's Phase 2 (cinematic post-production) territory, not capture.
- **Per-story audio settings persistence** — D-20 explicitly rejects stickiness for cursor; same logic applies to audio.

</deferred>

---

*Phase: 06-recording-v2-audio-region-capture-chrome-hiding-multi-browse*
*Context gathered: 2026-04-17 via scope-promotion from Phase 5 deferred list*
