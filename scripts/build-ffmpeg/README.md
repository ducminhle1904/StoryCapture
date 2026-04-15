# scripts/build-ffmpeg/

Recipes for building **universal static, LGPL-only FFmpeg 7.x** binaries for
all StoryCapture target triples. This is a Wave-0 release-gate concern
(per Phase 1 plan 01-02); the resulting binaries ship as Tauri externalBin
sidecars from `apps/desktop/src-tauri/binaries/`.

## Pinned version

- **FFmpeg 7.0.2** (latest 7.0.x stable as of Phase 1).
  Source SHA256 pinned in `ffmpeg-7.0.2.sha256`.

If 7.0.2 becomes unavailable upstream, bump the version + SHA together and
update this README.

> **Note on SHA bootstrap:** `ffmpeg-7.0.2.sha256` is committed with what we
> believe to be the correct hash, but the first CI run with the actual
> upstream tarball will validate (and, if launched with
> `FFMPEG_ALLOW_SHA_BOOTSTRAP=1`, auto-correct) the value. Once a clean run
> is observed, the env var is dropped.

## Codec set + rationale (LGPL-only — D-22, D-24)

We **never** enable `--enable-gpl`, `--enable-libx264`, or `--enable-libx265`.
Doing so would force StoryCapture to redistribute under GPL.

Encoders shipped:

| Encoder              | Platform       | When it's used                                   |
| -------------------- | -------------- | ------------------------------------------------ |
| `h264_videotoolbox`  | macOS          | Default on Mac (HW)                              |
| `hevc_videotoolbox`  | macOS          | When the user picks HEVC                         |
| `h264_nvenc`         | Windows NVIDIA | Default on machines with NVIDIA GPU              |
| `hevc_nvenc`         | Windows NVIDIA | HEVC on NVIDIA                                    |
| `h264_qsv`           | Windows Intel  | Intel iGPU/Arc                                   |
| `hevc_qsv`           | Windows Intel  | HEVC on Intel                                    |
| `h264_amf`           | Windows AMD    | AMD Radeon                                       |
| `hevc_amf`           | Windows AMD    | HEVC on AMD                                      |
| `libopenh264` (opt.) | both           | LGPL software fallback per D-24                  |
| `aac`                | both           | Audio                                            |
| `pcm_s16le`          | both           | Uncompressed staging audio                       |

`crates/encoder` probes encoders at runtime (D-24); no available encoder ⇒
clear diagnostic. **`libopenh264` is the only software H.264 fallback** —
`libx264` is forbidden by license discipline.

Decoders/parsers/muxers/demuxers are limited to the H.264/HEVC/AAC/MP4/MOV/
Matroska/raw video set actually used by capture + post-pro.

## How to run locally

### macOS

```bash
# host = arm64 Mac
bash scripts/build-ffmpeg/build-macos.sh aarch64
bash scripts/build-ffmpeg/build-macos.sh x86_64    # cross-arch native via -arch
```

Outputs:

```
scripts/build-ffmpeg/out/ffmpeg-aarch64-apple-darwin
scripts/build-ffmpeg/out/ffmpeg-x86_64-apple-darwin
scripts/build-ffmpeg/out/ffprobe-aarch64-apple-darwin
scripts/build-ffmpeg/out/ffprobe-x86_64-apple-darwin
```

Each runs `verify-static.sh` automatically. `verify-static.sh` exits non-zero
if any non-system dylib is linked or if `--enable-gpl` is in the buildconf.

Local prereqs: Xcode CLT, `brew install nasm yasm pkg-config`. Optional:
`brew install openh264` to bake in the LGPL software fallback.

### Windows

```bash
# inside MSYS2 MINGW64 (CI does this via msys2/setup-msys2@v2)
pacman -S --needed make yasm nasm pkg-config mingw-w64-x86_64-gcc
bash scripts/build-ffmpeg/build-windows.sh
```

Output: `scripts/build-ffmpeg/out/ffmpeg-x86_64-pc-windows-msvc.exe`

The Rust triple in the filename matches Tauri's externalBin convention even
though we compile via mingw-w64 (this gives a fully static binary with no
MSVC redist dependency).

## How CI consumes these (D-23 / Plan 03 / Plan 08)

`.github/workflows/ffmpeg-build.yml` runs the three build jobs in parallel
on every PR that touches `scripts/build-ffmpeg/**` (plus `workflow_dispatch`).
Each job uploads its binary as an artifact named:

- `ffmpeg-aarch64-apple-darwin`
- `ffmpeg-x86_64-apple-darwin`
- `ffmpeg-x86_64-pc-windows-msvc`

Plan 08 (encoder crate) downloads these into
`apps/desktop/src-tauri/binaries/` for `pnpm tauri dev` and release builds.

## Size budget

Target: each FFmpeg binary < 70 MiB. Current builds (with the codec set
above + `--enable-small --disable-doc --disable-network --disable-autodetect`)
are typically 40-55 MiB. The verify script logs the actual size after every
build.

## Output contract

The binaries land at:

```
scripts/build-ffmpeg/out/ffmpeg-<triple>
scripts/build-ffmpeg/out/ffprobe-<triple>
```

with `<triple>` being one of:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-pc-windows-msvc.exe`

Plan 03 wires Tauri externalBin to expect these names exactly.
