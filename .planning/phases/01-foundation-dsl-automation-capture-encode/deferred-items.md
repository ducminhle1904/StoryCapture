# Deferred Items — Phase 01 Foundation

Items discovered out-of-scope for the current plan. To be folded into a
later plan or addressed by the originating plan owner.

## From 01-06 (BrowserDriver)

- ~~**Pre-existing externalBin requirement for FFmpeg sidecar binaries:**
  `apps/desktop/src-tauri/tauri.conf.json` declares
  `bundle.externalBin = ["binaries/ffmpeg"]`, which makes `cargo build -p
  storycapture` fail at the `tauri-build` step until placeholder binaries
  exist in `apps/desktop/src-tauri/binaries/ffmpeg-<triple>`. This is
  Plan 01-08's responsibility (FFmpeg static universal sidecar). Plan
  01-06 also adds `binaries/playwright-sidecar` to externalBin once the
  per-triple SEA artifacts are produced by the new
  `.github/workflows/playwright-sidecar-build.yml` matrix workflow.~~
  **RESOLVED by Plan 01-08 (commit `fb381bf`):** added
  `scripts/dev/install-sidecar-placeholders.sh` which drops host-triple
  shell stubs for both `ffmpeg-<triple>` and `playwright-sidecar-<triple>`;
  tauri.conf.json now lists both sidecars; `.gitignore` covers both
  patterns so real artifacts and dev stubs stay out of VCS. `cargo check
  -p storycapture --lib` now passes locally without any manual binary
  fetch.
- **chromiumoxide verb-coverage spike** (CONTEXT.md Open Todos): real
  shadow-DOM, iframe, network-idle behavior validation against a
  Chromium binary. Plan 01-06 ships the trait + capability routing
  scaffold; the verb sweep itself is a follow-on tracked in STATE.md.
