#!/usr/bin/env bash
# Start (or reuse) a virtual X display for Studio. Prints the DISPLAY value.
#   eval "$(tools/studio-wine/xvfb.sh)"      # exports DISPLAY
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/env.sh"
DISPLAY_NUM="${STAGEHAND_DISPLAY:-:99}"
SCREEN="${STAGEHAND_SCREEN:-1920x1080x24}"
mkdir -p "$STAGEHAND_STUDIO_LOGS"
if ! xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1; then
  nohup Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN" +extension GLX +render -noreset -nolisten tcp \
    >"$STAGEHAND_STUDIO_LOGS/xvfb.log" 2>&1 &
  for _ in $(seq 1 50); do
    xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1 && break
    sleep 0.2
  done
  xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1 || { echo "Xvfb failed to start; see $STAGEHAND_STUDIO_LOGS/xvfb.log" >&2; exit 1; }
fi
echo "export DISPLAY=$DISPLAY_NUM"
