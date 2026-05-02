# Manual Test Script — Windows Real-Capture E2E

**Plan:** 06-04 (D-23 operator-runbook fallback)
**Related workflow:** `.github/workflows/capture-windows-e2e.yml`
**Related test:** `crates/capture/tests/windows_real_capture_e2e.rs`

**When to run:**

1. **No self-hosted graphical Windows runner is available**, so the CI workflow
   above is dormant — this script IS the phase-verification evidence (D-23).
2. Pre-release smoke before tagging an `storycapture-desktop` Windows build.
3. A regression-suspect bug needs operator eyes on — CI may be green but a
   specific user-reported shape only reproduces on a real desktop.

**Host requirements:**

- Windows 10 ≥ 22H2 or Windows 11 x64, admin-capable shell (PowerShell 7 or
  an elevated `pwsh`).
- Node 20+, Rust stable (via `rustup`), `pnpm` 9.x, Git.
- ~5 GB free disk (target/, Playwright browser caches).
- A logged-in graphical session. RDP sessions work as long as the console is
  active; in a VM, prefer the host's built-in console over SSH.

## Setup (one-time)

1. `git clone https://github.com/<org>/StoryCapture.git && cd StoryCapture`
2. `pnpm install --frozen-lockfile`
3. `npx playwright install chromium`
4. `cargo build -p capture --features real-capture-windows --tests`
   (confirms the feature and test scaffolding compile end-to-end before you
   reach into the ignored tests.)
5. Verify `ffmpeg` and `ffprobe` are on `PATH`:
   `ffmpeg -hide_banner -version` and `ffprobe -hide_banner -version`.
   If not, install via `winget install ffmpeg` or point `PATH` at the bundled
   sidecar under `src-tauri/binaries/`.

## Happy Path 1 — Display Capture (primary monitor)

6. In a graphical session, run:

   ```pwsh
   cargo test -p capture --features real-capture-windows `
     -- --ignored --test-threads=1 --nocapture `
     windows_e2e_display_happy_path
   ```

   **Expected:** test passes within 60s. An MP4 lands under
   `target\debug\deps\storycapture-e2e-display-<pid>.mp4` (cargo's per-test
   `CARGO_TARGET_TMPDIR`). `ffprobe` duration prints inline in the test
   output and must be in the range **2.7 – 3.3 s** (±10% of 3s).

7. Capture evidence:

   ```pwsh
   ffprobe -hide_banner target\debug\deps\storycapture-e2e-display-*.mp4 2>&1 | Tee-Object display-ffprobe.txt
   ```

## Happy Path 2 — Window Capture (Chromium via Playwright auto-follow)

8. Launch the Playwright sidecar in a second terminal and note its Chromium
   pid (it is printed on stdout):

   ```pwsh
   node scripts\playwright-sidecar\server.mjs --preset chromium
   # look for a line: PID=<n>
   ```

9. In your test terminal, export the pid and run the window test:

   ```pwsh
   $env:STORYCAPTURE_TEST_CHROMIUM_PID = "<pid from step 8>"
   cargo test -p capture --features real-capture-windows `
     -- --ignored --test-threads=1 --nocapture `
     windows_e2e_window_happy_path
   ```

   **Expected:** the test resolves Chromium's HWND by pid within 1s, captures
   its window for 3s (not the desktop, not StoryCapture's own UI), encodes an
   MP4, and `ffprobe` reports duration in **2.7 – 3.3 s**.

10. Capture evidence:

    ```pwsh
    ffprobe -hide_banner target\debug\deps\storycapture-e2e-window-*.mp4 2>&1 | Tee-Object window-ffprobe.txt
    ```

11. Stop the Playwright sidecar (Ctrl+C in its terminal).

## UI Walkthrough (optional — supplements the test harness)

12. From the repo root: `pnpm --filter @storycapture/desktop tauri dev`.
    Wait for the Tauri window to appear.

13. Navigate to the Recorder view. In the Target dropdown, select the display
    where Chromium should launch. Toggle **Include cursor** on. Click
    **Start recording**.

14. Interact with the Chromium window for ~5s (type in the URL bar,
    scroll). Click **Stop recording**.

15. Play the resulting MP4 in the Library view. Verify visually:
    - Contains the Chromium window on the selected display.
    - Does NOT show StoryCapture's own UI chrome.
    - Does NOT show the desktop behind the window.
    - Cursor is visible when hovering inside the window.

16. Repeat with Target = **Primary display**; confirm full-desktop capture.

## Recording Evidence (attach to `06-04-SUMMARY.md`)

- Paste both `display-ffprobe.txt` and `window-ffprobe.txt` contents into
  the SUMMARY under a `### Manual-runbook evidence` section.
- If the MP4 files are <10 MB each, attach them to the SUMMARY (or link to
  an internal artifact store); otherwise note file sizes + local paths.
- Record the host profile:

  ```pwsh
  systeminfo | Select-String "OS Name","OS Version","System Type"
  rustc --version
  node --version
  ```

  Paste output into the SUMMARY.

## Known Issues / Escalation

- **`windows_e2e_window_happy_path` fails to find the Chromium window** —
  Phase 5.3's `title_hint` logic may be regressed. Cross-check against
  `.planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/05-03-SUMMARY.md`
  and open an issue tagging `wgc` + `phase-6`.
- **MP4 has duration 0 or is empty** — WGC frame delivery is broken. Collect
  full stderr (`--nocapture` output) and file against
  `crates/capture/src/windows/wgc_backend.rs`.
- **ffprobe duration outside 2.7–3.3 s** but within ±20% — flag as a
  performance regression, not a blocker. Capture CPU util during the 3s
  window via `Get-Counter '\Process(*)\% Processor Time'` and attach.
- **Test compiles but hangs** — usually a missing graphical session (running
  via SSH without an RDP console). Re-run from the console UI.
- **Native-texture fallback triggered** — the test will log `NOTE: backend
  emitted native D3D textures (N frames); synthesising testsrc MP4`. This
  means the BGRA bytes are zero-copy in a D3D11 texture; the ffprobe
  assertion still validates the CI artifact path, but real-encode
  verification comes from steps 12–16. This is expected on most Win11 setups.

## Runner-provisioning reminder (T-06-22 / T-06-27)

If you later promote this host into a self-hosted runner, before registering:

- Use a dedicated VM, not your daily driver.
- Disable inbound RDP unless actively debugging.
- Restart the runner ephemerally between dispatched runs (`actions-runner`
  service restart) to clear user-mode state.
- NEVER add repo secrets referenced by this workflow. If a future change
  needs one, reconsider — write-access users can dispatch the workflow.
