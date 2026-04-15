# Render benchmark fixtures (EXPORT-06)

This directory holds the reference fixture consumed by
`scripts/benchmark/render-1min.sh` — both the PR-level gate
(`.github/workflows/render-benchmark.yml`) and the release-tag strict
wall-clock gate (`.github/workflows/release-benchmark.yml`).

## What the fixture is

A **deterministic 1-minute 1080p60 recording** plus the JSON describing
the effect graph that turns it into a rendered export. In the current
Phase 2 state the graph loader (Plans 02-01 + 02-11) isn't wired yet, so
the benchmark script falls back to a pure transcode: the reference MP4
→ FFV1 intermediate → MP4 + WebM fan-out. Once the graph loader ships,
`1min-reference.json` will gain an `effect_graph` field and the
benchmark path switches automatically.

## `1min-reference.json`

```jsonc
{
  "source_mp4": "/absolute/path/to/1min-reference.mp4",
  "duration_ms": 60000,
  "width": 1920,
  "height": 1080,
  "fps": 60,
  "formats": ["mp4", "webm"],
  "effect_graph": null        // filled in once Plan 02-01/11 land
}
```

- The `source_mp4` path is absolute because CI steps download the fixture
  to a known temp location before invoking the benchmark.
- If `1min-reference.json` is missing (fresh clone, no CI artifact yet),
  the script generates a synthetic `testsrc2 + sine` MP4 on the fly and
  runs the same pipeline against it. This keeps the benchmark self-hosting
  and lets PRs exercise the script before the canonical fixture exists.

## Generating the canonical fixture

Run this locally (or as a one-off GitHub Actions workflow) and upload
the resulting MP4 + JSON as a long-lived artifact that the benchmark
jobs download.

```bash
ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=60:duration=60" \
       -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=60" \
       -c:v libopenh264 -b:v 8M -c:a aac -b:a 128k \
       -movflags +faststart \
       1min-reference.mp4

cat > 1min-reference.json <<JSON
{
  "source_mp4": "$(pwd)/1min-reference.mp4",
  "duration_ms": 60000,
  "width": 1920,
  "height": 1080,
  "fps": 60,
  "formats": ["mp4", "webm"],
  "effect_graph": null
}
JSON
```

`testsrc2 + sine` is chosen deliberately: it's entropy-heavy (motion +
gradient noise) so the encoder actually has work to do, yet it's fully
deterministic across runners so the benchmark result is comparable.

## Gate semantics

| Gate | Trigger | Runner | Assertion | Source of truth |
|------|---------|--------|-----------|-----------------|
| PR-level | `pull_request` | `macos-14`, `windows-latest` | `speed=N.Nx > 2.0` | `.github/workflows/render-benchmark.yml` |
| Release | `push: tags: release/*` | `[self-hosted, macos-m2pro]` | speed-factor gate **and** wall-clock `< 30000 ms` | `.github/workflows/release-benchmark.yml` |

The PR-level speed factor is hardware-independent by construction (FFmpeg
`speed=N.Nx` is the ratio of encoded-clip time to wall-clock time) so it
catches regressions without coupling the gate to a specific runner's CPU.
The release-time strict wall-clock gate is the canonical EXPORT-06
success criterion per the plan.
