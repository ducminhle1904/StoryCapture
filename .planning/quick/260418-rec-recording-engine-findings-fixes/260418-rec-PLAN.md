---
id: 260418-rec
title: "Recording engine findings: contract, backend routing, and debt fixes"
created: 2026-04-18
status: in_progress
mode: quick
scope: lean
files_modified:
  - apps/desktop/src/ipc/encode.ts
  - apps/desktop/src/features/recorder/recording-view.tsx
  - apps/desktop/src/features/recorder/hud.tsx
  - apps/desktop/src-tauri/src/commands/encode.rs
  - crates/capture/src/lib.rs
  - crates/capture/src/windows/helpers.rs
  - crates/capture/src/windows/wgc_backend.rs
  - crates/capture/src/windows/thumbnail.rs
  - crates/capture/src/audio/device.rs
  - crates/capture/src/audio/stream.rs
  - crates/encoder/src/config.rs
must_haves:
  truths:
    - "Recorder UI must consume the actual Tauri RecordingEvent contract instead of a stale local discriminator."
    - "Stopping a recording from the UI must deterministically transition the UI out of `stopping` on success and failure."
    - "Windows display and display-region capture must honor the selected monitor instead of always using the primary display."
    - "The recording command must go through the same native-backend orchestration path as standalone capture so fallback behavior and lifecycle events stay aligned."
    - "Recorder UI must not expose a fake pause state until pause/resume exists in the backend."
    - "Audio device enumeration must stop using deprecated cpal name-based identity and instead surface stable IDs while preserving user-facing names."
    - "FFmpeg path documentation/flags must describe the real timestamp behavior instead of claiming capture-PTS preservation."
  artifacts:
    - path: "apps/desktop/src/ipc/encode.ts"
      provides: "Typed frontend RecordingEvent union aligned to the Rust `type`-tagged kebab-case payloads."
    - path: "apps/desktop/src/features/recorder/recording-view.tsx"
      provides: "Stop-path completion handling, event dispatch compatibility, and removal of fake pause/resume interaction."
    - path: "apps/desktop/src-tauri/src/commands/encode.rs"
      provides: "Orchestrated native capture startup plus reduced extra frame buffering."
    - path: "crates/capture/src/windows/helpers.rs"
      provides: "Single DisplayId-to-WGC monitor resolver reused by streaming and thumbnail paths."
    - path: "crates/capture/src/audio/device.rs"
      provides: "Stable audio IDs from cpal device IDs with human-readable descriptions."
    - path: "crates/encoder/src/config.rs"
      provides: "FFmpeg argv/comments consistent with the actual CFR wallclock-driven stdin path."
---

<objective>
Fix the current recording-engine findings with the smallest set of concrete code changes that improves correctness immediately: event contract mismatches, stop-path UI hang, Windows monitor misrouting, capture orchestrator bypass, fake pause UI, and cpal device-ID debt. Also tighten the FFmpeg timestamp contract so the implementation and comments match.
</objective>

<verification>
  - `cargo test -p capture --lib`
  - `cargo test -p encoder --lib`
  - `cargo check -p storycapture-desktop`
  - targeted frontend test/typecheck if needed after the recorder UI changes
</verification>
