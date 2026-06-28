#!/usr/bin/env bash
# scripts/notarize/adhoc-sign.sh
# Local-dev fallback when paid Developer ID credentials aren't yet
# provisioned. Applies an *ad-hoc* (`-`) signature with --deep so every
# nested Mach-O gets a stable code-signing identity.
#
# WHY THIS MATTERS (PITFALLS.md §1)
# ---------------------------------
# macOS TCC keys Screen Recording grants on bundle-id + code-signing identity.
# An unsigned dev build can be re-signed with a new transient identity on each
# local package run, producing "ghost granted" entries: Settings shows the app
# as allowed, but the live process is still denied. An ad-hoc signature is
# stable enough to keep the same TCC entry between rebuilds.
#
# This is NOT a substitute for Developer ID notarization (Gatekeeper will
# still reject ad-hoc-signed bundles for distribution). It's purely a
# Phase-1 dev-loop affordance.
#
# Usage:
#   bash scripts/notarize/adhoc-sign.sh path/to/My.app
#   bash scripts/notarize/adhoc-sign.sh path/to/ffmpeg-aarch64-apple-darwin

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <path-to-binary-or-.app>" >&2
  exit 2
fi

TARGET="$1"
if [[ ! -e "$TARGET" ]]; then
  echo "[adhoc-sign] no such path: $TARGET" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[adhoc-sign] no-op: only meaningful on macOS" >&2
  exit 0
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "[adhoc-sign] codesign not found — install Xcode CLT" >&2
  exit 1
fi

echo "[adhoc-sign] applying ad-hoc signature to $TARGET"
codesign --force --deep --sign - "$TARGET"

echo "[adhoc-sign] verifying"
codesign --display --verbose=2 "$TARGET" 2>&1 | head -10 || true

echo "[adhoc-sign] OK — ad-hoc signed (NOT distributable; dev-only per PITFALLS §1)"
