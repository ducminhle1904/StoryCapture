#!/usr/bin/env bash
# EXPORT-06 render benchmark (Plan 02-10 Task 3).
#
# Two modes, sharing one script:
#   - PR gate  (default): assert `speed=N.Nx` from FFmpeg `-progress` is
#                         above 2.0× on any runner. Hardware-independent.
#   - Release gate       : set STRICT_WALL_CLOCK=1 to additionally enforce
#                          wall-clock < 30 s/min on the reference self-
#                          hosted macOS M2 Pro runner (self-hosted only).
#
# Both numbers are always emitted to GITHUB_STEP_SUMMARY as informational
# metadata so drift is visible regardless of which gate is active.
set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures" && pwd)"
OUT_DIR="$(mktemp -d)"
PROGRESS_LOG="$OUT_DIR/ffmpeg-progress.log"
STRICT_WALL_CLOCK="${STRICT_WALL_CLOCK:-0}"

# ----- Fixture + FFmpeg discovery ------------------------------------------

FIXTURE_JSON="${FIXTURE_JSON:-$FIXTURE_DIR/1min-reference.json}"
if [ ! -f "$FIXTURE_JSON" ]; then
    echo "warn: benchmark fixture missing at $FIXTURE_JSON — generating synthetic testsrc2 fallback" >&2
    # Fall-back: generate a synthetic testsrc2 + sine 1-minute 1080p60 MP4
    # so the script still exits usefully on a fresh clone / CI cold run.
    FIXTURE_MP4="$OUT_DIR/synthetic-1min.mp4"
    ffmpeg -y -hide_banner -nostdin \
        -f lavfi -i "testsrc2=size=1920x1080:rate=60:duration=60" \
        -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=60" \
        -c:v libopenh264 -b:v 8M -c:a aac -b:a 128k \
        -movflags +faststart \
        "$FIXTURE_MP4"
    FIXTURE_SOURCE="$FIXTURE_MP4"
else
    FIXTURE_SOURCE="$(jq -r .source_mp4 "$FIXTURE_JSON")"
fi

# ----- Run the benchmark ---------------------------------------------------

# Today the CI benchmark is a straight transcode (FFV1 intermediate →
# MP4 + WebM fan-out); once Plan 02-01/11 ship the effect graph loader
# the reference fixture switches to a full story render. Keep the outer
# contract identical (speed=N.Nx + wall-clock metrics).

START_MS=$(( $(date +%s%N) / 1000000 ))

# FFV1 intermediate
INTERM="$OUT_DIR/interm.mkv"
ffmpeg -y -hide_banner -nostdin \
    -i "$FIXTURE_SOURCE" \
    -c:v ffv1 -level 3 -coder 1 -context 1 -g 1 -slicecrc 1 -slices 24 -pix_fmt yuv420p \
    -c:a pcm_s16le \
    -progress "$PROGRESS_LOG" \
    "$INTERM"

# Fan-out: MP4 + WebM in parallel.
OUT_MP4="$OUT_DIR/out.mp4"
OUT_WEBM="$OUT_DIR/out.webm"
ffmpeg -y -hide_banner -nostdin \
    -i "$INTERM" -c:v libopenh264 -b:v 8M -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart \
    -progress "$PROGRESS_LOG" \
    "$OUT_MP4" &
MP4_PID=$!
ffmpeg -y -hide_banner -nostdin \
    -i "$INTERM" -c:v libvpx-vp9 -b:v 5M -c:a libopus -b:a 128k \
    "$OUT_WEBM" &
WEBM_PID=$!
wait $MP4_PID
wait $WEBM_PID

END_MS=$(( $(date +%s%N) / 1000000 ))
ELAPSED=$(( END_MS - START_MS ))

# ----- Parse speed factor --------------------------------------------------

SPEED=$(grep '^speed=' "$PROGRESS_LOG" | tail -n1 | sed -E 's/speed= *([0-9.]+).*/\1/' || echo "0")
if [ -z "$SPEED" ]; then SPEED="0"; fi

echo "render_time_ms=$ELAPSED"
echo "encode_speed_factor=$SPEED"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
        echo "### EXPORT-06 Benchmark"
        echo "| Metric | Value |"
        echo "| --- | --- |"
        echo "| Wall clock (ms) | $ELAPSED |"
        echo "| Encode speed factor | ${SPEED}x |"
        echo "| Strict wall-clock gate | $STRICT_WALL_CLOCK |"
    } >> "$GITHUB_STEP_SUMMARY"
fi

# ----- PR-level gate: speed > 2.0x ----------------------------------------

if awk -v s="$SPEED" 'BEGIN { exit (s+0 > 2.0) ? 0 : 1 }'; then
    echo "OK: encode speed ${SPEED}x > 2.0x"
else
    echo "FAIL: encode speed ${SPEED}x <= 2.0x (EXPORT-06 PR gate)" >&2
    exit 1
fi

# ----- Release-only: strict wall-clock gate -------------------------------

if [ "$STRICT_WALL_CLOCK" = "1" ]; then
    if [ "$ELAPSED" -gt 30000 ]; then
        echo "FAIL: render took ${ELAPSED}ms (budget 30000ms on reference HW)" >&2
        exit 1
    fi
    echo "OK: wall clock ${ELAPSED}ms < 30000ms (reference HW)"
fi

echo "OK"
