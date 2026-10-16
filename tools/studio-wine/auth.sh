#!/usr/bin/env bash
# Sign Roblox Studio (under Wine) into an account without a desktop, using one-time links that the
# account owner produces in their own browser. Studio persists the resulting session in the Wine
# prefix's Credential Manager, so this is needed once per prefix.
#
#   auth.sh status                      show whether the prefix holds a Studio login
#   auth.sh code                        print the Quick sign-in code Studio's sign-in page is showing
#                                       (type it at roblox.com > Quick Log In, or in the Roblox app:
#                                       More > Quick Log In). Codes rotate every ~2 minutes.
#   auth.sh wait [SECS]                 wait until Studio has stored a login (default 300s)
#   auth.sh ticket PLACE_ID UNIVERSE_ID  redeem a one-time rbx-authentication-ticket (read from
#                                       $STAGEHAND_AUTH_TICKET or stdin) by launching Studio with the
#                                       same roblox-studio: link the website's "Edit in Studio" uses
#   auth.sh signin                      press Studio's "Sign in" and print the OAuth URL to open in
#                                       your browser (anywhere); it ends in a roblox-studio-auth: link
#   auth.sh link 'roblox-studio-auth:/?code=...'
#                                       forward Studio's browser-login callback to the running Studio
#   auth.sh export FILE | import FILE   back up / restore the login (Wine Credential Manager registry
#                                       key). Treat the file as a secret; keep it out of git.
#
# Path "ticket" (preferred): in a browser where you are signed in to roblox.com, open DevTools >
# Network, click "Edit in Studio" on a place you own, CANCEL the browser's "open Roblox Studio"
# prompt, find the request to auth.roblox.com/v1/authentication-ticket and copy the value of its
# rbx-authentication-ticket response header. The ticket is single-use and short-lived: run this
# script within a minute or two.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/env.sh"
export DISPLAY="${DISPLAY:-${STAGEHAND_DISPLAY:-:99}}"
CRED_KEY='HKCU\Software\Wine\Credential Manager'

log() { printf '[auth] %s\n' "$*" >&2; }
studio_dir() { local d; d=$(stagehand_studio_dir); [ -n "$d" ] || { log "no Studio install; run install_studio.py"; exit 2; }; printf '%s' "$d"; }
newest_log() { ls -t "$WINEPREFIX"/drive_c/users/*/AppData/Local/Roblox/logs/*_last.log 2>/dev/null | head -1; }

status() {
  if grep -q 'RobloxStudioAuth' "$WINEPREFIX/user.reg" 2>/dev/null; then
    log "prefix holds Studio credentials:"
    grep -o 'Generic: https://www.roblox.com:RobloxStudioAuth[^]]*' "$WINEPREFIX/user.reg" | sed 's/^/  /' | sort -u >&2
    return 0
  fi
  log "no Studio credentials in $WINEPREFIX"
  return 1
}

# Watch the newest Studio log for a login verdict for up to $1 seconds.
watch_login() {
  local secs="$1" i l
  for i in $(seq 1 "$secs"); do
    l=$(newest_log || true)
    if [ -n "$l" ]; then
      if grep -qiE 'LoginController.*(success|logged in|authenticated)|\[FLog::Login\].*succe|userId=[0-9]+' "$l"; then
        log "login succeeded (see $l)"; return 0
      fi
      if grep -qiE 'authentication-ticket.*(fail|invalid|expired)|redeem.*(fail|error)|Login failed' "$l"; then
        log "login FAILED according to $l:"; grep -iE 'ticket|login' "$l" | tail -5 >&2; return 1
      fi
    fi
    sleep 1
  done
  log "no verdict after ${secs}s; inspect $(newest_log || echo '<no log>')"
  return 2
}

# Latest Quick sign-in code from Studio's log: prints "CODE expires-at(UTC) seconds-left".
quick_code() {
  local l line code exp now left
  l=$(newest_log) || { log "no Studio log"; return 2; }
  line=$(grep -E 'QuickSignInUtil\] QR Create' "$l" | tail -1)
  [ -n "$line" ] || { log "Studio has not shown a sign-in code (not on the sign-in page?)"; return 2; }
  code=$(printf '%s' "$line" | sed -n 's/.*"code":"\([A-Z0-9]*\)".*/\1/p')
  exp=$(printf '%s' "$line" | sed -n 's/.*"expirationTime":"\([0-9T:.-]*\)".*/\1/p' | cut -c1-19)
  now=$(date -u +%s); left=$(( $(date -u -d "${exp}Z" +%s) - now ))
  printf '%s %sZ %s\n' "$code" "$exp" "$left"
}

