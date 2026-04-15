# Sound Library

Bundled sound pack for StoryCapture post-production (POST-06).

## Inventory (target: 12 SFX + 8 BGM = 20 files, < 30 MiB total)

### SFX (`sfx/*.wav` — mono, 48 kHz, 16-bit PCM, normalized to -16 LUFS)

| File | Role | Target duration |
|------|------|-----------------|
| `click.wav` | Generic click/tap (default click SFX) | 80–200 ms |
| `type.wav` | Keystroke tick (DSL `type` step) | 40–120 ms |
| `navigate.wav` | Page load / nav | 200–500 ms |
| `scroll.wav` | Scroll tick (subtle) | 80–160 ms |
| `hover.wav` | Hover tick (very subtle) | 40–100 ms |
| `drag.wav` | Drag start | 200–400 ms |
| `select.wav` | Selection confirm | 120–250 ms |
| `upload.wav` | File upload chime | 300–600 ms |
| `success.wav` | Success state (assert pass, export done) | 400–800 ms |
| `error.wav` | Error state (assert fail) | 400–800 ms |
| `transition-whoosh-1.wav` | Scene transition swoosh (short) | 500–800 ms |
| `transition-whoosh-2.wav` | Scene transition swoosh (long) | 700–1000 ms |

### BGM (`bgm/*.ogg` — stereo, 48 kHz, OGG Vorbis q5 ≈ 160 kbps, 30 s seamless loops, -16 LUFS)

| File | Mood |
|------|------|
| `chill-1.ogg` | Mellow lo-fi / chill |
| `chill-2.ogg` | Mellow alt |
| `upbeat-1.ogg` | Energetic (tutorial) |
| `upbeat-2.ogg` | Energetic alt |
| `ambient-1.ogg` | Ambient warm |
| `ambient-2.ogg` | Ambient cool |
| `corporate-1.ogg` | Corporate / product demo |
| `dramatic-1.ogg` | Cinematic rise |

Every BGM ships an accompanying WAV master under `bgm-master/<name>.wav` so
the OGG can be re-encoded without quality loss.

## Licensing

Every file is either CC0 (preferred) or CC-BY-4.0 (acceptable, attribution
required in the app's About screen). Exact licence, source URL, and author
for each file are listed in `attribution.json`.

## Curation

See `scripts/curate-sound-library.md` for the procedure to source, normalize,
and validate every file.

> **STATUS:** SCAFFOLD — the committed files are placeholders. Real audio
> must be curated by a human operator before Phase 2 ships. See
> `.planning/phases/02-cinematic-post-production-export/02-08-RESUME.md`.
