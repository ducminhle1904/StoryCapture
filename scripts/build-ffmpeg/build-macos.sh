#!/usr/bin/env bash
# scripts/build-ffmpeg/build-macos.sh
# Build a single-arch, fully static FFmpeg 7.x binary for macOS.
# Recorder High/Lossless MP4 output requires libx264 CRF mode, so this build
# enables GPL + libx264 alongside VideoToolbox/AudioToolbox.
#
# Tauri externalBin requires PER-TRIPLE files (NOT a fat lipo binary), so this
# script produces ONE arch at a time. Run twice — once with `aarch64`, once
# with `x86_64` — and Tauri will pick the right one at bundle time.
#
# Usage:
#   bash scripts/build-ffmpeg/build-macos.sh aarch64
#   bash scripts/build-ffmpeg/build-macos.sh x86_64
#
# Output:
#   out/ffmpeg-aarch64-apple-darwin   (or x86_64-apple-darwin)
#   out/ffprobe-aarch64-apple-darwin
#
# Requirements: Xcode CLT, pkg-config, nasm, yasm. Apple-Silicon host required
# for arm64 builds (we avoid QEMU); x86_64 builds work on either host via the
# native -arch flag.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
BUILD_DIR="$SCRIPT_DIR/build"
CACHE_DIR="$SCRIPT_DIR/cache"

FFMPEG_VERSION="${FFMPEG_VERSION:-7.0.2}"
FFMPEG_TARBALL="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_TARBALL}"
SHA_FILE="$SCRIPT_DIR/ffmpeg-${FFMPEG_VERSION}.sha256"

# --- arg parsing ---------------------------------------------------------
if [[ $# -lt 1 ]]; then
  echo "usage: $0 <aarch64|x86_64>" >&2
  exit 2
fi
ARCH="$1"
case "$ARCH" in
  aarch64)
    ARCH_FLAG="arm64"
    RUST_TRIPLE="aarch64-apple-darwin"
    ;;
  x86_64)
    ARCH_FLAG="x86_64"
    RUST_TRIPLE="x86_64-apple-darwin"
    ;;
  *)
    echo "[build-macos] unknown arch '$ARCH' — expected aarch64 or x86_64" >&2
    exit 2
    ;;
esac

# --- host checks ---------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build-macos] must run on macOS host (uname -s != Darwin)" >&2
  exit 1
fi

HOST_ARCH="$(uname -m)"
if [[ "$ARCH" == "aarch64" && "$HOST_ARCH" != "arm64" ]]; then
  echo "[build-macos] arm64 build requires arm64 host (got $HOST_ARCH); cross from x86_64 not supported (avoids QEMU)" >&2
  exit 1
fi

for dep in nasm yasm pkg-config make curl shasum; do
  command -v "$dep" >/dev/null 2>&1 || {
    echo "[build-macos] missing required tool: $dep" >&2
    exit 1
  }
done

# --- prepare directories -------------------------------------------------
mkdir -p "$OUT_DIR" "$BUILD_DIR" "$CACHE_DIR"

# --- fetch + verify source ----------------------------------------------
TARBALL_PATH="$CACHE_DIR/$FFMPEG_TARBALL"
if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "[build-macos] downloading $FFMPEG_URL"
  curl -fL --retry 3 -o "$TARBALL_PATH" "$FFMPEG_URL"
fi

if [[ -f "$SHA_FILE" ]]; then
  echo "[build-macos] verifying SHA256 against $SHA_FILE"
  EXPECTED_SHA="$(awk '{print $1}' "$SHA_FILE")"
  ACTUAL_SHA="$(shasum -a 256 "$TARBALL_PATH" | awk '{print $1}')"
  if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
    # If the pinned hash is a placeholder ("REPLACE_ME" or zeros), warn loudly
    # but allow continuation in CI bootstrap mode.
    if [[ "${FFMPEG_ALLOW_SHA_BOOTSTRAP:-0}" == "1" ]]; then
      echo "[build-macos] WARNING: SHA mismatch but FFMPEG_ALLOW_SHA_BOOTSTRAP=1 — recording actual SHA"
      echo "$ACTUAL_SHA  $FFMPEG_TARBALL" > "$SHA_FILE"
    else
      echo "[build-macos] SHA256 mismatch! expected=$EXPECTED_SHA actual=$ACTUAL_SHA" >&2
      echo "[build-macos] If pinning a fresh tarball, re-run with FFMPEG_ALLOW_SHA_BOOTSTRAP=1." >&2
      exit 1
    fi
  fi
else
  echo "[build-macos] no SHA file at $SHA_FILE — refusing to build untrusted source" >&2
  exit 1
fi

# --- extract -------------------------------------------------------------
SRC_DIR="$BUILD_DIR/ffmpeg-${FFMPEG_VERSION}-${ARCH}"
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
echo "[build-macos] extracting to $SRC_DIR"
tar -xJf "$TARBALL_PATH" -C "$BUILD_DIR"
mv "$BUILD_DIR/ffmpeg-${FFMPEG_VERSION}" "$SRC_DIR.tmp"
rm -rf "$SRC_DIR"
mv "$SRC_DIR.tmp" "$SRC_DIR"

PREFIX="$OUT_DIR/${ARCH}"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"

