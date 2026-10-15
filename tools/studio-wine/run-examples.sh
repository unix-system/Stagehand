#!/usr/bin/env bash
# End-to-end: build the plugin and example place, open the place in Studio (Wine + Xvfb) with the
# plugin installed via run-in-roblox --hold, then run the example playtests with
# `stagehand-mcp --run`. Exit code is the daemon's (0 all passed, 1 failures, 2 setup).
#
#   tools/studio-wine/run-examples.sh                      # run-mode-smoke only
#   tools/studio-wine/run-examples.sh run-mode-smoke blue-team-gun-hostile
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
source "$here/env.sh"
eval "$("$here/xvfb.sh")"
export PATH="$HOME/.local/bin:$PATH"
tests=("$@"); [ ${#tests[@]} -gt 0 ] || tests=(run-mode-smoke)
mkdir -p "$root/build" "$STAGEHAND_STUDIO_LOGS"

log() { printf '[run-examples] %s\n' "$*" >&2; }
log "building plugin and example place"
rojo build "$root/plugin" -o "$root/build/Stagehand.rbxm"
rojo build "$root/examples/place" -o "$root/build/StagehandExample.rbxl"
[ -f "$root/packages/mcp/dist/index.js" ] || (cd "$root" && pnpm --filter stagehand-mcp build)
rir="$root/tools/run-in-roblox/target/release/run-in-roblox"
[ -x "$rir" ] || (cd "$root/tools/run-in-roblox" && cargo build --release)

"$here/auth.sh" status || log "WARNING: Studio is not signed in; it will stop at the login screen"

launcher_log="$STAGEHAND_STUDIO_LOGS/run-examples-launcher.log"
log "starting Studio via run-in-roblox --hold (log: $launcher_log)"
"$rir" --hold --place "$root/build/StagehandExample.rbxl" --plugin "$root/build/Stagehand.rbxm" \
  --timeout "${STAGEHAND_HOLD_TIMEOUT:-1800}" --connect-timeout 300 --studio-log \
  --wine-log "$STAGEHAND_STUDIO_LOGS/run-examples-wine.log" >"$launcher_log" 2>&1 &
launcher=$!
cleanup() { kill -TERM "$launcher" 2>/dev/null || true; wait "$launcher" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 300); do
  grep -q '^READY' "$launcher_log" && break
  kill -0 "$launcher" 2>/dev/null || { log "launcher exited early:"; tail -20 "$launcher_log" >&2; exit 2; }
  sleep 1
done
grep -q '^READY' "$launcher_log" || { log "Studio never connected"; exit 2; }
log "Studio is up; running: ${tests[*]}"

args=()
for t in "${tests[@]}"; do args+=(--run "$t"); done
set +e
node "$root/packages/mcp/dist/index.js" --root "$root/examples" --wait-for-studio "${STAGEHAND_WAIT_FOR_STUDIO:-300s}" "${args[@]}"
code=$?
set -e
log "stagehand-mcp exited with $code"
exit "$code"
