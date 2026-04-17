# e2e-playwright-capture

End-to-end smoke binary for Plan 05-02: spawns the Playwright sidecar,
resolves its Chromium pid to an SCWindow, captures 5 seconds of frames
via `SckBackend` using `CaptureTarget::WindowByPid`, and asserts frame
count + dimensions.

## Preconditions

- **macOS host** with Screen Recording TCC granted for the calling terminal
  (open *System Settings → Privacy & Security → Screen Recording* and tick
  the entry for your terminal / IDE).
- `pnpm install` ran inside `scripts/playwright-sidecar/`.
- `playwright install chromium` ran at least once (the binary is cached
  under `~/Library/Caches/ms-playwright`).
- Node 20+ on PATH.

## Usage

```bash
cargo run -p e2e-playwright-capture
```

Expected output (abridged):

```
INFO e2e-playwright-capture: start
INFO sidecar launched + navigated elapsed=1.2s
INFO Playwright Chromium pid resolved pid=45123
INFO resolved SCWindow window_id=1234 title=Some("about:blank")
INFO capture complete frame_count=148 width=2560 height=1600 …
INFO e2e-playwright-capture: SUCCESS total=6.7s
```

Exit code `0` on success, `1` on any failure.

## Out of scope

- Full MP4 encode + ffprobe assertion — the plan's MP4 acceptance criterion
  depends on the FFmpeg sidecar plumbing in `apps/desktop/src-tauri/binaries`
  which this binary does not wire. Frame-count proxy (≥120 frames over 5s)
  is used instead. A follow-up can wire the encoder crate here.