# --- configure -----------------------------------------------------------
# Static recorder build:
#   * GPL + libx264 for quality-first MP4 recording
#   * optional libopenh264 as an LGPL software fallback when present
#   * VideoToolbox + AudioToolbox for hardware encode/decode
#   * Static + small + no network/autodetect for tight bundle and predictable surface
cd "$SRC_DIR"

STATIC_PC_DIR="$BUILD_DIR/pkgconfig-static-${ARCH}"
rm -rf "$STATIC_PC_DIR"
mkdir -p "$STATIC_PC_DIR"

if ! pkg-config --exists x264 2>/dev/null; then
  echo "[build-macos] x264 pkg-config metadata missing; install x264 first" >&2
  exit 1
fi
X264_PREFIX="$(pkg-config --variable=prefix x264)"
X264_LIBDIR="$(pkg-config --variable=libdir x264)"
X264_INCLUDEDIR="$(pkg-config --variable=includedir x264)"
X264_VERSION="$(pkg-config --modversion x264)"
X264_STATIC_LIB="$X264_LIBDIR/libx264.a"
if [[ ! -f "$X264_STATIC_LIB" ]]; then
  echo "[build-macos] x264 static archive missing: $X264_STATIC_LIB" >&2
  exit 1
fi
cat > "$STATIC_PC_DIR/x264.pc" <<EOF
prefix=$X264_PREFIX
libdir=$X264_LIBDIR
includedir=$X264_INCLUDEDIR

Name: x264
Description: H.264 (MPEG4 AVC) encoder library
Version: $X264_VERSION
Libs: $X264_STATIC_LIB
Libs.private: -lpthread -lm -ldl
Cflags: -I$X264_INCLUDEDIR
EOF
export PKG_CONFIG_PATH="$STATIC_PC_DIR${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

# libopenh264 is enabled only when a static archive is present. Homebrew ships
# dylib-only openh264 on some hosts; linking that would create an unsigned
# nested dependency, so skip it rather than weakening sidecar portability.
OPENH264_FLAGS=""
if pkg-config --exists openh264 2>/dev/null; then
  OPENH264_LIBDIR="$(pkg-config --variable=libdir openh264)"
  if [[ -f "$OPENH264_LIBDIR/libopenh264.a" ]]; then
    OPENH264_FLAGS="--enable-libopenh264"
    echo "[build-macos] static libopenh264 detected — enabling LGPL software H.264 fallback"
  else
    echo "[build-macos] libopenh264 detected but no static archive at $OPENH264_LIBDIR/libopenh264.a — skipping"
  fi
else
  echo "[build-macos] libopenh264 NOT detected on host — building without"
fi

CONFIGURE_FLAGS=(
  --prefix="$PREFIX"
  --enable-static
  --disable-shared
  --pkg-config-flags=--static
  --enable-gpl
  --enable-libx264
  --disable-nonfree
  --disable-debug
  --disable-doc
  --disable-ffplay
  --disable-network
  --disable-autodetect
  --enable-small
  --enable-videotoolbox
  --enable-audiotoolbox
  --enable-encoder=libx264,h264_videotoolbox,hevc_videotoolbox,aac,pcm_s16le
  --enable-decoder=h264,hevc,aac,pcm_s16le,rawvideo
  --enable-parser=h264,hevc,aac
  --enable-muxer=mp4,mov,matroska,null
  --enable-demuxer=mov,matroska,rawvideo,aac
  --enable-protocol=file,pipe
  --enable-filter=scale,format,fps,setpts,asetpts,aresample,anull,null
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb
  --extra-cflags="-mmacosx-version-min=11.0 -arch ${ARCH_FLAG}"
  --extra-ldflags="-mmacosx-version-min=11.0 -arch ${ARCH_FLAG}"
)

if [[ -n "$OPENH264_FLAGS" ]]; then
  CONFIGURE_FLAGS+=("$OPENH264_FLAGS")
fi

# Cross-arch (host arm64 -> target x86_64) needs --arch + --target-os
if [[ "$ARCH_FLAG" != "$HOST_ARCH" && "$HOST_ARCH" == "arm64" && "$ARCH_FLAG" == "x86_64" ]]; then
  CONFIGURE_FLAGS+=(--arch=x86_64 --target-os=darwin --enable-cross-compile)
fi

echo "[build-macos] configuring (arch=$ARCH_FLAG)"
./configure "${CONFIGURE_FLAGS[@]}"

# --- build ---------------------------------------------------------------
JOBS="$(sysctl -n hw.ncpu)"
echo "[build-macos] building with $JOBS jobs"
make -j"$JOBS"
make install

# --- emit per-triple binaries -------------------------------------------
cp "$PREFIX/bin/ffmpeg"  "$OUT_DIR/ffmpeg-${RUST_TRIPLE}"
cp "$PREFIX/bin/ffprobe" "$OUT_DIR/ffprobe-${RUST_TRIPLE}"

# --- verify static + recorder encoder contract ---------------------------
"$SCRIPT_DIR/verify-static.sh" "$OUT_DIR/ffmpeg-${RUST_TRIPLE}"

SIZE_BYTES="$(stat -f %z "$OUT_DIR/ffmpeg-${RUST_TRIPLE}")"
SIZE_MB=$((SIZE_BYTES / 1024 / 1024))
echo "[build-macos] OK: out/ffmpeg-${RUST_TRIPLE} (${SIZE_MB} MiB)"

if (( SIZE_MB > 70 )); then
  echo "[build-macos] WARN: binary is ${SIZE_MB} MiB > 70 MiB target — review codec set" >&2
fi
