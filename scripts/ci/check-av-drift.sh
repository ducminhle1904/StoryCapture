#!/usr/bin/env bash
# scripts/ci/check-av-drift.sh — ENC-05 / D-26.
#
# Uses ffprobe to compare video-stream duration vs. audio-stream duration
# on an MP4; fails with exit 1 if the absolute difference exceeds
# `MAX_DRIFT_MS` (default 100 ms).
#
# Usage:
#   FFPROBE=./ffprobe bash scripts/ci/check-av-drift.sh <input.mp4>
#
# Environment:
#   FFPROBE      — path to the ffprobe binary (default: ./ffprobe)
#   MAX_DRIFT_MS — threshold in ms (default: 100 per D-26)

set -euo pipefail

FFPROBE="${FFPROBE:-./ffprobe}"
INPUT="${1:?"usage: $0 <input.mp4>"}"
MAX_DRIFT_MS="${MAX_DRIFT_MS:-100}"

if [[ ! -x "$FFPROBE" ]]; then
  echo "ERROR: ffprobe binary not found or not executable: $FFPROBE" >&2
  exit 2
fi
if [[ ! -f "$INPUT" ]]; then
  echo "ERROR: input file not found: $INPUT" >&2
  exit 2
fi

video_end_s=$("$FFPROBE" -v error -select_streams v:0 \
  -show_entries stream=duration -of csv=p=0 "$INPUT")
audio_end_s=$("$FFPROBE" -v error -select_streams a:0 \
  -show_entries stream=duration -of csv=p=0 "$INPUT")

if [[ -z "$video_end_s" || "$video_end_s" == "N/A" ]]; then
  echo "ERROR: could not read video-stream duration from $INPUT" >&2
  exit 2
fi
if [[ -z "$audio_end_s" || "$audio_end_s" == "N/A" ]]; then
  echo "ERROR: could not read audio-stream duration from $INPUT (single-stream file?)" >&2
  exit 2
fi

diff_ms=$(awk -v v="$video_end_s" -v a="$audio_end_s" '
  BEGIN { d = (v - a) * 1000; if (d < 0) d = -d; printf "%.0f\n", d }
')

echo "[check-av-drift] video_end=${video_end_s}s audio_end=${audio_end_s}s diff=${diff_ms}ms threshold=${MAX_DRIFT_MS}ms"

if [ "$diff_ms" -gt "$MAX_DRIFT_MS" ]; then
  echo "ERROR: A/V drift ${diff_ms}ms exceeds ${MAX_DRIFT_MS}ms threshold (ENC-05)"
  exit 1
fi
echo "OK: A/V drift ${diff_ms}ms within ${MAX_DRIFT_MS}ms"
