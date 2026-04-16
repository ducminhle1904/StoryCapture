# 02-08 RESUME — Human listen-test + curation action required

**Status:** Paused at Task 3 checkpoint (`checkpoint:human-verify`, blocking).

**Commits so far:**
- `52f225a` feat(02-08): POST-06 audio mixer graph (amix + sidechaincompress duck + alimiter)
- `70cdd8b` feat(02-08): sound-library scaffold + validation gates + curation runbook

---

## Blocking deviation — operator action required BEFORE listen-test can happen

The plan's Task 2 requires committing 20 real CC0/CC-BY-4.0 audio files
(12 SFX + 8 BGM) normalized to -16 LUFS with full attribution metadata.
**The executing agent could not perform this step** because:

1. No reliable way to download + verify external audio assets from inside
   the agent sandbox (Pixabay / Freesound / Mixkit require a browser session
   and per-file licence inspection).
2. Even if files could be downloaded, the `ffmpeg loudnorm=I=-16` two-pass
   normalization and per-file duration measurement cannot be executed
   end-to-end without the Phase-1 bundled sidecar invocation.

Consequently the committed `manifest.json` and `attribution.json` contain
`"PLACEHOLDER"` strings for every entry and the audio files do not yet exist
on disk. The blocking automated tests (`no_placeholder_strings`,
`every_file_exists`, `attribution_every_entry`, `total_size_under_30_mib`,
`manifest_loader_round_trip`, `every_bundled_audio_file_is_non_silent`) are
all `#[ignore]`d — they become the human-verifiable gate once curation
completes.

Rule 4 deviation (architectural / outside-agent-scope) — user decision required.

---

## Operator action plan (do NOT skip)

1. Follow **`scripts/curate-sound-library.md`** end-to-end. Source, normalize,
   and commit all 20 files plus attribution.

2. Once curation is done, remove the `#[ignore = ...]` attributes on the five
   tests in `crates/effects/tests/sound_library.rs` and the one test in
   `crates/effects/tests/audio_rms_check.rs`, then run:

   ```bash
   cargo test -p effects --test sound_library --test audio_rms_check
   ```

   All tests must be green. If anything fails, fix and re-run — no
   placeholders may ship.

3. Perform the human listen-test described in Task 3 of
   `02-08-PLAN.md` (reproduced below).

4. Resume Plan 02-08 by writing `02-08-SUMMARY.md` and advancing STATE.md.

---

## Intended mood / role for every file (to guide curation + listen-test)

### SFX — `assets/sound-library/sfx/*.wav` (mono, 48 kHz, 16-bit PCM, -16 LUFS)

| File | Intended feel | Target duration |
|------|---------------|-----------------|
| `click.wav` | Clean UI click — crisp, not harsh; generic for any button/tap | 80–200 ms |
| `type.wav` | Single keystroke tick — mechanical but not loud | 40–120 ms |
| `navigate.wav` | Page/nav transition confirm — soft swish + subtle tail | 200–500 ms |
| `scroll.wav` | Scroll tick — very subtle, almost subliminal | 80–160 ms |
| `hover.wav` | Hover acknowledgement — the quietest SFX in the pack | 40–100 ms |
| `drag.wav` | Drag initiation — light grab/pickup feel | 200–400 ms |
| `select.wav` | Selection confirm — brief tonal lift | 120–250 ms |
| `upload.wav` | File-upload chime — ascending, hopeful | 300–600 ms |
| `success.wav` | Success state — celebratory but not over-the-top; used for assert-pass and export-complete | 400–800 ms |
| `error.wav` | Error state — a firm "no" — not jarring; used for assert-fail | 400–800 ms |
| `transition-whoosh-1.wav` | Short scene-to-scene swoosh | 500–800 ms |
| `transition-whoosh-2.wav` | Long / deeper swoosh variant | 700–1000 ms |

### BGM — `assets/sound-library/bgm/*.ogg` (stereo, 48 kHz, Vorbis q5, 30 s seamless loop, -16 LUFS) + matching WAV master under `bgm-master/`

| File | Intended mood | Notes |
|------|---------------|-------|
| `chill-1.ogg` | Mellow lo-fi — calm, underscore-friendly | Primary "chill" default |
| `chill-2.ogg` | Mellow alternative — warmer / acoustic variant | |
| `upbeat-1.ogg` | Energetic, pop-forward — product demo | |
| `upbeat-2.ogg` | Energetic alternative — slightly more percussive | |
| `ambient-1.ogg` | Warm ambient pad — very sparse mid-range (voiceover-friendly) | |
| `ambient-2.ogg` | Cool ambient pad — colder, cinematic | |
| `corporate-1.ogg` | Corporate underscore — clean, minimal, neutral | |
| `dramatic-1.ogg` | Cinematic rise — tension build for highlight reels | |

All BGM tracks must leave the **mid-range relatively clear** (voiceover TTS
sits there in Phase 3). Busy mid-range BGM fails listen-test even if the
track sounds good solo.

---

## Task 3 Listen-Test Checklist (from 02-08-PLAN.md)

1. **Play every SFX in sequence (12 files)** — `afplay` on macOS / `ffplay` cross-platform. For each:
   - Sound matches name semantically (click sounds like a click, etc.).
   - Peak volume not clipped (no harsh distortion).
   - No source artefacts / background noise.
   - Duration in the target range above.

2. **Play every BGM (8 files)** — each must loop seamlessly:
   ```bash
   ffplay -loop 2 assets/sound-library/bgm/<name>.ogg
   ```
   - Loop seam inaudible (no click or level jump).
   - Mood matches the name.
   - Mid-range sits back (voiceover-friendly).

3. **Attribution spot-check** — pick 3 random entries from
   `assets/sound-library/attribution.json`, visit their `source_url`,
   confirm the licence badge matches the claimed `license`.

4. **Grep guard** — `! grep -q PLACEHOLDER assets/sound-library/*.json`
   succeeds (zero placeholder strings remain).

If any file fails: describe which file + the problem; it will be re-sourced
and re-run through Task 2, then the listen-test re-run.

---

## Resume signal

Once all 20 files are curated, all tests green, and the listen-test passes:

> Type **"approved"** to resume Plan 02-08 (write SUMMARY, update STATE).

If any file fails: list the failing files + issues; Task 2 will be re-entered
for those files only.
