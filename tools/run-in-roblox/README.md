# run-in-roblox (Stagehand fork)

Runs a Lua script inside Roblox Studio and pipes Studio's output back to the terminal — or holds
Studio open with extra plugins installed so another tool (the Stagehand daemon) can drive it.

Forked from [rojo-rbx/run-in-roblox](https://github.com/rojo-rbx/run-in-roblox) 0.3.0 (MIT, see
`LICENSE.txt`). Same mechanism and wire protocol: a generated plugin is dropped into Studio's local
plugins folder, Studio is launched on a copy of the place, the plugin posts `/start`, `/messages`
and `/stop` to a localhost HTTP server (port 50312 by default), and the plugin is removed afterwards.

What changed:

- **Linux backend through Wine** (`src/wine.rs`): Studio deployment located under
  `$STAGEHAND_STUDIO_HOME/versions/<guid>` (or Vinegar's `~/.local/share/vinegar/versions`), plugins
  folder resolved from the prefix's `%LOCALAPPDATA%`, place path converted with `winepath`, Studio
  started as `wine RobloxStudioBeta.exe -task EditFile -localPlaceFile <place>` in its own process
  group and killed as a group. Windows/macOS keep the upstream `roblox_install` behaviour.
- `--hold`: no script; prints `READY` once Studio has loaded plugins and stays up until SIGINT/SIGTERM
  (or `--stdin-eof`, or `--timeout`). `--plugin <file>` (repeatable) installs extra `.rbxm`/`.rbxmx`
  plugins for the run.
- `--timeout` (exit 124), `--connect-timeout`, `--studio-log` (tails Studio's own log to stderr),
  `--wine-log`, `--port`, `--studio-dir`, `--wine`, `--wineprefix`, `--plugins-dir`, `--kill-wineserver`.
- Modern dependencies (clap 4, tiny_http, serde); the plugin `.rbxmx` is rendered from a string
  template instead of rbx-dom.

Exit codes: `0` ok, `1` the script produced Error-level output, `2` usage/setup problem, `3` Studio
exited before finishing, `124` timeout.

```sh
cargo build --release
# script mode (prints Studio output, exits when the script returns)
target/release/run-in-roblox --place build/StagehandExample.rbxl --script demo/hello.lua
# hold mode for the Stagehand daemon
target/release/run-in-roblox --hold --place build/StagehandExample.rbxl --plugin build/Stagehand.rbxm --studio-log
```

On Linux source `tools/studio-wine/env.sh` first (Wine, prefix and display settings); see
`docs/linux-wine.md`.
