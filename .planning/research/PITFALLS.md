# Pitfalls Research

**Domain:** Tauri v2 desktop screen-recording + browser-automation + post-production video pipeline (StoryCapture)
**Researched:** 2026-04-14
**Confidence:** HIGH for Tauri/FFmpeg/macOS permissions (official docs + many reported issues), MEDIUM for chromiumoxide maturity and HDR/color pipeline specifics (fewer authoritative sources; verify during Phase 1 spikes).

## Critical Pitfalls

### Pitfall 1: Requesting ScreenCaptureKit permission from a running process and expecting it to "just work"

**What goes wrong:**
App calls `SCShareableContent.current` (or starts a stream), macOS shows the TCC prompt, user grants permission, app continues — but the stream still returns a black frame / NSNotAuthorized. Users think the app is broken.

**Why it happens:**
macOS does not re-evaluate TCC permissions mid-process for Screen Recording. The permission only applies to newly-launched instances of the exact bundle identifier + code signature. On Sonoma/Sequoia, stale TCC entries (from unsigned dev builds, rebuilds with different team IDs, or renamed binaries) cause the app to appear granted in Settings but still get denied.

**How to avoid:**
- First launch: probe permission with `CGPreflightScreenCaptureAccess()` (or SCK equivalent). If denied, open `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`, show a modal explaining "Grant, then click Reopen," then `exit(0)` and relaunch via a helper or `open -a`.
- Never ship dev builds without stable signing identity — every resign creates a new TCC entry and the old one becomes "ghost granted."
- Detect Sequoia's 7-day/monthly re-prompt (macOS 15+) and surface a calm in-app banner when it returns.
- Test the entire flow on a fresh `tccutil reset ScreenCapture <bundle-id>`.

**Warning signs:**
Users report "black recording" on first run, permission list shows duplicate StoryCapture entries, TestFlight/beta users see prompts every launch, `log stream --predicate 'subsystem == "com.apple.TCC"'` shows `kTCCServiceScreenCapture` denials.

**Phase to address:** Phase 1 (MVP) — capture pipeline spike.

---

### Pitfall 2: FFmpeg sidecar notarization failure due to embedded dylibs / quarantine / missing hardened-runtime entitlements

**What goes wrong:**
Tauri build works locally. `tauri build` succeeds. Notary service rejects the DMG, or notarization passes but the app crashes on first launch on a clean Mac with "libavcodec.60.dylib not found" or Gatekeeper quarantine killing the sidecar.

**Why it happens:**
- Stock FFmpeg binaries from Homebrew/evermeet link against `@rpath` dylibs that are not bundled.
- Tauri's `externalBin` + `bundle.macOS.entitlements` often doesn't re-sign and staple *every* nested binary and dylib. Notary service rejects any unsigned Mach-O.
- Sidecars launched via `std::process::Command` inherit the parent's hardened-runtime but need `com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory` / `disable-library-validation` depending on how FFmpeg was compiled (dynamic ffmpeg linking against system libs requires `disable-library-validation`).
- Universal binary requirement: FFmpeg must be shipped as fat arm64+x86_64 or Rosetta-translated — single-arch sidecars on Apple Silicon get killed by Gatekeeper on Intel Macs.

**How to avoid:**
- Build FFmpeg **statically** (`--enable-static --disable-shared --pkg-config-flags=--static`) as a universal binary (`lipo` arm64 + x86_64) — eliminates the dylib rabbit hole. Accept ~30-60 MB sidecar size; stay under 50 MB installer budget by using `--disable-everything` and enabling only needed codecs/filters (h264, hevc, aac, libx264 only if GPL-safe; otherwise rely on VideoToolbox).
- In CI, run `codesign --deep --force --options runtime --sign "$IDENTITY" ffmpeg-aarch64-apple-darwin` (and x86_64) **before** `tauri build`, then verify with `codesign --verify --deep --strict --verbose=2`.
- Explicit entitlements in `Entitlements.plist`: `com.apple.security.cs.allow-unsigned-executable-memory` (FFmpeg JIT in some filters), `com.apple.security.cs.disable-library-validation` only if using dynamic linking, `com.apple.security.device.camera`, `com.apple.security.device.audio-input`.
- Test on a Mac that has *never* built or run the app (use a VM or CI runner) — local machines have granted permissions & signed dev certs that mask issues.
- License audit: if you compile FFmpeg with `--enable-gpl` (x264/x265) you inherit GPL — either choose LGPL-only build (VideoToolbox + libfdk removed) or accept GPL redistribution terms.

**Warning signs:**
`xcrun notarytool log` reports "The binary is not signed" for nested dylibs, `spctl -a -vv StoryCapture.app` shows "rejected," app launches on your Mac but not on a colleague's, FFmpeg exits with signal 9 (SIGKILL) immediately.

**Phase to address:** Phase 1 — must be solved before end of Phase 1 or it blocks every release after.

---

### Pitfall 3: chromiumoxide maturity gaps causing silent flakiness (file uploads, downloads, auth state, multi-tab)