wait_login() {
  local secs="${1:-300}" i
  for i in $(seq 1 "$secs"); do
    if grep -q 'RobloxStudioAuth' "$WINEPREFIX/user.reg" 2>/dev/null; then log "Studio stored a login after ${i}s"; status; return 0; fi
    sleep 1
  done
  log "no login stored after ${secs}s"; return 1
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  status) status ;;
  code) quick_code ;;
  wait) wait_login "${1:-300}" ;;
  ticket)
    place="${1:?PLACE_ID}"; universe="${2:?UNIVERSE_ID}"
    ticket="${STAGEHAND_AUTH_TICKET:-}"
    if [ -z "$ticket" ]; then log "paste the ticket, then Enter:"; IFS= read -r ticket; fi
    [ -n "$ticket" ] || { log "empty ticket"; exit 2; }
    d=$(studio_dir)
    url="roblox-studio:1+launchmode:edit+task:EditPlace+placeId:${place}+universeId:${universe}+gameinfo:${ticket}+launchtime:$(date +%s%3N)+robloxLocale:en_us+gameLocale:en_us"
    log "launching Studio with the edit link (ticket redacted)"
    mkdir -p "$STAGEHAND_STUDIO_LOGS"
    (cd "$d" && nohup wine "$d/RobloxStudioBeta.exe" "$url" >"$STAGEHAND_STUDIO_LOGS/studio-auth.log" 2>&1 &)
    watch_login "${STAGEHAND_AUTH_WAIT:-120}" || true
    status || true
    ;;
  signin)
    # Press Studio's "Sign in" button on the sign-in page and print the OAuth authorize URL it
    # wanted to open (recorded by the xdg-open stub). Open that URL in any browser, sign in, then
    # pass the resulting roblox-studio-auth:/?code=... link to `auth.sh link`.
    pgrep -f RobloxStudioBeta.exe >/dev/null || { log "Studio is not running"; exit 2; }
    urls="$STAGEHAND_STUDIO_LOGS/opened-urls.log"; before=$(wc -l < "$urls" 2>/dev/null || echo 0)
    w=$(xdotool search --name '^Roblox Studio$' | head -1); [ -n "$w" ] || { log "no 'Roblox Studio' window"; exit 2; }
    eval "$(xdotool getwindowgeometry --shell "$w")"
    # The "Sign in" button sits at about (32%, 50%) of the sign-in page.
    xdotool mousemove $((X + WIDTH * 32 / 100)) $((Y + HEIGHT * 50 / 100)) sleep 0.3 click 1
    for _ in $(seq 1 20); do [ "$(wc -l < "$urls" 2>/dev/null || echo 0)" -gt "$before" ] && break; sleep 0.5; done
    [ "$(wc -l < "$urls" 2>/dev/null || echo 0)" -gt "$before" ] || { log "Studio did not open a URL; is it on the sign-in page?"; exit 1; }
    tail -1 "$urls" | cut -d' ' -f2- | grep -q 'oauth/v1/authorize' || { log "unexpected URL: $(tail -1 "$urls")"; exit 1; }
    tail -1 "$urls" | cut -d' ' -f2-
    ;;
  link)
    link="${1:?roblox-studio-auth link}"
    case "$link" in roblox-studio-auth:*) ;; *) log "expected a roblox-studio-auth: link"; exit 2;; esac
    d=$(studio_dir)
    pgrep -f RobloxStudioBeta.exe >/dev/null || log "warning: no Studio running; the link is normally forwarded to the running instance"
    log "forwarding login link to Studio"
    (cd "$d" && nohup wine "$d/RobloxStudioBeta.exe" "$link" >"$STAGEHAND_STUDIO_LOGS/studio-auth-link.log" 2>&1 &)
    wait_login "${STAGEHAND_AUTH_WAIT:-90}" || { l=$(newest_log); log "recent login lines from $l:"; grep -iE 'login|oauth|external' "$l" | tail -8 | cut -c1-240 >&2; exit 1; }
    ;;
  export)
    out="${1:?FILE}"; wine reg export "$CRED_KEY" "$(wine winepath -w "$(realpath -m "$out")")" /y >/dev/null; chmod 600 "$out"; log "exported to $out (secret)";;
  import)
    in="${1:?FILE}"; wine reg import "$(wine winepath -w "$(realpath "$in")")" >/dev/null; status;;
  *) log "unknown command $cmd"; sed -n 2,20p "$0" >&2; exit 2;;
esac
