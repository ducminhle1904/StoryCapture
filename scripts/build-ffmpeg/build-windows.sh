#!/usr/bin/env bash
# scripts/build-ffmpeg/build-windows.sh
# Build a fully static, LGPL-only FFmpeg 7.x binary for Windows x64 under
# MSYS2/MINGW64. Intended to run inside the GitHub Actions
# `windows-latest` runner with msys2/setup-msys2 active (msystem: MINGW64).
#
# Per D-22 / D-24: no GPL codecs (no x264/x265). Hardware encoders included:
# NVENC, QSV (libmfx), AMF — runtime feature detection in `crates/encoder`
# falls back to `libopenh264` (LGPL) when no hardware encoder is available.
#
# Output: out/ffmpeg-x86_64-pc-windows-msvc.exe
# (Even though we use mingw-w64 to compile, the Rust target triple is
# x86_64-pc-windows-msvc to match the Tauri externalBin convention used by
# `apps/desktop/src-tauri/tauri.conf.json`.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
BUILD_DIR="$SCRIPT_DIR/build"
CACHE_DIR="$SCRIPT_DIR/cache"

FFMPEG_VERSION="${FFMPEG_VERSION:-7.0.2}"
FFMPEG_TARBALL="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_TARBALL}"
SHA_FILE="$SCRIPT_DIR/ffmpeg-${FFMPEG_VERSION}.sha256"

RUST_TRIPLE="x86_64-pc-windows-msvc"

# --- host check ---------------------------------------------------------
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) : ;;
  *)
    echo "[build-windows] must run inside MSYS2/MINGW64 (got $(uname -s))" >&2
    echo "[build-windows] In CI, use msys2/setup-msys2@v2 with msystem: MINGW64" >&2
    exit 1
    ;;
esac

for dep in nasm yasm make pkg-config x86_64-w64-mingw32-gcc curl sha256sum; do
  command -v "$dep" >/dev/null 2>&1 || {
    echo "[build-windows] missing required tool: $dep" >&2
    echo "[build-windows] install via pacman: pacman -S --needed make yasm nasm pkg-config mingw-w64-x86_64-gcc" >&2
    exit 1
  }
done

mkdir -p "$OUT_DIR" "$BUILD_DIR" "$CACHE_DIR"

# --- fetch + verify source ----------------------------------------------
TARBALL_PATH="$CACHE_DIR/$FFMPEG_TARBALL"
if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "[build-windows] downloading $FFMPEG_URL"
  curl -fL --retry 3 -o "$TARBALL_PATH" "$FFMPEG_URL"
fi

if [[ -f "$SHA_FILE" ]]; then
  EXPECTED_SHA="$(awk '{print $1}' "$SHA_FILE")"
  ACTUAL_SHA="$(sha256sum "$TARBALL_PATH" | awk '{print $1}')"
  if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
    if [[ "${FFMPEG_ALLOW_SHA_BOOTSTRAP:-0}" == "1" ]]; then
      echo "[build-windows] WARNING: SHA mismatch — overwriting pin"
      echo "$ACTUAL_SHA  $FFMPEG_TARBALL" > "$SHA_FILE"
    else
      echo "[build-windows] SHA256 mismatch! expected=$EXPECTED_SHA actual=$ACTUAL_SHA" >&2
      exit 1
    fi
  fi
else
  echo "[build-windows] no SHA file at $SHA_FILE — refusing to build untrusted source" >&2
  exit 1
fi

# --- extract ------------------------------------------------------------
SRC_DIR="$BUILD_DIR/ffmpeg-${FFMPEG_VERSION}-win64"
rm -rf "$SRC_DIR" "$BUILD_DIR/ffmpeg-${FFMPEG_VERSION}"
tar -xJf "$TARBALL_PATH" -C "$BUILD_DIR"
mv "$BUILD_DIR/ffmpeg-${FFMPEG_VERSION}" "$SRC_DIR"

PREFIX="$OUT_DIR/win64"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"