**What goes wrong:**
chromiumoxide works for navigate/click/type in demos, but real stories involving `<input type=file>`, OAuth redirects to new tabs, SPA route changes without full navigation, download-to-disk, or shadow-DOM selectors silently hang or time out. Stories author thinks their DSL is wrong.

**Why it happens:**
chromiumoxide is a CDP wrapper maintained by a small team — it does NOT replicate Playwright's auto-waiting, actionability checks, network idle heuristics, auto-accept dialog handling, or shadow-DOM piercing selectors. Developers assume "CDP is CDP" but Playwright's reliability comes from ~50k lines of JS glue on top of CDP, not from CDP itself.

**How to avoid:**
- **Design the `automation` crate with a trait abstraction** (`trait BrowserDriver`) from day one, with two impls: `ChromiumoxideDriver` and `PlaywrightSidecarDriver` (Node sidecar running `playwright-core`). Default to chromiumoxide; fall back per-command or per-project to Playwright.
- Implement explicit auto-waiting in the DSL layer: every action = `(wait_for_selector_actionable → scroll_into_view → wait_for_stable → act)`. Don't rely on chromiumoxide's built-in waits.
- For file upload, OAuth popups, downloads, and shadow DOM: route to Playwright sidecar automatically based on DSL command (`upload`, `wait-for-download`, auth helpers).
- Pin `chromiumoxide` and `chromiumoxide_cdp` to exact versions; CDP protocol drift between Chrome versions causes undocumented deserialization failures.
- Bundle a known-good Chromium (or use system Chrome + version check) — do NOT rely on whatever Chrome the user has installed.

**Warning signs:**
Flaky tests in CI that pass locally, `Timeout waiting for element` on elements visibly present, hangs on pages with CSP or iframes, "Protocol error (Target.attachedToTarget)" in logs.

**Phase to address:** Phase 1 — design the trait early. Phase 2 — add Playwright sidecar fallback when specific commands start failing.

---

### Pitfall 4: Cursor-overlay interpolation that looks fake (jitter, lag, teleports through UI)

**What goes wrong:**
Auto-generated cursor trail jumps between action points in straight lines, passes *through* buttons/panels, overshoots, or visibly lags behind the real click event. Final video screams "automation" instead of "human demo."

**Why it happens:**
- DSL actions are discrete (click X, click Y) but cursor trajectory is continuous — naive linear interpolation between action timestamps produces unnatural motion.
- Recording framerate (60fps) vs. action event timing (sub-frame) drift: if cursor positions are sampled at action time only, overlay is under-sampled.
- No easing: real humans don't move at constant velocity. Linear = robotic. Bezier without acceleration curves = floaty.

**How to avoid:**
- Use a **minimum-jerk trajectory** or **Catmull-Rom spline** through action points with ease-in-out cubic timing. Research: Flash et al. 1985 minimum-jerk model maps directly to human mouse motion.
- Sample trajectory at render framerate (60fps) — precompute full path before FFmpeg overlay, don't compute frame-by-frame.
- Add sub-pixel deterministic jitter (Perlin noise, amplitude ~1px) to avoid "robot-straight" lines.
- Click ripple animation must *anticipate* the click (start 50-80ms before), not trigger after — mimics human settle-before-click.
- For browser automation, capture the real cursor via CDP `Input.dispatchMouseEvent` timestamps; for screen capture, use native cursor *position queries* (not cursor *image capture*) at render time for ground truth, then stylize in post.

**Warning signs:**
Demo viewers say "it looks automated," cursor passes through modal overlays, click ripple fires on blank canvas area, A/B test against a human-recorded reference shows uncanny-valley feedback.

**Phase to address:** Phase 2 (post-production) — spike the trajectory model before committing to the overlay render approach.

---

### Pitfall 5: Auto-zoom that induces motion sickness (jitter, over-zoom, rapid target-switching)

**What goes wrong:**
Auto-zoom chases every small UI event, snaps between targets too fast, over-zooms into 8x on a tiny button, or zooms back out with visible keyframe pops. Users close the video within 10 seconds.

**Why it happens:**
- Target selection based on "last click location" alone — produces a jittery follow-the-bouncing-ball effect on dense UIs.
- No temporal hysteresis: the algorithm re-decides every frame whether to zoom, causing micro-oscillation.
- Zoom factor derived from element bbox without a sane minimum viewport (tiny icon → max zoom).
- Easing via linear interpolation of scale *and* translate simultaneously looks unnatural.

**How to avoid:**
- **Debounce zoom targets**: minimum 600-800ms dwell before a new zoom target is accepted; enforce minimum shot length (1.5-2s) and maximum zoom factor (typically 2.5-3x).
- **Look-ahead scheduling**: run the whole recording through the post-pro planner *before* rendering. Produce a keyframe list (time, center, scale) offline, then smooth with low-pass filter (e.g., critically-damped spring).
- Separate *scale* and *pan* curves — animate pan first, then scale in, then hold. Never combine.
- Offer a "calm" vs "dynamic" preset; default to calm. Preset for "Linear-like minimalism" = pan only, scale fixed.
- Cap zoom transitions per minute (≤6-8) for comfort.

**Warning signs:**
Internal QA reports nausea, heat-maps of zoom keyframes show clusters <500ms apart, exported video has >12 zoom changes per minute, frame-diff between adjacent keyframes shows large deltas.

