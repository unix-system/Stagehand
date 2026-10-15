#!/usr/bin/env bash
# Shared environment for the Linux/Wine Studio tooling. Source this file.
#
#   source tools/studio-wine/env.sh
#
# Everything lives under $STAGEHAND_STUDIO_HOME (default $XDG_DATA_HOME/stagehand-studio):
#   wine/        Kombucha (VinegarHQ's Studio-patched Wine) unpacked, symlink "current"
#   prefix/      the Wine prefix Studio runs in
#   versions/    Roblox Studio deployments, one directory per version GUID
#   cache/       downloaded packages (md5-named) and Wine tarballs
#   logs/        wine / Xvfb / harness logs
#   bin/         helper stubs placed on PATH (xdg-open logger)

export STAGEHAND_STUDIO_HOME="${STAGEHAND_STUDIO_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/stagehand-studio}"
export WINEPREFIX="${WINEPREFIX:-$STAGEHAND_STUDIO_HOME/prefix}"
export STAGEHAND_WINE_ROOT="${STAGEHAND_WINE_ROOT:-$STAGEHAND_STUDIO_HOME/wine/current}"
export STAGEHAND_STUDIO_VERSIONS="$STAGEHAND_STUDIO_HOME/versions"
export STAGEHAND_STUDIO_CACHE="$STAGEHAND_STUDIO_HOME/cache"
export STAGEHAND_STUDIO_LOGS="$STAGEHAND_STUDIO_HOME/logs"
export STAGEHAND_STUDIO_BIN="$STAGEHAND_STUDIO_HOME/bin"

# Prefer the patched Wine if it is unpacked, otherwise whatever `wine` is on PATH.
if [ -x "$STAGEHAND_WINE_ROOT/bin/wine" ]; then
  export PATH="$STAGEHAND_WINE_ROOT/bin:$PATH"
fi
export PATH="$STAGEHAND_STUDIO_BIN:$PATH"

# Quiet Wine (same channels Vinegar silences) unless the caller wants more.
export WINEDEBUG="${WINEDEBUG:-fixme-all,-winediag,-systray,-ole,-ntoskrnl}"
# Pure 64-bit prefix; Studio is 64-bit and Kombucha has no 32-bit support.
export WINEARCH=win64
# Stop winemenubuilder from scribbling .desktop files; mscoree/mshtml are not built anyway.
export WINEDLLOVERRIDES="${WINEDLLOVERRIDES:-winemenubuilder.exe=d;mscoree=d;mshtml=d}"
# Wine's X11 driver wants a runtime dir (otherwise: "XDG_RUNTIME_DIR is invalid or not set").
if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -d "${XDG_RUNTIME_DIR:-/nonexistent}" ]; then
  export XDG_RUNTIME_DIR="/tmp/stagehand-xdg-runtime-$(id -u)"
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
fi
# Kombucha's winex11 does strcmp(getenv("XDG_SESSION_TYPE"), "wayland") at driver init and
# segfaults when the variable is unset (no desktop session here). We are an X11 session.
export XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-x11}"
# Software rendering: no GPU in this environment.
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
export GALLIUM_DRIVER="${GALLIUM_DRIVER:-llvmpipe}"
export MESA_GL_VERSION_OVERRIDE="${MESA_GL_VERSION_OVERRIDE:-4.5}"
export MESA_GLSL_VERSION_OVERRIDE="${MESA_GLSL_VERSION_OVERRIDE:-450}"

# The newest installed Studio deployment (directory containing RobloxStudioBeta.exe), if any.
stagehand_studio_dir() {
  ls -1dt "$STAGEHAND_STUDIO_VERSIONS"/*/ 2>/dev/null | while read -r d; do
    if [ -f "$d/RobloxStudioBeta.exe" ]; then printf '%s\n' "${d%/}"; return; fi
  done
}
