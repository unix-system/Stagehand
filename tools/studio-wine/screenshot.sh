#!/usr/bin/env bash
# Screenshot the virtual display to a PNG (default: logs/shot-<timestamp>.png) and list windows.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/env.sh"
export DISPLAY="${DISPLAY:-${STAGEHAND_DISPLAY:-:99}}"
out="${1:-$STAGEHAND_STUDIO_LOGS/shot-$(date -u +%Y%m%dT%H%M%SZ).png}"
import -window root "$out"
echo "$out"
xdotool search --onlyvisible --name '' 2>/dev/null | while read -r w; do
  printf '  window %s: %s\n' "$w" "$(xdotool getwindowname "$w" 2>/dev/null)"
done