**Phase to address:** Phase 2 (post-production effects).

---

### Pitfall 6: Audio/video drift across long recordings (>5 min) due to variable frame rate capture

**What goes wrong:**
Screen capture produces variable-frame-rate (VFR) video (native APIs deliver frames only on change). FFmpeg concat/encode assumes constant frame rate. Voiceover mixed at 48kHz gets progressively out-of-sync: lip-sync drifts by 1-3 seconds across a 10-min video.

**Why it happens:**
- ScreenCaptureKit and Windows.Graphics.Capture push frames on *refresh*, not on a fixed clock — if the screen doesn't change, no frame is emitted. PTS/DTS reflect wall-clock time.
- Naive encoder pipeline (`-r 60` without `-vsync vfr` and without re-timestamping) either duplicates or drops frames incorrectly.
- Audio recording uses a separate clock (CoreAudio HAL / WASAPI) that drifts ~±50ppm from the system monotonic clock used for video PTS.

**How to avoid:**
- Preserve original PTS from the capture API; encode with `-vsync vfr` (preserve VFR) OR insert duplicate frames explicitly to reach target CFR (`fps=60:round=near`).
- Timestamp both audio and video against a single source — `CMTime` on macOS (use AVAudioEngine with same host time clock), `QueryPerformanceCounter` on Windows for both streams.
- Run periodic drift correction: every 30s, compare audio sample count × rate vs. wall-clock; if drift >10ms, resample audio (`aresample=async=1000`).
- Final mux: use FFmpeg `-async 1` and `-use_wallclock_as_timestamps 0`; verify with `ffprobe -show_entries frame=pkt_pts_time` that audio and video PTS align at 0 and at end.

**Warning signs:**
Lip-sync feels off in voiceovers, waveform peaks don't match click timings in timeline, `ffprobe` shows audio duration ≠ video duration by >100ms, user reports "video finishes before voiceover."

**Phase to address:** Phase 1 (basic mux), hardened in Phase 2 (voiceover sync), critical for Phase 3 (AI TTS).

---

### Pitfall 7: Multi-display / HDR / retina capture producing wrong-resolution or washed-out output

**What goes wrong:**
User on a 5K Retina XDR recording a dark-mode demo exports a video that is (a) 1440p instead of 5K, (b) washed-out/gamma-shifted, (c) cropped to one monitor of three, or (d) black on HDR content. Color grading done in post looks fine locally but wrong on YouTube/Loom.

**Why it happens:**
- ScreenCaptureKit's `SCStreamConfiguration.width/height` defaults to points (1x), not pixels (2x/3x on Retina). Developers set `width = displayBounds.width` and get half-resolution output.
- HDR displays (EDR) on macOS deliver float16 BT.2020 PQ content; encoding as BT.709 8-bit produces the "washed out" effect. Windows HDR + WGC similar — the surface format is R16G16B16A16_FLOAT.
- Multi-display: `SCDisplay` arrays require explicit per-display filter; developers pick `displays[0]` and miss the user's main monitor if hot-plugged later.
- Cursor is *not* captured by default on ScreenCaptureKit — must set `showsCursor = true`.

