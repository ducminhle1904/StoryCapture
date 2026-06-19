# Render benchmark fixtures (EXPORT-06)

This directory holds the reference fixture consumed by
`scripts/benchmark/render-1min.sh`.

There is no benchmark GitHub Actions workflow in the current tree. Treat this
script and fixture as local/manual benchmarking infrastructure unless a future
workflow explicitly wires it into CI or release.

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

Run this locally and keep the resulting MP4 + JSON wherever the local benchmark
caller expects them. If a future workflow is added, document its artifact source
here at the same time.

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

## Local Benchmark Semantics

The script reports FFmpeg `speed=N.Nx`, the ratio of encoded-clip time to
wall-clock time. That makes local comparisons useful even when machines differ,
but it is not currently enforced by CI. If benchmark gates are restored, add the
workflow paths, triggers, runner labels, and pass/fail thresholds here.
