#!/usr/bin/env bash
set -euo pipefail

# Verify that all golden fixture YAML files only reference verbs from the
# authoritative whitelist in their required_verbs arrays.  Exits 0 if clean,
# 1 if any fixture references an unknown verb in required_verbs.
# Note: forbidden_verbs are intentionally NOT checked -- they list verbs
# the model must NOT use, which may include non-whitelisted verbs.

WHITELIST="navigate click type wait wait_for assert hover scroll upload drag select screenshot pause press_key scene"

STATUS=0

for f in crates/intelligence/tests/fixtures/golden/**/*.yaml; do
  [ -f "$f" ] || continue

  # Extract verb names from required_verbs and forbidden_verbs lines.
  # These are YAML arrays on a single line: [verb1, verb2, ...]
  verbs=$(grep -oE 'required_verbs: \[.*\]' "$f" \
    | sed 's/.*\[//;s/\]//' \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | grep -v '^$' || true)

  for verb in $verbs; do
    found=0
    for w in $WHITELIST; do
      if [ "$verb" = "$w" ]; then
        found=1
        break
      fi
    done
    if [ "$found" -eq 0 ]; then
      echo "ERROR: unknown verb '$verb' in $f"
      STATUS=1
    fi
  done
done

if [ "$STATUS" -eq 0 ]; then
  echo "verb-whitelist-grep: PASS (all fixture verbs are whitelisted)"
fi
exit "$STATUS"
