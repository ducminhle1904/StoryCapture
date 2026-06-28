#!/usr/bin/env bash
# scripts/release/verify-installer-size.sh
#
# Enforce the installer-size budget of 50 MB, excluding the bundled FFmpeg
# runtime. The residual app must stay lean.
#
# Supported formats: macOS .dmg, Windows NSIS .exe and .msi.
#
# Modes:
#   default       → advisory; warn if residual > 50 MB, hard-fail only > 60 MB
#   --strict      → fail on residual > 50 MB (PR-gate on main / release CI)
#
# Exit codes:
#   0  OK (or warn only, default mode)
#   1  budget failure
#   2  structural / usage error
#
# Usage:
#   scripts/release/verify-installer-size.sh <installer> [--strict]
set -euo pipefail

INSTALLER="${1:-}"
STRICT="${2:-}"

if [[ -z "$INSTALLER" ]]; then
  echo "usage: $0 <installer-path> [--strict]" >&2
  exit 2
fi
if [[ ! -f "$INSTALLER" ]]; then
  echo "error: installer not found: $INSTALLER" >&2
  exit 2
fi

BUDGET_MB=50
HARD_FAIL_MB=60

TMP=$(mktemp -d)
cleanup() {
  # Detach any lingering mount (macOS) before cleaning TMP.
  if [[ -d "$TMP/mnt" ]]; then
    hdiutil detach "$TMP/mnt" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

sum_sizes() {
  # $1: root dir, $2..: find -name patterns (each prefixed -name)
  local root="$1"; shift
  local acc=0
  while (( $# > 0 )); do
    local pattern="$1"; shift
    while IFS= read -r -d '' f; do
      sz=$(wc -c <"$f" | tr -d ' ')
      acc=$(( acc + sz ))
    done < <(find "$root" -type f -name "$pattern" -print0)
  done
  echo "$acc"
}

tree_size() {
  # Total size in bytes of a directory tree (portable).
  local root="$1"
  local acc=0
  while IFS= read -r -d '' f; do
    sz=$(wc -c <"$f" | tr -d ' ')
    acc=$(( acc + sz ))
  done < <(find "$root" -type f -print0)
  echo "$acc"
}

case "$INSTALLER" in
  *.dmg)
    mkdir -p "$TMP/mnt"
    hdiutil attach -nobrowse -mountpoint "$TMP/mnt" "$INSTALLER" >/dev/null
    APP_DIR=$(find "$TMP/mnt" -maxdepth 3 -name "*.app" -type d | head -1)
    if [[ -z "$APP_DIR" ]]; then
      hdiutil detach "$TMP/mnt" >/dev/null 2>&1 || true
      echo "error: no .app found inside $INSTALLER" >&2
      exit 2
    fi
    total_bytes=$(tree_size "$APP_DIR")
    ffmpeg_bytes=$(sum_sizes "$APP_DIR" "ffmpeg" "ffmpeg-*" "ffprobe" "ffprobe-*")
    hdiutil detach "$TMP/mnt" >/dev/null 2>&1 || true
    ;;
  *.exe|*.msi)
    mkdir -p "$TMP/ex"
    if ! command -v 7z >/dev/null 2>&1; then
      echo "error: 7z is required to inspect $INSTALLER (install p7zip-full or 7-Zip)" >&2
      exit 2
    fi
    7z x -y "-o$TMP/ex" "$INSTALLER" >/dev/null
    total_bytes=$(tree_size "$TMP/ex")
    ffmpeg_bytes=$(sum_sizes "$TMP/ex" "ffmpeg.exe" "ffmpeg-*.exe" "ffmpeg" "ffmpeg-*" "ffprobe.exe" "ffprobe-*.exe")
    ;;
  *)
    echo "error: unsupported installer format: $INSTALLER" >&2
    exit 2
    ;;
esac

ffmpeg_bytes=${ffmpeg_bytes:-0}
residual=$(( total_bytes - ffmpeg_bytes ))
residual_mb=$(( residual / 1024 / 1024 ))
total_mb=$(( total_bytes / 1024 / 1024 ))
ffmpeg_mb=$(( ffmpeg_bytes / 1024 / 1024 ))

echo "Installer:    $INSTALLER"
echo "Total:        ${total_mb} MB"
echo "FFmpeg:       ${ffmpeg_mb} MB (excluded from budget)"
echo "App residual: ${residual_mb} MB  (budget ${BUDGET_MB} MB, hard-fail ${HARD_FAIL_MB} MB)"

if (( residual_mb > HARD_FAIL_MB )); then
  echo "HARD FAIL: residual ${residual_mb} MB > ${HARD_FAIL_MB} MB" >&2
  exit 1
fi
if (( residual_mb > BUDGET_MB )); then
  if [[ "$STRICT" == "--strict" ]]; then
    echo "STRICT FAIL: residual ${residual_mb} MB > ${BUDGET_MB} MB budget" >&2
    exit 1
  fi
  echo "WARN: residual ${residual_mb} MB exceeds ${BUDGET_MB} MB budget (advisory)"
  exit 0
fi
echo "OK"
