#!/usr/bin/env bash
# scripts/notarize/notarize-smoke.sh
# End-to-end smoke test for the sign + notarize + staple pipeline.
#
# Two modes:
#   1. CREDENTIALS PRESENT — builds a trivial test binary, runs the full
#      notarize-mac.sh against it, asserts spctl reports "accepted". This
#      proves the pipeline works on a clean runner before any real release.
#   2. CREDENTIALS ABSENT — prints "skipped — credentials pending" and exits
#      0. This keeps CI green while Phase 1 is pre-credential.
#
# Invoked by .github/workflows/notarize-smoke.yml on every PR touching
# scripts/notarize/** or scripts/build-ffmpeg/**.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[notarize-smoke] no-op: must run on macOS" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Credential gate
# ---------------------------------------------------------------------------
if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" || -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "[notarize-smoke] skipped — credentials pending"
  echo "[notarize-smoke]   APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID / APPLE_SIGNING_IDENTITY not set."
  echo "[notarize-smoke]   See docs/CREDENTIALS.md for provisioning steps."
  echo "[notarize-smoke]   The pipeline will run automatically the moment these are configured."
  exit 0
fi

# ---------------------------------------------------------------------------
# Build a minimal smoke .app bundle by hand. We avoid pulling in Tauri here
# so the smoke test isolates the signing/notarizing pipeline from the Rust
# build. The bundle just needs a valid Mach-O entry point + Info.plist.
# ---------------------------------------------------------------------------
WORK="$(mktemp -d)"
APP="$WORK/SmokeNotarize.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>           <string>com.storycapture.smoke-notarize</string>
  <key>CFBundleName</key>                 <string>SmokeNotarize</string>
  <key>CFBundleExecutable</key>           <string>SmokeNotarize</string>
  <key>CFBundlePackageType</key>          <string>APPL</string>
  <key>CFBundleShortVersionString</key>   <string>0.0.1</string>
  <key>CFBundleVersion</key>              <string>1</string>
  <key>LSMinimumSystemVersion</key>       <string>11.0</string>
</dict>
</plist>
PLIST

# Minimal C program ⇒ trivial Mach-O.
cat > "$WORK/main.c" <<'C'
#include <stdio.h>
int main(void) { puts("smoke"); return 0; }
C
clang -mmacosx-version-min=11.0 -o "$APP/Contents/MacOS/SmokeNotarize" "$WORK/main.c"

# Drop the canonical Entitlements.plist next to the bundle so notarize-mac.sh
# picks it up.
cp "$SCRIPT_DIR/smoke-app/src-tauri/Entitlements.plist" "$APP/Contents/Resources/Entitlements.plist"

echo "[notarize-smoke] built smoke bundle at $APP"

# ---------------------------------------------------------------------------
# Run the full notarize-mac.sh against it.
# ---------------------------------------------------------------------------
bash "$SCRIPT_DIR/notarize-mac.sh" \
  --app-path "$APP" \
  --identity "$APPLE_SIGNING_IDENTITY" \
  --apple-id "$APPLE_ID" \
  --team-id  "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --entitlements "$APP/Contents/Resources/Entitlements.plist"

echo "[notarize-smoke] PASS — full sign + notarize + staple pipeline green"
