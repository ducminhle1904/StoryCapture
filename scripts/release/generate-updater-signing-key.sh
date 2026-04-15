#!/usr/bin/env bash
# scripts/release/generate-updater-signing-key.sh
#
# One-time helper: generate a Tauri updater signing keypair via
# `tauri signer generate`. Run ONCE at project setup; NEVER commit the
# resulting private key.
#
# Workflow:
#   1. Private key → copy into GitHub Secrets as TAURI_UPDATER_PRIVATE_KEY
#      and set TAURI_UPDATER_KEY_PASSWORD to the password you chose.
#   2. Public key (base64, single line) → paste into
#      apps/desktop/src-tauri/tauri.conf.json at plugins.updater.pubkey.
#   3. Keep the local copy in $OUT_DIR (default .release-keys/) OFF of VCS —
#      root .gitignore already excludes .release-keys/.
#
# Tauri CLI docs: https://v2.tauri.app/plugin/updater/#signing-updates
set -euo pipefail

OUT_DIR="${1:-.release-keys}"
KEY_BASENAME="storycapture_updater.key"

mkdir -p "$OUT_DIR"

if command -v npx >/dev/null 2>&1; then
  RUNNER=(npx @tauri-apps/cli signer generate)
elif command -v pnpm >/dev/null 2>&1; then
  RUNNER=(pnpm exec tauri signer generate)
else
  echo "error: need either 'npx' or 'pnpm' in PATH" >&2
  exit 1
fi

# tauri signer generate -w <path> writes <path> (private) + <path>.pub.
"${RUNNER[@]}" -w "$OUT_DIR/$KEY_BASENAME"

cat <<EOF

Generated Tauri updater keypair:
  Private key: $OUT_DIR/$KEY_BASENAME
  Public key:  $OUT_DIR/$KEY_BASENAME.pub

Next steps (do NOT commit the private key):
  1. GitHub → Settings → Secrets and variables → Actions → New repository secret
       TAURI_UPDATER_PRIVATE_KEY   = contents of $KEY_BASENAME
       TAURI_UPDATER_KEY_PASSWORD  = password entered above
  2. apps/desktop/src-tauri/tauri.conf.json → plugins.updater.pubkey =
       contents of $KEY_BASENAME.pub (single line, base64).
  3. Verify $OUT_DIR/ is gitignored:  git check-ignore -v $OUT_DIR/$KEY_BASENAME
EOF