**How to avoid:**
- Query `backingScaleFactor` / `NSScreen.main.backingScaleFactor` and multiply explicitly. Store source resolution in project metadata.
- Detect HDR: `SCDisplay.preferredColorSpace` / `DXGI_OUTPUT_DESC1.ColorSpace`. If HDR, either (a) tone-map to SDR BT.709 in capture pipeline (`zscale=tin=smpte2084:matrixin=bt2020nc:primariesin=bt2020 → bt709`) or (b) preserve HDR10 metadata through the encode (requires HEVC Main10 + VideoToolbox/NVENC HDR options). For v1, tone-map to SDR — HDR delivery pipelines are a Phase 5 concern.
- Let user pick display explicitly in UI; default to the display containing the Tauri window at record-start; handle display-disconnect mid-recording gracefully (emit error, don't crash).
- Sanity check: on first launch, capture one frame and verify `dimensions == expected_pixels`. Write unit test that scales-by-backing-factor math.

**Warning signs:**
Users on 4K/5K monitors report "blurry" or "low-res" exports, HDR content looks gray, multi-monitor users see wrong screen captured, cursor missing in output.

**Phase to address:** Phase 1 — resolution/cursor. HDR tone-mapping in Phase 2.

---

### Pitfall 8: Native capture memory leaks / zero-copy surface mishandling (OOM during long recordings)

**What goes wrong:**
Recording starts fine, memory usage creeps up ~50MB/min, after 20 minutes the app is consuming 2GB+ and crashes or triggers macOS memory pressure warnings (exceeding the <800MB recording budget by 3x).

**Why it happens:**
- ScreenCaptureKit delivers `CMSampleBuffer` backed by IOSurface — if Rust holds the sample buffer (e.g., queuing frames for FFmpeg stdin) without explicit release, IOSurfaces accumulate in the WindowServer-shared memory pool.
- `objc2` + `Send`+`Sync` wrappers around `CMSampleBufferRef` without proper CFRelease semantics → reference leaks that bypass Rust's drop.
- Windows.Graphics.Capture: `Direct3D11CaptureFrame` must be `Close()`-d; wrapper via `windows-rs` sometimes doesn't propagate Drop correctly across async boundaries.
- Frame queue between capture thread and encoder thread sized in frames not bytes → at 4K60 (~25MB/frame BGRA), a 60-frame queue is 1.5GB.

**How to avoid:**
- Zero-copy path: pipe native surfaces directly to VideoToolbox / D3D11VA encoder (no Rust-side buffering). Compressed frames are 100-1000x smaller.
- If an intermediate buffer is required, use a bounded, back-pressured queue sized in bytes (~64MB cap); drop frames rather than OOM (log drops).
- Wrap `CMSampleBufferRef` / `ID3D11Texture2D` in RAII types that explicitly call `CFRelease` / `Release` on drop; write leak tests with `leaks` (macOS) / RAMMap (Windows) for 10-min recordings.
- Stress test: 1-hour recording on each platform in CI (or nightly) with memory-growth assertion (<100MB growth over baseline).

**Warning signs:**
Memory monitor shows linear growth during recording, `vmmap` on macOS shows growing `IOSurface` / `MALLOC_NANO` regions, `leaks StoryCapture` reports CF leaks, Windows Task Manager shows GPU memory climbing.

**Phase to address:** Phase 1 — zero-copy architecture must be designed in from the start; retrofitting is expensive.

---

### Pitfall 9: pest DSL parser producing cryptic errors that destroy user trust

**What goes wrong:**
User makes a typo: `clik "Save"` instead of `click "Save"`. pest emits: `expected rule 'command' at line 5 col 1`. User has no idea what to do. They blame the tool.

**Why it happens:**
- pest's default error is a rule-tracking trace — accurate but unreadable.
- No recovery: first syntax error stops the whole parse, so users fix one error at a time across many save-run cycles.
- No "did you mean" suggestions.
- Line/column pointing to rule entry, not to the actual bad token.

**How to avoid:**
- Build a **two-layer parser**: tokenize commands leniently (allow unknown command names), then semantic-check each command against the DSL vocabulary with Levenshtein-distance suggestions ("`clik` is not a known command. Did you mean `click`?").
- Implement panic-mode recovery: on error, skip to next newline/scene boundary and continue — collect all errors before reporting.
- Spans everywhere: every AST node carries source range (line, col, byte offset) for editor squiggles.
- Ship an LSP server from day one — even a stub with hover + diagnostics dramatically raises perceived quality. CodeMirror 6 + `@codemirror/lsp` consumes it.
- Test the parser with user-written stories, not developer-crafted ones: run 20 non-developers through Phase 1 and log every parse error.

**Warning signs:**
Support tickets are 80% "what does this error mean," users revert to copy-pasting examples, LLM-generated DSL fails to parse because it invents slightly-wrong syntax.

**Phase to address:** Phase 1 MVP (lenient parser + good errors). LSP + hover in Phase 2. AI-assisted correction in Phase 3.

---

### Pitfall 10: Turborepo + native Rust deps causing multi-minute cold builds & "works on my machine" for contributors

**What goes wrong:**
Monorepo has `apps/desktop` (Tauri/Rust), `apps/web` (Next), `packages/*` (TS), `crates/*` (Rust). New contributor clones, runs `pnpm install && pnpm dev`, waits 8 minutes while cargo compiles chromiumoxide + 400 deps, then hits an objc2 build error because they're on Linux. Existing dev's `target/` cache isn't sharable.

**Why it happens:**
- Turborepo doesn't natively understand `Cargo.toml` inputs — cache keys miss changes, cache hits when they shouldn't.
- `target/` is gitignored but not shared across team; cargo recompiles everything on every `rustup` toolchain bump.
- Platform-specific crates (`objc2`, `windows-rs`) without `[target.'cfg(...)'.dependencies]` gates break cross-platform CI.
- Tauri v2 native deps (WebView2Loader on Windows, WKWebView linking on macOS) require platform SDKs; new devs without Xcode Command Line Tools or Windows SDK hit obscure linker errors.

**How to avoid:**
- Use `sccache` (with shared S3 bucket) or `cargo-chef` for Dockerized CI caching; document `sccache` setup in CONTRIBUTING.md.
- Platform-gate every native dep in `Cargo.toml`: `[target.'cfg(target_os = "macos")'.dependencies] objc2 = "..."`. Run `cargo check --target x86_64-pc-windows-msvc` in CI from macOS host (via `cross`) to catch breakage early.
- Define Turborepo `pipeline` with explicit inputs for Rust crates (`"inputs": ["Cargo.toml", "Cargo.lock", "src/**"]`) and outputs (`"outputs": ["target/release/**"]`).
- Enforce toolchain via `rust-toolchain.toml` at repo root (pin stable version + components `rust-src`, `rustfmt`, `clippy`).
- CI matrix: macOS arm64, macOS x64, Windows x64 — run a smoke build on all three for *every* PR, not just releases.
- Shared TS types: use `ts-rs` or `specta` (Tauri-integrated) to auto-generate TS from Rust structs — keeps `packages/types` in sync without manual drift.

**Warning signs:**
Onboarding guide has >10 troubleshooting entries, CI passes but local builds fail, "did you rebuild the Rust crate?" is a frequent Slack message, PR feedback cycle exceeds 10 minutes.

**Phase to address:** Phase 1 — invest in dev infra early or pay 10x later.

---

### Pitfall 11: Tauri v2 auto-updater with differential updates breaking signed distribution

**What goes wrong:**
Auto-updater downloads a partial update, applies it, app launches — Gatekeeper quarantine flag triggers "StoryCapture is damaged and cannot be opened" because the patched binary's signature no longer matches the notarization ticket.

**Why it happens:**
- Differential updates patch individual binaries inside `.app`; any change invalidates the code signature.
- Tauri updater supports this *only* if you sign+notarize each incremental patch and publish a signed `latest.json` — easy to forget one step.
- macOS extended attributes (`com.apple.quarantine`) are applied to downloaded files; updater must strip them (`xattr -d com.apple.quarantine`) after install, *and* the update payload itself must be notarized (not just the original app).
- Tauri's updater private key stored in plain `.env` has been leaked multiple times in public repos.

**How to avoid:**
- For v1, **ship full-app replacement updates**, not differential — simpler, always-signed, one notarization per release. Differential is Phase 5 optimization once the release cadence is known.
- Notarize every updater payload (`.tar.gz` of the `.app`) via `notarytool submit --wait`. Staple the payload if supported, otherwise staple the final installed app.
- Generate updater signing key with `tauri signer generate`; store private key in GitHub Actions secret / 1Password, **never** in repo.
- Test upgrade path end-to-end in CI: install v1.0.0, run updater, verify v1.0.1 launches without Gatekeeper prompt (requires notarized artifacts in staging).
- Provide a manual "Download latest" fallback URL — auto-updater *will* break at some point; users need a way out.

**Warning signs:**
Users report "damaged" error after update, `spctl --assess` on updated .app shows "source=No matching ticket," updater silently fails and reverts, crash reports show `CFBundleIdentifier mismatch`.

**Phase to address:** Phase 1 (basic full-replacement updater + signing). Differential updates deferred to Phase 5.

---

### Pitfall 12: Filter-graph ordering destroying quality (zoom before denoise, overlay before color)

**What goes wrong:**
Post-pro chain applied in wrong order: auto-zoom upscales first (revealing compression artifacts), *then* denoise (muddy); cursor overlay composited before color grade (cursor is color-graded and looks wrong); text overlay rendered at source resolution then scaled (pixelated).

**Why it happens:**
FFmpeg `filter_complex` graphs are easy to write left-to-right as features are added, without architectural thought about signal-chain order.

**How to avoid:**
- **Canonical filter order** (document + enforce in code):
  1. Source decode
  2. Denoise / deblock (on source pixels)
  3. Color grade / tone-map (linear-light if possible, `zscale=t=linear`)
  4. Crop / zoom / pan (in source resolution)
  5. Scale to output resolution (single scale op, lanczos/spline)
  6. Cursor overlay (in output space, alpha over)
  7. Text overlay (in output space, at output resolution — use `drawtext` not pre-rendered PNG for crispness)
  8. Transitions (xfade in output space)
  9. Encode (with VideoToolbox/NVENC, not libx264 unless quality-mode)
- Build the graph programmatically via a typed Rust AST (`FilterNode`) — never string-concatenate filtergraphs.
- Snapshot-test key frames at each stage; CI compares PSNR against reference to catch regressions.

**Warning signs:**
Export looks different from preview, cursor color shifts, text looks pixelated, users complain exports are "lower quality than the source."

**Phase to address:** Phase 2 — the filter-graph architecture is the core of the post-production engine.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Shell out to system `ffmpeg` instead of bundled sidecar | No bundling/notarization headaches in dev | Ships broken to users without ffmpeg, no reproducibility, version skew | Phase 1 week 1-2 spike only; must be gone before any beta |
| Use `tokio::process::Command` string args for FFmpeg | Fast iteration | Shell-injection risk, quoting bugs, no type safety | Prototype only — replace with typed filter AST by mid-Phase 2 |
| Skip signing dev builds to speed iteration | 5s faster `cargo run` | Every ad-hoc build creates new TCC ghost entry; permission testing becomes useless | Never — use one stable local dev identity |
| Hardcode display 0 / main monitor | Works for single-monitor devs | Fails for 60%+ of target users (developers have multi-monitor) | Phase 1 spike only |
| Store API keys (Anthropic/OpenAI) in SQLite or `.env` | Simpler than keychain APIs | Compliance violation, keys leak to backups / iCloud / spotlight | Never for production; OS keychain from day 1 |
| Ship x86_64-only sidecars on Apple Silicon (Rosetta fallback) | Skip universal-binary build complexity | 2-3x encode time on M-series, thermal throttling, looks "slow" vs. competitors | Phase 1 smoke test only |
| Copy FFmpeg stdin frame-by-frame in Rust | Simple plumbing | 4K60 = ~1.5GB/s memory bandwidth; violates <800MB budget | Never for production; zero-copy to VideoToolbox / NVENC instead |
| Ignore HDR (capture as SDR only) | Simpler pipeline | Black/washed outputs for HDR users on modern Macs | Acceptable for v1; document limitation; tone-map in Phase 2 |
| Single global Chrome instance for automation | Faster start | State leaks between stories, auth tokens persist, flaky | Phase 1 spike only — one browser context per story |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| ScreenCaptureKit | Holding `SCStream` reference across app states without `stopCapture` on background | Tie stream lifecycle to an explicit state machine (Idle/Prep/Recording/Finalizing); `stopCapture` on window-close, sleep, display-disconnect |
| Windows.Graphics.Capture | Forgetting `Direct3D11CaptureFramePool.Recreate` on display mode change | Subscribe to `DisplaySettingsChanged`; recreate pool; also handle graphics-device-removed (TDR) |
| VideoToolbox H.265 encoder | Using 8-bit profile for HDR source | Detect source bit depth; select `kVTProfileLevel_HEVC_Main10_AutoLevel` when needed; validate with `VTSessionCopyProperty` |
| NVENC | Assuming available on all NVIDIA cards | GeForce 10xx+ required for HEVC; Quadro drivers differ; always probe at startup and fall back to QSV → libx264 |
| chromiumoxide | Reusing one browser tab across DSL runs | New `BrowserContext` per story; dispose on completion; clear cookies/localStorage between |
| Playwright sidecar | Bundled Node but not Chromium | Playwright Node lib doesn't bundle browsers — must `playwright install chromium` or ship Chromium alongside |
| Tauri IPC | Passing large buffers (raw frames, export progress video) over `invoke` | IPC is JSON-serialized & slow; use `Window::emit` events for progress, file-path handoffs for buffers |
| SQLite via rusqlite | Opening one connection and sharing across threads without WAL or pool | Enable WAL (`PRAGMA journal_mode=WAL`); use `r2d2` pool; one write connection, many read |
| S3/R2 upload | Single-part upload for 1GB+ videos | Multipart upload with resumable checkpoints; signed URLs from web backend, direct-to-R2 from desktop |
| Keychain (macOS / Credential Manager) | Storing secrets with `kSecAttrAccessibleAlways` | Use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; bind to app's code-signature via ACL |
| Tauri + Next.js web sync | WebSocket auth via plaintext token in URL | Short-lived JWT issued by web backend, refresh on reconnect, mTLS-like desktop cert for workspace binding |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Encoding in libx264 when VideoToolbox is available | CPU 100%, fans loud, encode slower than realtime | Always probe VideoToolbox / NVENC first; libx264 only as software fallback | Any recording >2 min on laptop |
| Synchronous filter-graph construction per frame | Progress stalls, UI unresponsive | Build filtergraph once, reuse; run in dedicated thread | Recordings >30s or any export |
| Rendering cursor overlay at 4K every frame via canvas then composite | Render time >> 30s for 1-min clip | Pre-render cursor sprite sheet; FFmpeg `overlay` filter with alpha | Exports at 4K |
| Loading full video into memory for preview | 2GB+ RAM on 5-min HD clip | Stream via `mpv` / `ffplay` embedded or HLS chunks | Any video >2 min at 1080p |
| Re-encoding clips for every timeline edit | Edit latency multi-second | Proxy encode (low-bitrate) for preview; render only on export | Timeline projects with >3 clips |
| Running browser automation + screen capture + encode on same thread | Dropped frames, flaky automation | Dedicated threads: capture, encode, automation, IPC; bounded channels | Every recording beyond demo length |
| Next.js web companion: no CDN for uploaded videos | R2 egress cost explosion, slow playback | Cloudflare Stream or R2+CDN; HLS/DASH encoding in Lambda | >100 active shares/month |
| TanStack Query default `staleTime: 0` on project list | Constant re-fetch during editing | Set sane `staleTime` per query; invalidate on mutation | Projects with >50 stories |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| LLM API key sent from desktop to web companion in plaintext | Key exfiltration via WS MITM | Desktop holds key in OS keychain; never transmitted; all LLM calls originate from desktop |
| Browser automation reused session inherits user's real cookies | Story runs as *user* against *real* banking/etc sites | One-off `BrowserContext` per story; explicit allowlist of domains; warn on recording of sensitive domains |
| Screen capture includes notifications, password managers, secrets | Accidental credential leak in shared demos | Pre-record checklist UI: "Pause notifications? Enable DND? Close password manager?" Auto-enable macOS Focus during record |
| Tauri `allowlist` too permissive (e.g., `fs: { scope: "**"}`) | Story-file code injection can read ~/.ssh | Minimal allowlist; per-capability scope; audit each `invoke` handler for path traversal |
| Updater endpoint unsigned / over HTTP | MITM ships malicious update | Updater URL over HTTPS, payload signed with Tauri updater key, verify signature before apply |
| Web companion: uploaded video in public S3 bucket | Accidentally-public recordings with passwords/secrets | Private bucket + signed URLs; default share setting = workspace-only; warn on "public" toggle |
| User-authored DSL passed to LLM without sanitization | Prompt injection → exfiltration via AI response | Treat DSL as untrusted; LLM system prompt explicitly ignores DSL-embedded instructions; strip obvious injection markers |
| Storing auth tokens in localStorage (web companion) | XSS → token theft | httpOnly secure cookies for session; CSP strict-dynamic; NextAuth with JWT rotation |
| No rate-limit on LLM endpoint (per-user) | Single compromised key drains Anthropic credit | Per-user daily quota; alerting on spend >$X; user-provided keys preferred over shared |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Asking for Screen Recording + Accessibility permissions on first launch before user understands value | Users deny, never return | Show onboarding story *first*; request permission only when user clicks "Record" the first time with contextual modal |
| Black "recording in progress" window that the user can't see behind | User loses orientation, records the wrong thing | Small floating HUD (toggle-able), with elapsed time, step indicator, big red STOP; never full-screen overlay |
| No progress during long renders (1-min video taking 25s) | Users think it froze, quit, corrupt outputs | Streaming progress from FFmpeg `-progress pipe:` parsed into phase + percent; show ETA |
| DSL syntax errors only surface at "Run" time | Users waste time on invalid stories | Live diagnostics via LSP-in-editor; red squiggles as they type; status bar "3 errors" |
| Export dialog with 12 codec options for non-technical users | Choice paralysis, wrong format for target | Three presets: "Share on web (MP4 1080p H.264)," "Best quality (MP4 4K HEVC)," "GIF preview." Advanced drawer hidden. |
| Auto-zoom on every click | Motion sickness, demo feels frantic | Default "calm" preset; user opts into "dynamic"; provide toggle per-scene |
| No way to preview a story without recording the full thing | Long iteration loop | "Dry run" mode: browser automation only, no recording, no post-pro; <10s feedback |
| Voiceover generated then out-of-sync with video | User must regenerate from scratch | Edit voiceover timing independently; regenerate per-segment; auto-align via cross-correlation |
| Hardcoded English-only DSL keywords | Localization blocker | DSL keywords stay English (like SQL); UI chrome + error messages localized |
| No visible indication that automation is running a story | User touches mouse mid-run, breaks recording | Mouse/keyboard lockout overlay during recording; clear "click to abort" |

## "Looks Done But Isn't" Checklist

- [ ] **Screen recording permission flow:** Often missing relaunch-after-grant handler — verify on a fresh Mac where TCC is reset.
- [ ] **FFmpeg sidecar:** Often missing code-signing of nested Mach-O — verify `codesign --verify --deep --strict` passes on every binary inside `.app/Contents/MacOS/`.
- [ ] **Notarization:** Often succeeds locally but fails on fresh Mac — verify by installing on a VM that has never seen your dev cert.
- [ ] **Auto-updater:** Often works for first update but corrupts on second — verify chain v1.0.0 → v1.0.1 → v1.0.2.
- [ ] **Multi-display capture:** Often picks `displays[0]` — verify with hot-plugged external monitor as primary.
- [ ] **HDR display:** Often emits black or washed video — verify on XDR-capable Mac with HDR content visible.
- [ ] **Universal binary:** Often only `arm64` — verify `file StoryCapture.app/Contents/MacOS/*` shows Mach-O universal.
- [ ] **DSL parser:** Often stops at first error — verify by feeding a file with 5 distinct typos and expect 5 diagnostics.
- [ ] **Browser automation:** Often passes locally, flakes in CI — verify 100 consecutive `cargo test` runs pass in headless CI.
- [ ] **Memory during long recordings:** Often unbounded — verify 30-min recording stays under 800MB RSS.
- [ ] **Audio/video sync:** Often drifts — verify lip-sync alignment at 0s, 5min, 30min marks via `ffprobe`.
- [ ] **Cursor in output:** Often missing (default `showsCursor=false`) — verify cursor visible in every exported format.
- [ ] **Dark mode UI contrast:** Often fails WCAG on accent colors — verify with axe-core + manual contrast check.
- [ ] **Keychain API-key storage:** Often works on unlocked device only — verify after reboot / fresh login.
- [ ] **Project file portability:** Often uses absolute paths — verify moving a project folder to another Mac still opens.
- [ ] **Tauri IPC for large data:** Often JSON-encodes a 100MB buffer — verify IPC message size <1MB.
- [ ] **Web companion uploads:** Often single-part, fails on bad wifi — verify 1GB upload survives network drop mid-transfer.
- [ ] **Chromium headed vs. headless:** Often diverges in behavior — verify DSL stories produce identical output both ways.
- [ ] **Cursor trail on first frame:** Often starts from (0,0) — verify initial position is the real cursor pos at record start.
- [ ] **Localized system (non-English macOS):** Often breaks path parsing — verify on French/Japanese macOS for `~/Movies` equivalents.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| TCC ghost-granted permission | LOW | `tccutil reset ScreenCapture <bundle-id>`; relaunch; re-grant; document in README |
| FFmpeg sidecar notarization reject | MEDIUM | Re-sign all nested Mach-O; resubmit; if reject persists, switch to static-linked FFmpeg |
| chromiumoxide feature gap blocking a DSL command | MEDIUM | Route that command to Playwright sidecar; ship behind feature flag |
| Cursor jitter in shipped release | LOW | Hotfix updater push with new trajectory constants; no data migration needed |
| Auto-zoom motion sickness complaints | LOW | Ship "calm preset" as new default via update; preserve user's manual override |
| A/V drift in past recordings | HIGH | Offer re-render from project source (.scap file); cannot fix exported MP4s after-the-fact |
| Memory leak in capture | MEDIUM | Hotfix; affected recordings must be re-recorded; warn users via in-app banner |
| pest parser crash on user input | LOW | Wrap in `catch_unwind`; report to Sentry; ship parser fix in next release |
| Updater signing key leaked | HIGH | Revoke key, publish new key in emergency release, all users must manually download new version (updater won't work with old key) |
| Gatekeeper "damaged" after update | HIGH | Publish instructions to `xattr -cr /Applications/StoryCapture.app`; fix updater payload signing; new release |
| Uploaded video with secrets public | HIGH | Immediate takedown API; audit logs; notify affected user; implement "scan for common secret patterns" before upload (regex for API keys, JWTs) |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| #1 ScreenCaptureKit permission flow | Phase 1 | Fresh Mac test: `tccutil reset` + first-run flow works end-to-end |
| #2 FFmpeg sidecar notarization | Phase 1 | CI runner notarizes on every release tag; install on clean VM passes |
| #3 chromiumoxide maturity gaps | Phase 1 (trait); Phase 2 (Playwright fallback) | DSL test suite runs green across both drivers |
| #4 Cursor interpolation jitter | Phase 2 | Side-by-side vs. human-recorded reference; user survey score >7/10 |
| #5 Auto-zoom motion sickness | Phase 2 | QA session of 5 videos >3min; no nausea reports; zoom-changes/min <8 |
| #6 A/V drift | Phase 1 (basic), Phase 2 (TTS), Phase 3 (AI voiceover) | `ffprobe` PTS alignment check in CI; 30-min recording stays <50ms drift |
| #7 Multi-display / HDR / Retina resolution | Phase 1 (base res); Phase 2 (HDR tone-map) | Matrix test: 1080p/4K/5K, SDR/HDR, single/dual monitor |
| #8 Native capture memory leaks | Phase 1 (architecture); Phase 2 (stress test) | Nightly CI: 1-hour recording RSS growth <100MB |
| #9 DSL parser error quality | Phase 1 (lenient + suggestions); Phase 2 (LSP) | Usability test: 5 non-devs write a story; <3 errors require external help |
| #10 Monorepo native-dep build | Phase 1 | New-contributor onboarding in <15 min on all 3 platforms |
| #11 Auto-updater signing | Phase 1 (full-replace); Phase 5 (differential) | Staging channel: v1 → v2 → v3 chain upgrade with no user intervention |
| #12 Filter-graph ordering | Phase 2 | Golden-frame PSNR test vs. reference renders |

## Sources

- Tauri GitHub Issues #11992 (externalBin notarization), #13767 & #3612 (sidecar path), Discussion #9029 (FFmpeg dyld) — [tauri-apps/tauri](https://github.com/tauri-apps/tauri/issues/11992), [Discussion #9029](https://github.com/orgs/tauri-apps/discussions/9029)
- [Tauri v2 macOS Code Signing docs](https://v2.tauri.app/distribute/sign/macos/)
- [Shipping a Production macOS App with Tauri 2.0 (DEV)](https://dev.to/0xmassi/shipping-a-production-macos-app-with-tauri-20-code-signing-notarization-and-homebrew-mc3)
- [Nonstrict: A look at ScreenCaptureKit on macOS Sonoma](https://nonstrict.eu/blog/2023/a-look-at-screencapturekit-on-macos-sonoma/)
- [9to5Mac: macOS Sequoia weekly screen recording permission prompt](https://9to5mac.com/2024/08/06/macos-sequoia-screen-recording-privacy-prompt/)
- [Apple Developer Forums: ScreenCaptureKit tag](https://developer.apple.com/forums/tags/screencapturekit)
- [Rekort: Screen Recording Black Screen Fix (Mac 2026)](https://rekort.app/blog/screen-recording-black-screen-fix)
- [DEV: Puppeteer in Rust — chromiumoxide vs Python alternative](https://dev.to/vhub_systems_ed5641f65d59/puppeteer-in-rust-chromiumoxide-and-headlesschrome-vs-the-python-alternative-4ji0)
- [Firecrawl: Browser Automation Tools 2026](https://www.firecrawl.dev/blog/browser-automation-tools-comparison)
- Flash & Hogan (1985), "The coordination of arm movements: an experimentally confirmed mathematical model" — minimum-jerk trajectory for cursor animation
- Apple: ScreenCaptureKit documentation (current)
- Microsoft: Windows.Graphics.Capture & Direct3D11CaptureFramePool documentation
- FFmpeg filter documentation — canonical ordering for `zscale`, `scale`, `overlay`, `drawtext`
- Personal/ecosystem knowledge: Tauri v2 1M-users apps (Cap, Screen Studio architecture posts), OBS project source for capture patterns

---
*Pitfalls research for: StoryCapture (Tauri v2 + native capture + FFmpeg + Rust automation + post-pro + Next.js companion)*
*Researched: 2026-04-14*
