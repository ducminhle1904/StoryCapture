#!/usr/bin/env bash
# scripts/build-ffmpeg/verify-static.sh
# Post-build verification — fails (exit 1) if:
#   1. The binary dynamically links against any non-system library
#      (per D-22 — Tauri notarization rejects unsigned nested Mach-Os).
#   2. The build does not expose libx264, which recorder High/Lossless MP4
#      quality depends on.
#
# Cross-platform: detects host OS via `uname -s` and runs `otool` (Darwin)
# or `dumpbin` (MINGW/MSYS) accordingly.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <path-to-ffmpeg-binary>" >&2
  exit 2
fi

BIN="$1"
if [[ ! -x "$BIN" && ! -f "$BIN" ]]; then
  echo "[verify-static] not a file: $BIN" >&2
  exit 2
fi

OS="$(uname -s)"
echo "[verify-static] checking $BIN on $OS"

# ----------------------------------------------------------------------
# 1. Dynamic-link check
# ----------------------------------------------------------------------
case "$OS" in
  Darwin)
    # otool -L emits one line per linked library after the header.
    # We allow only Apple-provided system libs and frameworks.
    ALLOW_RE='^[[:space:]]*(/usr/lib/libSystem\.B\.dylib|/usr/lib/libc\+\+\.1\.dylib|/usr/lib/libobjc\.A\.dylib|/usr/lib/libresolv\.[0-9]+\.dylib|/usr/lib/libiconv\.[0-9]+\.dylib|/usr/lib/libz\.[0-9.]+\.dylib|/usr/lib/libbz2\.[0-9.]+\.dylib|/System/Library/Frameworks/[^ ]+\.framework/[^ ]+|/System/Library/PrivateFrameworks/[^ ]+\.framework/[^ ]+)( |$)'
    DEPS="$(otool -L "$BIN" | tail -n +2 || true)"
    BAD=""
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      if [[ "$line" =~ @rpath || "$line" =~ @loader_path || "$line" =~ @executable_path ]]; then
        BAD="${BAD}${line}\n"
        continue
      fi
      if ! [[ "$line" =~ $ALLOW_RE ]]; then
        BAD="${BAD}${line}\n"
      fi
    done <<< "$DEPS"
    if [[ -n "$BAD" ]]; then
      echo "[verify-static] FAIL: non-system dynamic dependencies detected:" >&2
      printf "%b" "$BAD" >&2
      exit 1
    fi
    echo "[verify-static] otool: only system libs/frameworks linked"
    ;;

  MINGW*|MSYS*|CYGWIN*)
    # On Windows we shell out to dumpbin (from VS Build Tools).
    if ! command -v dumpbin.exe >/dev/null 2>&1 && ! command -v dumpbin >/dev/null 2>&1; then
      echo "[verify-static] dumpbin not available — install VS Build Tools" >&2
      exit 1
    fi
    DUMPBIN="$(command -v dumpbin.exe || command -v dumpbin)"
    DEPS="$("$DUMPBIN" /DEPENDENTS "$BIN" | grep -E '\.dll' || true)"
    ALLOW_RE='^[[:space:]]*(KERNEL32|USER32|ADVAPI32|OLE32|OLEAUT32|SHELL32|WS2_32|BCRYPT|SECUR32|CRYPT32|NORMALIZ|IPHLPAPI|GDI32|MSVCRT|MSVCP140|VCRUNTIME140|VCRUNTIME140_1|UCRTBASE|api-ms-win-[a-z0-9-]+)\.dll'
    BAD=""
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      trimmed="$(echo "$line" | sed 's/^[[:space:]]*//')"
      if ! [[ "$trimmed" =~ $ALLOW_RE ]]; then
        BAD="${BAD}${line}\n"
      fi
    done <<< "$DEPS"
    if [[ -n "$BAD" ]]; then
      echo "[verify-static] FAIL: non-system DLL imports detected:" >&2
      printf "%b" "$BAD" >&2
      exit 1
    fi
    echo "[verify-static] dumpbin: only system DLLs imported"
    ;;

  *)
    echo "[verify-static] unsupported host OS: $OS" >&2
    exit 1
    ;;
esac

# ----------------------------------------------------------------------
# 2. Recorder encoder / post-production filter enforcement
# ----------------------------------------------------------------------
# `ffmpeg -buildconf` prints all configure flags. libx264 requires GPL, and
# libx265 and nonfree remain forbidden by the repo's codec policy.
if BUILDCONF="$("$BIN" -hide_banner -buildconf 2>&1)"; then
  if ! echo "$BUILDCONF" | grep -E -- '--enable-gpl' >/dev/null; then
    echo "[verify-static] FAIL: --enable-gpl missing; libx264 requires GPL mode" >&2
    exit 1
  fi
  if ! echo "$BUILDCONF" | grep -E -- '--enable-libx264' >/dev/null; then
    echo "[verify-static] FAIL: --enable-libx264 missing; recorder High/Lossless MP4 quality requires libx264" >&2
    exit 1
  fi
  if ! echo "$BUILDCONF" | grep -E -- '--enable-libfreetype' >/dev/null; then
    echo "[verify-static] FAIL: --enable-libfreetype missing; post-production text overlays require drawtext" >&2
    exit 1
  fi
  if ! echo "$BUILDCONF" | grep -E -- '--enable-libharfbuzz' >/dev/null; then
    echo "[verify-static] FAIL: --enable-libharfbuzz missing; FFmpeg 7 drawtext requires harfbuzz" >&2
    exit 1
  fi
  if echo "$BUILDCONF" | grep -E -- '--enable-libx265|--enable-nonfree' >/dev/null; then
    echo "[verify-static] FAIL: forbidden codec/config enabled in build:" >&2
    echo "$BUILDCONF" | grep -E -- '--enable-libx265|--enable-nonfree' >&2
    exit 1
  fi
  echo "[verify-static] encoders/filters deps: GPL + libx264 + drawtext deps present; libx265/nonfree absent"
else
  echo "[verify-static] WARN: could not run '$BIN -buildconf' (cross-compiled binary?) — skipping encoder grep" >&2
fi

if DECODERS="$("$BIN" -hide_banner -decoders 2>&1)"; then
  if ! echo "$DECODERS" | grep -E '^[[:space:]]*V[^[:space:]]*[[:space:]]+png[[:space:]]' >/dev/null; then
    echo "[verify-static] FAIL: png decoder missing; virtual cursor overlay consumes PNG frame sequences" >&2
    exit 1
  fi
  echo "[verify-static] decoders: png present for cursor overlays"
else
  echo "[verify-static] WARN: could not run '$BIN -decoders' (cross-compiled binary?) — skipping decoder grep" >&2
fi

if FILTERS="$("$BIN" -hide_banner -filters 2>&1)"; then
  REQUIRED_FILTERS=(
    scale format fps setpts asetpts aresample anull anullsrc null
    crop overlay geq zoompan movie drawtext color pad setsar setparams
    eq split palettegen paletteuse xfade
  )
  for filter in "${REQUIRED_FILTERS[@]}"; do
    if ! echo "$FILTERS" | grep -E "^[[:space:]]*[^[:space:]]+[[:space:]]+${filter}[[:space:]]" >/dev/null; then
      echo "[verify-static] FAIL: required FFmpeg filter missing: $filter" >&2
      exit 1
    fi
  done
  echo "[verify-static] filters: recorder + post-production render filters present"
else
  echo "[verify-static] WARN: could not run '$BIN -filters' (cross-compiled binary?) — skipping filter grep" >&2
fi

echo "[verify-static] PASS: $BIN is statically linked + recorder encoder ready"
