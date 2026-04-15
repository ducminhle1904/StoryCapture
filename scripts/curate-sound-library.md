# Sound Library Curation Runbook

This is the procedure for sourcing, processing, and committing the 20 bundled
audio files that ship with StoryCapture. Run it end-to-end the first time,
then repeat per-file when replacing a sound that failed human listen-test
(Plan 02-08 Task 3).

## Why

The committed scaffolding in `assets/sound-library/` is a placeholder —
`manifest.json` and `attribution.json` contain `"PLACEHOLDER"` strings and
the audio files do not exist. The automated validation tests
(`crates/effects/tests/sound_library.rs` and
`crates/effects/tests/audio_rms_check.rs`) are the blocking gate that
prevents placeholders from shipping.

## Required tools

- `ffmpeg` 7.1 (the Phase-1 bundled sidecar works — `apps/desktop/src-tauri/binaries/ffmpeg-<triple>`).
- `ffprobe` (ships with ffmpeg).
- A browser with a good uBlock list (many free-audio sites are ad-heavy).

## 1. Source 20 files

Preference order (per D-21 — CC0 first):

1. **Pixabay** — <https://pixabay.com/sound-effects/> and <https://pixabay.com/music/> (no attribution required).
2. **Freesound** — <https://freesound.org/> (filter by licence `Creative Commons 0`).
3. **Mixkit** — <https://mixkit.co/free-sound-effects/> and <https://mixkit.co/free-stock-music/> (free-commercial-no-attribution).
4. **Zapsplat / BBC Sound Effects** — CC-BY acceptable only if attribution is wired through to the app's About screen.

The exact inventory (filenames are contract — do not rename):

**SFX (12):** `click`, `type`, `navigate`, `scroll`, `hover`, `drag`, `select`, `upload`, `success`, `error`, `transition-whoosh-1`, `transition-whoosh-2`.

**BGM (8):** `chill-1`, `chill-2`, `upbeat-1`, `upbeat-2`, `ambient-1`, `ambient-2`, `corporate-1`, `dramatic-1`.

Duration targets:

- SFX: 80–1000 ms (per-file guidance in `assets/sound-library/README.md`).
- BGM: 30 s seamless loop (play the file end-to-start with no audible gap).

## 2. Normalize each file

SFX → mono, 48 kHz, -16 LUFS:

```bash
ffmpeg -i <source.wav> \
  -ac 1 -ar 48000 \
  -af loudnorm=I=-16:LRA=11:TP=-1.5 \
  -c:a pcm_s16le \
  assets/sound-library/sfx/<name>.wav
```

BGM → stereo, 48 kHz, -16 LUFS; commit both the WAV master and the OGG:

```bash
# WAV master (keep for future re-encoding).
ffmpeg -i <source.wav> \
  -ac 2 -ar 48000 \
  -af loudnorm=I=-16:LRA=11:TP=-1.5 \
  -c:a pcm_s16le \
  assets/sound-library/bgm-master/<name>.wav

# OGG Vorbis q=5 (~160 kbps) for distribution.
ffmpeg -i assets/sound-library/bgm-master/<name>.wav \
  -c:a libvorbis -q:a 5 \
  assets/sound-library/bgm/<name>.ogg
```

## 3. Measure duration and fill manifest

For every file, read the duration:

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 <file>
```

Update `assets/sound-library/manifest.json` — replace every `"duration_ms"`,
`"license"`, `"source_url"`, `"author"` placeholder with the real value.

## 4. Fill attribution.json

For each file add one entry to `assets/sound-library/attribution.json`:

```json
{
  "id": "click",
  "category": "sfx",
  "file": "click.wav",
  "license": "CC0",
  "source_url": "https://pixabay.com/sound-effects/mouse-click-123456/",
  "author": "User Name",
  "attribution_text": null
}
```

- `license` must be exactly `"CC0"` or `"CC-BY-4.0"`.
- `source_url` must start with `https://`.
- `attribution_text` must be a non-null short string for every `CC-BY-4.0`
  entry (rendered in the app's About screen).
- No `"PLACEHOLDER"` strings must remain in `manifest.json` or
  `attribution.json`.

## 5. Validate

Run the automated gate (no files may be silent or missing):

```bash
# Baseline: every file present, no PLACEHOLDER left.
cargo test --package effects --test sound_library

# Non-silent RMS check per file (shells out to ffmpeg astats).
cargo test --package effects --test audio_rms_check
```

Both tests must be green before Task 3 (human listen-test) can begin.

## 6. Human listen-test (Plan 02-08 Task 3)

See the checkpoint section of `02-08-PLAN.md`. Play every SFX in sequence
and every BGM twice back-to-back (`ffplay -loop 2 <file>`); confirm each
file matches its semantic role, does not clip, and loops seamlessly.

## 7. Commit

```bash
git add assets/sound-library/ scripts/curate-sound-library.md
git commit -m "feat(02-08): curate bundled sound pack (12 SFX + 8 BGM)"
```
