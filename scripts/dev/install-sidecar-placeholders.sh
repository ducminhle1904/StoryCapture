#!/usr/bin/env bash
# scripts/dev/install-sidecar-placeholders.sh
#
# Drop placeholder sidecar stubs into apps/desktop/src-tauri/binaries/ for
# the current Rust host triple so `cargo check -p storycapture --lib`
# (and the rest of the workspace) builds locally without requiring the
# real FFmpeg / Playwright SEA artifacts.
#
# - ffmpeg-<triple>            — stub exits 127 at runtime.
# - playwright-sidecar-<triple> — stub exits 127 at runtime.
#
# Release CI downloads the real per-triple binaries from ffmpeg-build.yml
# and playwright-sidecar-build.yml before bundling.
#
# Idempotent: won't overwrite a real binary (files >10 KB are assumed
# real; stubs are tiny shell scripts).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BIN_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"

TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
if [[ -z "$TRIPLE" ]]; then
  echo "ERROR: could not determine rustc host triple" >&2
  exit 1
fi

case "$TRIPLE" in
  *windows*) EXT=".exe" ;;
  *) EXT="" ;;
esac

mkdir -p "$BIN_DIR"

install_stub() {
  local name="$1" desc="$2"
  local path="$BIN_DIR/${name}-${TRIPLE}${EXT}"
  if [[ -f "$path" ]]; then
    local size
    size=$(wc -c <"$path" | tr -d ' ')
    if [[ "$size" -gt 10240 ]]; then
      echo "[skip] $path is >10 KiB — assuming real binary"
      return 0
    fi
  fi
  if [[ "$EXT" == ".exe" ]]; then
    # PowerShell batch shim that writes to stderr and exits 127.
    cat > "$path" <<EOF
@echo off
echo storycapture: ${name} placeholder — see scripts/dev/install-sidecar-placeholders.sh 1>&2
exit /B 127
EOF
  else
    cat > "$path" <<EOF
#!/usr/bin/env bash
# ${desc}
echo "storycapture: ${name} placeholder — see scripts/dev/install-sidecar-placeholders.sh" 1>&2
exit 127
EOF
    chmod +x "$path"
  fi
  echo "[install] $path"
}

install_stub "ffmpeg" "Dev placeholder for FFmpeg LGPL static sidecar (Plan 01-02)."
install_stub "playwright-sidecar" "Dev placeholder for Playwright Node SEA sidecar (Plan 01-06)."

echo "done — run 'cargo check -p storycapture --lib' to verify"
