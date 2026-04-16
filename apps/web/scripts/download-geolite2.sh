#!/usr/bin/env bash
# Download MaxMind GeoLite2-Country database for IP -> country lookup (D-06).
# Run during Vercel build or CI deploy. Requires MAXMIND_LICENSE_KEY env var.
#
# Usage:
#   MAXMIND_LICENSE_KEY=your_key ./scripts/download-geolite2.sh

set -euo pipefail

if [ -z "${MAXMIND_LICENSE_KEY:-}" ]; then
  echo "WARNING: MAXMIND_LICENSE_KEY not set. Skipping GeoLite2 download."
  echo "Country lookups will return 'XX' for all IPs."
  exit 0
fi

OUTPUT_DIR="$(dirname "$0")/../public/geolite2"
mkdir -p "$OUTPUT_DIR"

echo "Downloading GeoLite2-Country database..."

curl -sS "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz" \
  | tar xz --strip-components=1 -C "$OUTPUT_DIR"

if [ -f "$OUTPUT_DIR/GeoLite2-Country.mmdb" ]; then
  echo "GeoLite2-Country.mmdb downloaded successfully to $OUTPUT_DIR"
else
  echo "ERROR: GeoLite2-Country.mmdb not found after extraction."
  exit 1
fi
