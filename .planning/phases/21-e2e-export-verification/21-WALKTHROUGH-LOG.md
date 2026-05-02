# Phase 21 — E2E Export Walkthrough Log

**Status:** PREFLIGHT RUN, OPERATOR UAT PENDING
**Prepared:** 2026-04-29
**Refreshed:** 2026-05-02
**Owner:** Operator for walkthrough; agent for triage after logs exist
**Depends on:** Phase 20 cursor overlay export-time PNG rendering. Source now
contains the cursor sidecar → PNG sequence preprocessing path; operator UAT is
still pending.

## Scope

This phase is operator-driven. No code should change before a real recording/export run surfaces a specific blocker. Keep fixes for Plan 21-02 reactive and bounded to the walkthrough findings.

## Preflight Checked By Agent

Commands were run through `rtk`.

| Check | Result |
|---|---|
| `rtk git status --short` | Historical note: original preflight saw Phase 20 cursor/export changes uncommitted. Refresh note: current `main` contains the relevant source path; rerun status before UAT for the latest local dirtiness. |
| `rtk run "node --version"` | `v24.14.1` |
| `rtk run "pnpm --version"` | `9.15.0` |
| `rtk run "rustc -vV"` | `rustc 1.88.0`, host `aarch64-apple-darwin` |
| `rtk ls -lh apps/desktop/src-tauri/binaries` | Real local sidecars present: `ffmpeg-aarch64-apple-darwin` 47.1 MB, `playwright-sidecar-aarch64-apple-darwin` 112.8 MB. |
| `rtk ls -lh crates/effects/assets/cursors` | Phase 20 cursor skin PNG assets present. |
| `rtk run "test -d node_modules; echo root_node_modules=$?"` | `root_node_modules=0` |
| `rtk run "test -d apps/desktop/node_modules; echo desktop_node_modules=$?"` | `desktop_node_modules=0` |
| `rtk pnpm -C apps/desktop typecheck` | PASS. |
| `rtk cargo test -p effects cursor -- --nocapture` | PASS: 9 cursor-focused tests passed, 220 filtered. |
| `rtk cargo test -p encoder export_run -- --nocapture` | PASS: 9 export-run-focused tests passed, 117 filtered. |
| `rtk pnpm --filter playwright-sidecar build` | PASS: SEA rebuilt/up-to-date; real sidecar present. |
| `rtk pnpm -C apps/desktop tauri:dev` | PASS after running outside sandbox: Vite started, Rust app compiled, `target/debug/storycapture` launched. Sandbox-only launch failed with `listen EPERM ::1:1420`, expected for local server bind under sandbox. |
| `curl -I http://[::1]:1420/` | PASS outside sandbox: `HTTP/1.1 200 OK`. |
| Computer Use app control | BLOCKED: macOS Apple Events returned `-1743`, so the agent could not drive the StoryCapture GUI. Full record/export walkthrough still requires a human operator. |

## Operator Preflight Commands

Run from `/Users/ducmle/Workspace/StoryCapture` unless noted.

```bash
rtk git status --short
rtk pnpm install --frozen-lockfile
rtk ls -lh apps/desktop/src-tauri/binaries
rtk ls -lh crates/effects/assets/cursors
```

Then start the app in a normal interactive terminal:

```bash
pnpm --filter @storycapture/desktop tauri:dev
```

Keep the Tauri terminal open and copy any stdout/stderr errors into this log. If Live Preview hangs at "Starting preview...", check for a placeholder sidecar signature in the app log before triage.

## Walkthrough Checklist

Use a 30-second story with 3-5 click steps on a stable public site. Capture a screenshot, browser console errors, and Tauri stdout/stderr for every failure.

| Step | Expected | Result / Evidence |
|---|---|---|
| 1. Launch `tauri:dev` | App opens without sidecar or IPC startup errors. | PARTIAL PASS: dev server and Rust app launch passed; GUI visual confirmation pending operator because agent desktop control is blocked by Apple Events `-1743`. |
| 2. Record sample story | Recording completes; source MP4 and `.trajectory.json` exist. | TODO |
| 3. Open post-production route | `/post-production/<storyId>` loads. | TODO |
| 4. Verify timeline | Timeline has 1 video clip and 1 cursor clip. | TODO |
| 5. Scrub preview | Preview canvas shows recording and responds to scrub. | TODO |
| 6. Export MP4 | Modal submits; queue shows job; render completes. | TODO |
| 7. Validate MP4 | Opens in QuickTime and VLC; duration within +/-100ms; resolution expected. | TODO |
| 8. Validate cursor overlay | Cursor is visibly rendered at trajectory positions. | TODO |
| 9. Export WebM | Render completes and output plays. | TODO |
| 10. Export GIF | Render completes and output opens. | TODO |

Optional metadata check for MP4/WebM:

```bash
apps/desktop/src-tauri/binaries/ffmpeg-aarch64-apple-darwin -hide_banner -i "<output-file>"
```

## Findings

No full operator run has been performed yet. Agent preflight found no code/build blocker before manual recording/export UAT.

| ID | Severity | Symptom | Evidence | Disposition |
|---|---|---|---|---|
| TODO | BLOCKER / WARNING / DEFERRED | TODO | TODO | TODO |

## Likely Blockers To Watch

- Phase 20 prerequisite is now present in source, but it still needs a real
  record/export UAT run before treating cursor overlay export as production
  verified.
- macOS TCC permissions may block browser automation, screen capture, or click capture. Record the denied permission and continue only if the app degrades gracefully.
- Graph JSON can still fail at runtime if a populated real graph exposes a snake_case/camelCase mismatch, numeric width issue, or relative path assumption.
- Cursor skin path resolution may differ between dev and packaged builds. Phase 21 should verify dev first; packaged behavior can be deferred if dev passes.
- FFmpeg argument/path handling may fail with spaces in project/export paths, especially on Windows. Capture the exact command/error when it happens.
- Render queue progress can desync from the actual encoder job. Treat "output exists but UI stuck" as a distinct finding.
- Phase 20 temp PNG sequence cleanup is not lifecycle-owned after a successful queued export yet. If exports pass, track this as a cleanup follow-up rather than a ship blocker.

## Deferred Recommendations

Create `21-DEFERRED.md` only after the walkthrough surfaces a real issue that is too large for the Plan 21-02 bug sweep budget.
