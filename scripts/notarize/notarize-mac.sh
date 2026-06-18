#!/usr/bin/env bash
# scripts/notarize/notarize-mac.sh
# End-to-end: sign all nested Mach-O → sign outer .app with hardened runtime
# + entitlements → ditto-zip → notarytool submit --wait → stapler staple →
# spctl assertion.
#
# Designed for D-41 (Developer ID Application + hardened runtime + notarytool)
# and the Wave-0 release-gate per Phase 1 plan 01-02. Reusable contract for
# Plan 10 release CI.
#
# CREDENTIALS-DORMANT MODE
# ------------------------
# When APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD (or the matching CLI
# flags) are missing, the script prints a clear "skipped — credentials
# pending" message and exits 0 WITHOUT touching the bundle. This is by
# design: Phase 1 ships before paid Apple Developer credentials are
# provisioned. The script becomes load-bearing the moment the env vars
# arrive — no code change needed.
#
# When credentials ARE present, the script performs the full pipeline and
# fails (non-zero) if any step rejects.
#
# Usage (flag-driven, but env vars work too — flags win):
#   notarize-mac.sh \
#     --app-path path/to/Foo.app \
#     --identity "Developer ID Application: Acme Inc (TEAMID)" \
#     --apple-id you@example.com \
#     --team-id TEAMID \
#     --password app-specific-pw \
#     [--entitlements path/to/Entitlements.plist]
#
# All flags fall back to env vars: APPLE_SIGNING_IDENTITY, APPLE_ID,
# APPLE_TEAM_ID, APPLE_APP_PASSWORD, APPLE_ENTITLEMENTS_PATH.

set -euo pipefail

APP_PATH=""
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
APPLE_ID_ARG="${APPLE_ID:-}"
TEAM_ID="${APPLE_TEAM_ID:-}"
PASSWORD="${APPLE_APP_PASSWORD:-}"
ENTITLEMENTS="${APPLE_ENTITLEMENTS_PATH:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-path)      APP_PATH="$2";        shift 2 ;;
    --identity)      IDENTITY="$2";        shift 2 ;;
    --apple-id)      APPLE_ID_ARG="$2";    shift 2 ;;
    --team-id)       TEAM_ID="$2";         shift 2 ;;
    --password)      PASSWORD="$2";        shift 2 ;;
    --entitlements)  ENTITLEMENTS="$2";    shift 2 ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "[notarize-mac] unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$APP_PATH" ]]; then
  echo "[notarize-mac] --app-path is required" >&2
  exit 2
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "[notarize-mac] not a directory (expected .app bundle): $APP_PATH" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# CREDENTIAL GATE (no-credentials-mode)
# ---------------------------------------------------------------------------
# If any of the four critical inputs is missing, treat as a deliberate skip.
# This lets PR builds and forked-PR builds (which can't see secrets) succeed
# without faking a notarization.
MISSING=()
[[ -z "$IDENTITY"     ]] && MISSING+=("--identity / APPLE_SIGNING_IDENTITY")
[[ -z "$APPLE_ID_ARG" ]] && MISSING+=("--apple-id / APPLE_ID")
[[ -z "$TEAM_ID"      ]] && MISSING+=("--team-id / APPLE_TEAM_ID")
[[ -z "$PASSWORD"     ]] && MISSING+=("--password / APPLE_APP_PASSWORD")

