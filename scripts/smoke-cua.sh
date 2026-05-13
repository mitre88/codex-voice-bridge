#!/usr/bin/env bash
set -euo pipefail

if ! command -v cua-driver >/dev/null 2>&1; then
  echo "cua-driver is not installed or not in PATH." >&2
  exit 1
fi

permissions="$(cua-driver call check_permissions '{"prompt":false}' --compact)"
echo "$permissions" | grep -Eq '"accessibility".*"granted":true|Accessibility: granted' || {
  echo "Accessibility permission is not granted for CUA Driver." >&2
  echo "$permissions" >&2
  exit 1
}
echo "Accessibility: granted."

echo "$permissions" | grep -Eq '"screen_recording".*"granted":true|Screen Recording: granted' || {
  echo "Screen Recording permission is not granted for CUA Driver." >&2
  echo "$permissions" >&2
  exit 1
}
echo "Screen Recording: granted."

cua-driver call list_apps '{}' --compact >/dev/null
echo "CUA smoke OK"
