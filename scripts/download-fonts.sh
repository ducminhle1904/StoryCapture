#!/usr/bin/env bash
# Download the 5 real OFL-licensed TTFs into assets/fonts/, overwriting the
# CI-safe stubs committed at the repo root.
#
# Usage:  ./scripts/download-fonts.sh
#
# Requires:  curl, unzip (Geist release is a zip archive)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FONT_DIR="$REPO_ROOT/assets/fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$FONT_DIR"
cd "$TMP"

echo "==> Geist (Regular + Bold)"
curl -fsSL \
  "https://github.com/vercel/geist-font/releases/latest/download/geist-font.zip" \
  -o geist.zip
unzip -q geist.zip -d geist
# Upstream path has historically been `.../ttf/Geist-Regular.ttf` etc.
find geist -name 'Geist-Regular.ttf' -exec cp {} "$FONT_DIR/Geist-Regular.ttf" \;
find geist -name 'Geist-Bold.ttf'    -exec cp {} "$FONT_DIR/Geist-Bold.ttf" \;

echo "==> JetBrains Mono Regular"
curl -fsSL \
  "https://github.com/JetBrains/JetBrainsMono/releases/latest/download/JetBrainsMono-2.304.zip" \
  -o jbmono.zip || curl -fsSL \
  "https://github.com/JetBrains/JetBrainsMono/releases/latest/download/JetBrainsMono.zip" \
  -o jbmono.zip
unzip -q jbmono.zip -d jbmono
find jbmono -name 'JetBrainsMono-Regular.ttf' -exec cp {} "$FONT_DIR/JetBrainsMono-Regular.ttf" \;

echo "==> Inter (Display variant)"
# Inter 4.x ships a variable font; copy the static Display-Bold as a close
# match for v1 (POST-07 expects a display-weight sans).
curl -fsSL \
  "https://github.com/rsms/inter/releases/latest/download/Inter.zip" \
  -o inter.zip
unzip -q inter.zip -d inter
find inter -name 'Inter-Display.ttf'     -exec cp {} "$FONT_DIR/Inter-Display.ttf" \;
find inter -name 'InterDisplay-Bold.ttf' -exec cp {} "$FONT_DIR/Inter-Display.ttf" \;

echo "==> Space Grotesk"
# Google Fonts Space Grotesk download.
curl -fsSL \
  "https://github.com/floriankarsten/space-grotesk/releases/latest/download/SpaceGrotesk.zip" \
  -o spacegrotesk.zip
unzip -q spacegrotesk.zip -d sg
find sg -name 'SpaceGrotesk-Bold.ttf'    -exec cp {} "$FONT_DIR/SpaceGrotesk-Display.ttf" \;
find sg -name 'SpaceGrotesk-Regular.ttf' -exec cp {} "$FONT_DIR/SpaceGrotesk-Display.ttf" \;

echo "==> Done. Fonts in $FONT_DIR:"
ls -la "$FONT_DIR"