if (( ${#MISSING[@]} > 0 )); then
  echo "[notarize-mac] skipped — credentials pending" >&2
  echo "[notarize-mac]   Phase 1 ships before paid Apple Developer ID is provisioned." >&2
  echo "[notarize-mac]   Missing inputs:" >&2
  for m in "${MISSING[@]}"; do echo "[notarize-mac]     - $m" >&2; done
  echo "[notarize-mac]   See docs/CREDENTIALS.md for how to provision these." >&2
  echo "[notarize-mac]   Exiting 0 to keep CI green." >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Tooling check (only meaningful when we actually intend to sign).
# ---------------------------------------------------------------------------
for tool in codesign ditto xcrun stapler spctl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "[notarize-mac] missing required tool: $tool — must run on macOS with Xcode CLT" >&2
    exit 1
  }
done

# Resolve entitlements path. Prefer explicit flag/env; otherwise look inside
# the bundle at Contents/Resources/Entitlements.plist.
if [[ -z "$ENTITLEMENTS" ]]; then
  if [[ -f "$APP_PATH/Contents/Resources/Entitlements.plist" ]]; then
    ENTITLEMENTS="$APP_PATH/Contents/Resources/Entitlements.plist"
  fi
fi

echo "[notarize-mac] App:           $APP_PATH"
echo "[notarize-mac] Identity:      $IDENTITY"
echo "[notarize-mac] Team ID:       $TEAM_ID"
echo "[notarize-mac] Apple ID:      $APPLE_ID_ARG"
echo "[notarize-mac] Entitlements:  ${ENTITLEMENTS:-<none>}"

# ---------------------------------------------------------------------------
# 1. Sign every nested Mach-O first (PITFALLS.md §2 — this is the #1
#    notarization failure mode). We exclude the main executable in
#    Contents/MacOS because it gets signed last with entitlements.
# ---------------------------------------------------------------------------
echo "[notarize-mac] (1/6) signing nested Mach-O binaries"

# Find candidates: dylibs, .so, frameworks' main binaries, sidecar binaries.
# We use `file` to check Mach-O type rather than just permissions, because
# many resources happen to be +x without being executables.
find "$APP_PATH" -type f \
  \( -name '*.dylib' -o -name '*.so' -o -path '*/Contents/MacOS/*' \) \
  -not -path "*/Contents/MacOS/$(basename "$APP_PATH" .app)" \
  -print0 2>/dev/null | while IFS= read -r -d '' f; do
    if file "$f" 2>/dev/null | grep -q 'Mach-O'; then
      echo "[notarize-mac]   sign $f"
      codesign --force --timestamp --options runtime --sign "$IDENTITY" "$f"
    fi
  done

# ---------------------------------------------------------------------------
# 2. Sign the outer .app last, with hardened runtime + entitlements.
# ---------------------------------------------------------------------------
echo "[notarize-mac] (2/6) signing outer .app with hardened runtime"
if [[ -n "$ENTITLEMENTS" && -f "$ENTITLEMENTS" ]]; then
  codesign --force --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" \
    --sign "$IDENTITY" "$APP_PATH"
else
  codesign --force --timestamp --options runtime \
    --sign "$IDENTITY" "$APP_PATH"
fi

# ---------------------------------------------------------------------------
# 3. Verify the signature integrity before submission.
# ---------------------------------------------------------------------------
echo "[notarize-mac] (3/6) codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# ---------------------------------------------------------------------------
# 4. Zip via ditto (preserves bundle structure for notarytool).
# ---------------------------------------------------------------------------
ZIP_PATH="${APP_PATH%.app}.zip"
rm -f "$ZIP_PATH"
echo "[notarize-mac] (4/6) ditto -c -k --keepParent → $ZIP_PATH"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

# ---------------------------------------------------------------------------
# 5. Submit to notarytool. On rejection, fetch the log + print before exit.
# ---------------------------------------------------------------------------
echo "[notarize-mac] (5/6) xcrun notarytool submit --wait (timeout 30m)"

SUBMIT_OUT="$(mktemp)"
set +e
xcrun notarytool submit "$ZIP_PATH" \
  --apple-id "$APPLE_ID_ARG" \
  --team-id "$TEAM_ID" \
  --password "$PASSWORD" \
  --wait \
  --timeout 30m \
  --output-format json > "$SUBMIT_OUT" 2>&1
SUBMIT_RC=$?
set -e

echo "[notarize-mac] notarytool output:"
cat "$SUBMIT_OUT"

# Try to extract submission id and status
SUB_ID="$(grep -Eo '"id"[[:space:]]*:[[:space:]]*"[^"]+"' "$SUBMIT_OUT" | head -1 | sed -E 's/.*"([^"]+)"$/\1/' || true)"
STATUS="$(grep -Eo '"status"[[:space:]]*:[[:space:]]*"[^"]+"' "$SUBMIT_OUT" | head -1 | sed -E 's/.*"([^"]+)"$/\1/' || true)"

if [[ "$STATUS" != "Accepted" || $SUBMIT_RC -ne 0 ]]; then
  echo "[notarize-mac] notarization NOT accepted (status='$STATUS', rc=$SUBMIT_RC)" >&2
  if [[ -n "$SUB_ID" ]]; then
    echo "[notarize-mac] fetching notarytool log for $SUB_ID:" >&2
    xcrun notarytool log "$SUB_ID" \
      --apple-id "$APPLE_ID_ARG" \
      --team-id "$TEAM_ID" \
      --password "$PASSWORD" >&2 || true
  fi
  exit 1
fi

# ---------------------------------------------------------------------------
# 6. Staple the ticket + final spctl assertion.
# ---------------------------------------------------------------------------
echo "[notarize-mac] (6/6) stapling ticket + spctl -a -vv"
xcrun stapler staple "$APP_PATH"

if ! spctl -a -vv "$APP_PATH" 2>&1 | tee /dev/stderr | grep -q "accepted"; then
  echo "[notarize-mac] spctl rejected the bundle after stapling" >&2
  exit 1
fi

SIZE_BYTES="$(du -sk "$APP_PATH" | awk '{print $1}')"
SIZE_MB=$((SIZE_BYTES / 1024))
echo "[notarize-mac] OK: $APP_PATH (${SIZE_MB} MiB) signed, notarized, stapled"