# --- configure ----------------------------------------------------------
# Hardware encoders are wired in; their availability at runtime depends on
# the user's GPU. Headers for NVENC/AMF/QSV must be on the include path —
# in CI we install nv-codec-headers / amf-headers / Intel oneVPL headers via
# pacman + manual fetch (see notes in CI workflow).
#
# We deliberately use the mingw toolchain (NOT --toolchain=msvc) because it
# produces a fully static .exe with only Win32 imports and no MSVC runtime
# DLLs beyond the universal CRT. This sidesteps the MSVC redist problem.
cd "$SRC_DIR"

CONFIGURE_FLAGS=(
  --prefix="$PREFIX"
  --enable-static
  --disable-shared
  --pkg-config-flags=--static
  --disable-gpl
  --disable-nonfree
  --disable-debug
  --disable-doc
  --disable-ffplay
  --disable-network
  --disable-autodetect
  --enable-small
  --enable-encoder=h264_nvenc,hevc_nvenc,h264_qsv,hevc_qsv,h264_amf,hevc_amf,aac,pcm_s16le
  --enable-decoder=h264,hevc,aac,pcm_s16le,rawvideo
  --enable-parser=h264,hevc,aac
  --enable-muxer=mp4,mov,matroska,null
  --enable-demuxer=mov,matroska,rawvideo,aac
  --enable-protocol=file,pipe
  --enable-filter=scale,format,fps,setpts,asetpts,aresample,anull,null
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb
  --target-os=mingw64
  --arch=x86_64
  --cross-prefix=x86_64-w64-mingw32-
  --enable-cross-compile
)

# Hardware encoder enables — only flip on if headers are available, otherwise
# configure will error out. The CI workflow sets these env vars after fetching
# headers; locally we let pkg-config decide.
if pkg-config --exists ffnvcodec 2>/dev/null; then
  CONFIGURE_FLAGS+=(--enable-nvenc)
  echo "[build-windows] NVENC headers present"
fi
if pkg-config --exists libmfx 2>/dev/null || pkg-config --exists libvpl 2>/dev/null; then
  CONFIGURE_FLAGS+=(--enable-libmfx)
  echo "[build-windows] Intel QSV (libmfx) headers present"
fi
if [[ -n "${AMF_HEADERS:-}" && -d "$AMF_HEADERS" ]]; then
  CONFIGURE_FLAGS+=(--enable-amf "--extra-cflags=-I${AMF_HEADERS}")
  echo "[build-windows] AMF headers present at $AMF_HEADERS"
fi

echo "[build-windows] configuring"
./configure "${CONFIGURE_FLAGS[@]}"

JOBS="$(nproc 2>/dev/null || echo 4)"
echo "[build-windows] building with $JOBS jobs"
make -j"$JOBS"
make install

# --- emit per-triple binary --------------------------------------------
cp "$PREFIX/bin/ffmpeg.exe"  "$OUT_DIR/ffmpeg-${RUST_TRIPLE}.exe"
cp "$PREFIX/bin/ffprobe.exe" "$OUT_DIR/ffprobe-${RUST_TRIPLE}.exe"

# --- verify static + LGPL ----------------------------------------------
"$SCRIPT_DIR/verify-static.sh" "$OUT_DIR/ffmpeg-${RUST_TRIPLE}.exe"

SIZE_BYTES="$(stat -c %s "$OUT_DIR/ffmpeg-${RUST_TRIPLE}.exe" 2>/dev/null || stat -f %z "$OUT_DIR/ffmpeg-${RUST_TRIPLE}.exe")"
SIZE_MB=$((SIZE_BYTES / 1024 / 1024))
echo "[build-windows] OK: out/ffmpeg-${RUST_TRIPLE}.exe (${SIZE_MB} MiB)"

if (( SIZE_MB > 70 )); then
  echo "[build-windows] WARN: binary is ${SIZE_MB} MiB > 70 MiB target — review codec set" >&2
fi
