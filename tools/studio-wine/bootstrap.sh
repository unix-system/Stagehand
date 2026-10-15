#!/usr/bin/env bash
# Install everything needed to run Roblox Studio headlessly on this Linux box:
#   1. apt packages: Wine runtime libraries, Xvfb tooling, screenshot tools, mingw (for helper exes)
#   2. Kombucha: VinegarHQ's Wine build patched for Roblox Studio (64-bit only), from GitHub releases
#   3. a fresh 64-bit Wine prefix, initialised headless
#   4. the xdg-open stub that records URLs Studio asks Wine to open (used by the browser-login flow)
#
# Idempotent: re-running skips what is already there. Needs root (or sudo) for apt.
#
#   KOMBUCHA_TAG=stable+20261009201837 tools/studio-wine/bootstrap.sh
#   SKIP_APT=1 tools/studio-wine/bootstrap.sh            # when packages are already installed
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$here/env.sh"

KOMBUCHA_TAG="${KOMBUCHA_TAG:-stable+20261009201837}"
KOMBUCHA_URL="${KOMBUCHA_URL:-https://github.com/vinegarhq/kombucha/releases/download/${KOMBUCHA_TAG}/kombucha-${KOMBUCHA_TAG}.tar.xz}"

log() { printf '[bootstrap] %s\n' "$*" >&2; }
SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo

mkdir -p "$STAGEHAND_STUDIO_HOME"/{wine,cache,logs,bin,versions}

# ---------------------------------------------------------------- 1. apt
if [ -z "${SKIP_APT:-}" ]; then
  log "installing apt packages"
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -qq
  # Runtime counterparts of the -dev packages Kombucha is built against, plus tooling.
  $SUDO apt-get install -y -qq --no-install-recommends \
    libfreetype6 libfontconfig1 libgnutls30t64 libunwind8 libudev1 libsdl2-2.0-0 \
    libpulse0 libv4l-0t64 libwayland-client0 libwayland-egl1 libxkbcommon0 libxkbregistry0 \
    libx11-6 libxext6 libxrandr2 libxi6 libxcursor1 libxcomposite1 libxfixes3 libxrender1 libxinerama1 \
    libgl1 libegl1 libgl1-mesa-dri mesa-vulkan-drivers libvulkan1 mesa-utils \
    xvfb x11-utils x11-apps xdotool scrot imagemagick \
    gcc-mingw-w64-x86-64 unzip xz-utils curl ca-certificates fonts-liberation fonts-dejavu-core
fi

# ---------------------------------------------------------------- 2. Kombucha
dest="$STAGEHAND_STUDIO_HOME/wine/kombucha-${KOMBUCHA_TAG}"
if [ -x "$dest/bin/wine" ]; then
  log "kombucha ${KOMBUCHA_TAG} already unpacked"
else
  tarball="$STAGEHAND_STUDIO_CACHE/kombucha-${KOMBUCHA_TAG}.tar.xz"
  if [ ! -s "$tarball" ]; then
    log "downloading ${KOMBUCHA_URL}"
    curl -fL --retry 3 --retry-delay 2 -o "$tarball.part" "$KOMBUCHA_URL"
    mv "$tarball.part" "$tarball"
  fi
  log "unpacking kombucha"
  tar -xJf "$tarball" -C "$STAGEHAND_STUDIO_HOME/wine"
  [ -x "$dest/bin/wine" ] || { log "unexpected tarball layout under $STAGEHAND_STUDIO_HOME/wine"; exit 1; }
fi
ln -sfn "kombucha-${KOMBUCHA_TAG}" "$STAGEHAND_STUDIO_HOME/wine/current"
export PATH="$STAGEHAND_WINE_ROOT/bin:$PATH"
log "wine: $(wine --version)"

# ---------------------------------------------------------------- 3. prefix
if [ -f "$WINEPREFIX/system.reg" ]; then
  log "prefix exists at $WINEPREFIX"
else
  log "initialising prefix at $WINEPREFIX (headless)"
  mkdir -p "$WINEPREFIX"
  DISPLAY= WAYLAND_DISPLAY= WINEBOOT_HIDE_DIALOG=1 wineboot --init >"$STAGEHAND_STUDIO_LOGS/wineboot.log" 2>&1
  wineserver -w || true
fi
# Always use the X11 driver (never Wayland) and a Windows 10 identity.
wine reg add 'HKCU\Software\Wine\Drivers' /v Graphics /t REG_SZ /d x11 /f >/dev/null 2>&1 || true
wine reg add 'HKCU\Software\Wine' /v Version /t REG_SZ /d win10 /f >/dev/null 2>&1 || true

# ---------------------------------------------------------------- 4. xdg-open stub
cat > "$STAGEHAND_STUDIO_BIN/xdg-open" <<'STUB'
#!/usr/bin/env bash
# Stub browser: Wine's winebrowser calls this when Studio wants to open a URL (e.g. "Log in with
# browser"). We cannot open a browser here, so record the URL for the operator instead.
log="${STAGEHAND_STUDIO_HOME:-$HOME/.local/share/stagehand-studio}/logs/opened-urls.log"
mkdir -p "$(dirname "$log")"
printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$log"
exit 0
STUB
chmod +x "$STAGEHAND_STUDIO_BIN/xdg-open"
wine reg add 'HKCU\Software\Wine\WineBrowser' /v Browsers /t REG_SZ /d xdg-open /f >/dev/null 2>&1 || true

# Shut the prefix down. The first Wine process of a session fixes the graphics driver for
# everything that follows; these headless commands must not leave a display-less explorer around.
wineserver -k 2>/dev/null || true
wineserver -w 2>/dev/null || true

log "done. Next: python3 -I tools/studio-wine/install_studio.py"
