#!/usr/bin/env bash
# scripts/ci/generate-synthetic-recording.sh — produce a 10-minute MP4
# with both video + audio streams so `check-av-drift.sh` (ENC-05 / D-26)
# has something to probe.
#
# The encoder crate's real production pipeline writes MP4/H.264 via
# libopenh264 (LGPL software fallback) on CI runners. `testsrc2` is an
# FFmpeg filter that emits a moving timecode/pattern — mimics "varying
# screen content" without needing a real capture source.
#
# Usage:
#   FFMPEG=./ffmpeg bash scripts/ci/generate-synthetic-recording.sh [output.mp4]
#
# Environment:
#   FFMPEG     — path to the ffmpeg binary (default: ./ffmpeg)
#   DURATION_S — synthetic duration in seconds (default: 600 = 10 min)

set -euo pipefail

FFMPEG="${FFMPEG:-./ffmpeg}"
OUT="${1:-synthetic.mp4}"
DURATION_S="${DURATION_S:-600}"

if [[ ! -x "$FFMPEG" ]]; then
  echo "ERROR: ffmpeg binary not found or not executable: $FFMPEG" >&2
  exit 1
fi

echo "[generate-synthetic] ffmpeg=$FFMPEG out=$OUT duration=${DURATION_S}s"

"$FFMPEG" -hide_banner -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=60" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -c:v libopenh264 -b:v 4M -profile:v baseline -level 4.1 \
  -pix_fmt yuv420p \
  -c:a aac -b:a 64k \
  -t "$DURATION_S" \
  -vsync vfr \
  -movflags +faststart \
  -shortest \
  "$OUT"

echo "[generate-synthetic] wrote $OUT ($(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT") bytes)"
