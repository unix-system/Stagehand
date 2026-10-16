# Running Stagehand against real Roblox Studio on Linux (Wine, headless)

Roblox ships Studio for Windows and macOS only. On Linux it runs under Wine, and with a virtual X
display it runs on a headless box (CI runner, cloud container) too. This repo carries everything
needed under `tools/studio-wine/` and a Linux-capable launcher in `tools/run-in-roblox/`.

What this is based on (so you know what to update when it breaks):

- **Vinegar** (VinegarHQ's Studio bootstrapper): the install procedure (version GUID from
  `clientsettings.roblox.com`, package manifest and zips from `setup.rbxcdn.com`, directory map
  read from the installer executable, `AppSettings.xml`, renderer FFlags in `ClientSettings/
  ClientAppSettings.json`) and the **Kombucha** Wine builds patched for Studio
  (`github.com/vinegarhq/kombucha`). We script this directly; Vinegar's GTK app is not used.
- **run-in-roblox** (rojo-rbx): plugin injection and the localhost output relay; forked with a Wine
  backend, see `tools/run-in-roblox/README.md`.

## Setup

```sh
tools/studio-wine/bootstrap.sh            # apt deps, Kombucha Wine, 64-bit prefix, xdg-open stub
python3 -I tools/studio-wine/install_studio.py   # ~600 MB download, 1.2 GB installed
source tools/studio-wine/env.sh           # PATH, WINEPREFIX, display/driver env for every shell
eval "$(tools/studio-wine/xvfb.sh)"       # DISPLAY=:99 (1920x1080, GLX via Mesa llvmpipe)
```

Everything lives under `$XDG_DATA_HOME/stagehand-studio` (`wine/`, `prefix/`, `versions/`, `cache/`,
`logs/`). Studio's own logs are in `prefix/drive_c/users/<user>/AppData/Local/Roblox/logs/`.

Environment details that matter (all set by `env.sh`):

| Variable | Why |
|---|---|
| `XDG_SESSION_TYPE=x11` | Kombucha's winex11 calls `strcmp(getenv("XDG_SESSION_TYPE"), "wayland")` at driver init and segfaults when it is unset. Without it Studio dies with `CreateWindowEx failed` / `RBXCRASH: win ID is 0`. |
| `XDG_RUNTIME_DIR` | Wine warns and some paths misbehave without it. |
| `WINEARCH=win64` | Kombucha is 64-bit only; Studio is 64-bit. |
| `WINEDLLOVERRIDES=winemenubuilder.exe=d;mscoree=d;mshtml=d` | No .desktop files, no Gecko/Mono prompts. |
| `LIBGL_ALWAYS_SOFTWARE=1`, `GALLIUM_DRIVER=llvmpipe`, `MESA_GL_VERSION_OVERRIDE=4.5` | No GPU: Studio renders through Mesa's llvmpipe. Slow (about 100 ms per frame) but fine for tests. |
| registry `HKCU\Software\Wine\Drivers\Graphics=x11` | Never try the Wayland driver. |

The first Wine process of a session decides the graphics driver for the whole prefix session. Never
start Wine without `DISPLAY` and then expect windows later: `wineserver -k` first (bootstrap does).

Renderer: `install_studio.py --renderer opengl|d3d11|d3d11fl10|vulkan` writes the
`FFlagDebugGraphicsPrefer*/Disable*` flags (default OpenGL, which worked here); `--flags-only`
rewrites them for an existing install. `--fflag KEY=VALUE` adds more.

## Signing in

Studio refuses to open even a local place while signed out, and there is no desktop to log in from.
`tools/studio-wine/auth.sh` offers:

1. **Quick sign-in code (easiest).** Start Studio (`run-in-roblox --hold ...` or just
   `wine RobloxStudioBeta.exe`); its sign-in page shows a 6-character code and a QR code, rotating
   every 2 minutes. `auth.sh code` prints the current code and its expiry; type it on your phone's
   Roblox app (*More → Quick Log In*) or at roblox.com (*Quick Log In*), confirm, and Studio logs in.
   `auth.sh wait` returns once the login is stored.
2. **One-time edit ticket.** `auth.sh ticket PLACE_ID UNIVERSE_ID` with the ticket in
   `$STAGEHAND_AUTH_TICKET` (captured from the `authentication-ticket` request the website makes
   when you click *Edit in Studio*; cancel the browser's "open Studio" prompt so your local Studio
   does not consume it).
3. **Browser-login callback.** `auth.sh link 'roblox-studio-auth:/?code=...'` forwards the link the
   website redirects to after *Sign in with browser* (the `xdg-open` stub in `bin/` records the URL
   Studio wanted to open, in `logs/opened-urls.log`).

Studio stores the session in the prefix's Wine Credential Manager
(`HKCU\Software\Wine\Credential Manager\Generic: https://www.roblox.com:RobloxStudioAuth...`).
`auth.sh status` checks it; `auth.sh export FILE` / `import FILE` move it between prefixes (secret!).

WebView2 is **not** installed (Microsoft's CDN is unreachable from here); the sign-in page and local
place editing work without it.

## Running the example playtests

```sh
tools/studio-wine/run-examples.sh                       # run-mode-smoke
tools/studio-wine/run-examples.sh run-mode-smoke blue-team-gun-hostile two-players-spawn
```

The harness builds `build/Stagehand.rbxm` and `build/StagehandExample.rbxl` with rojo, starts
`run-in-roblox --hold` (installs the plugin, opens the place, prints `READY` once the relay plugin
is running), then `stagehand-mcp --root examples --run <name>...`, which waits for the plugin's edit
node, runs each test, prints the reports (`examples/.stagehand/runs/<id>/summary.md`) and exits
0/1/2. Screenshots: `tools/studio-wine/screenshot.sh [out.png]`.

Manual equivalent:

```sh
tools/run-in-roblox/target/release/run-in-roblox --hold --place build/StagehandExample.rbxl \
  --plugin build/Stagehand.rbxm --studio-log &
node packages/mcp/dist/index.js --root examples --run run-mode-smoke
```

Script mode (no Stagehand): `run-in-roblox --place build/StagehandExample.rbxl --script tools/run-in-roblox/demo/hello.lua`.

## Troubleshooting

- `RBXCRASH: win ID is 0` right at startup, `wined3d ... Failed to create a window`: Wine has no
  X11 driver in this session (see `XDG_SESSION_TYPE` above, or a stale display-less `wineserver`).
- Studio exits at once: read `logs/*wine*.log` for `err:` lines and the newest Studio `*_last.log`.
- `kombucha: ntsync is unavailable`: harmless, just slower.
- No sound device (`mmdevapi ... No driver`): harmless.
- Stuck on a modal (HTTP permission for the plugin, save prompt): screenshot, then click with
  `xdotool` (`xdotool search --name "Roblox Studio"`, `xdotool mousemove X Y click 1`).
