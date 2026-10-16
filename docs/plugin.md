# Studio plugin

The Stagehand plugin turns every Studio DataModel into a **node** that long-polls the local
`stagehand-mcp` daemon over HTTP and executes steps. You install it once; the daemon launches test sessions
through it.

## Install

**From a release:** download `Stagehand.rbxm` from the GitHub release (or the `Stagehand.rbxm` artifact of
the latest CI run) and drop it into your local plugins folder:

| OS | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Roblox\Plugins` |
| macOS | `~/Documents/Roblox/Plugins` |

Or in Studio: **Plugins → Plugins Folder**, then copy the file there. Restart Studio (or reopen the place).

**From source** (needs [Rojo](https://rojo.space) 7.x; the plugin has no Wally dependencies):

```sh
rojo build plugin --plugin Stagehand.rbxm      # builds straight into the Studio plugins folder
# or: rojo build plugin -o Stagehand.rbxm      # then copy it manually
```

You should see a **Stagehand** toolbar button that opens the dock widget (tests, run button, live log,
last result).

## HTTP permission prompt

The plugin talks to `http://127.0.0.1:38491` (change with the plugin setting `Stagehand.Port` and the
daemon's `STAGEHAND_PORT`). The first time it does so, Studio asks whether the plugin may access that
address. **Allow** it. This permission is per plugin and per address, independent of the game's
`HttpService.HttpEnabled`, so you do not need to enable HTTP in Game Settings.

If you denied it by mistake: **Plugins → Manage Plugins → Stagehand → (edit permissions)** and allow
`127.0.0.1`. Changing the port means a new address and therefore a new prompt. The prompt may appear again
inside a test session window the first time a server or client node connects; allow it there too.

## How nodes map to DataModels

Studio loads plugins again in every DataModel it creates, so one install yields several nodes:

| DataModel | Node role | Detected by | What runs there |
|---|---|---|---|
| Edit (the place you have open) | `edit` | `RunService:IsEdit()` | `edit`-mode steps, `inspect`, launching/ending sessions |
| Test server (Run, Play, Multiplayer) | `server` | `RunService:IsServer()` | server-context steps (the default for most actions/conditions), `EndTest` |
| Each test client (Play: 1, Multiplayer: 2–8) | `client` | `RunService:IsClient()` | client-context steps (`gui.*`, `input.*`, `remote.fire`), with `playerIndex` = actor `pN` |

The edit node writes the session id to the plugin setting `Stagehand.Session` and passes it via
`StudioTestService` test args when it calls `ExecuteRunModeAsync` / `ExecutePlayModeAsync` /
`ExecuteMultiplayerTestAsync(n)`. Server and client nodes read it back and attach to that session. A node
that finds no session id (for example you pressed F5 yourself) attaches as an **orphan** and never receives
steps. See [protocol.md](protocol.md) for the wire details and [writing-tests.md](writing-tests.md) for how
steps are routed to nodes.

## Phase 0 spike checklist

Whether plugin nodes really load in simulated **client** DataModels (and a few other platform facts) must
be confirmed by hand in Studio. Record your results in the
[Phase 0 spike checklist](architecture.md#phase-0-spike-checklist). If client nodes do not load, Stagehand
falls back to an injected client runtime behind the same protocol.

To drive Studio without a desktop (Linux/Wine, Xvfb) see [linux-wine.md](linux-wine.md):
`run-in-roblox --hold --place <place> --plugin Stagehand.rbxm` installs the plugin for the run and
`stagehand-mcp --run <test>` runs playtests from the command line.

## Troubleshooting

**Daemon not found** (dock shows *disconnected*, `stagehand_status` lists no nodes)
- Is your MCP client running `stagehand-mcp`? The daemon only exists while the client has it started.
- Same port on both sides? `STAGEHAND_PORT` (daemon) vs plugin setting `Stagehand.Port`.
- Did you deny the HTTP prompt? Re-allow it (see above).
- Another process on 38491 (or a second daemon from another client window)? Only one daemon can bind;
  close the other client or pick a different port for both.
- Check `curl http://127.0.0.1:38491/v1/health` from a terminal.

**Session stuck** (`launching` forever, or steps time out with `SESSION_ERROR`)
- A modal dialog in Studio (save prompt, update prompt, HTTP permission prompt in the test window) blocks
  the launch; answer it.
- Nodes attached as `orphan`: the session id did not reach the test DataModel. Stop the test, then run
  again from the MCP tool, not with F5.
- Call `stop_session`, or press **Stop** in Studio; the daemon ends idle sessions after 120 s anyway.
- Set `session.reuse: false` on the test while investigating.

**EndTest not tearing down** (windows stay open after a run)
- A known Studio rough edge. The daemon times out the end, then falls back to stopping the session from the
  edit node. If windows still linger, press **Stop** (or close the client windows) manually; the next run
  launches a fresh session.

**Multiplayer focus stealing** (client windows pop to the front, keyboard input goes astray)
- Multiplayer test windows grab focus when they open. Input steps use `VirtualInput` on the target client,
  which does not depend on OS focus, but avoid typing in Studio while a multiplayer run is launching.
- Keep `session.reuse: true` so windows open once per suite rather than once per test, and group
  multiplayer tests together with `run_suite { tag: "multiplayer" }`.

**`UNKNOWN_ACTION game.*`** — the place does not register that hook, or the hooks package is not installed
(in `examples/place` it is mapped by Rojo from `hooks/src` to `ReplicatedStorage.Packages.StagehandHooks`). Run `list_actions { namespace: "game" }` while a session is live.
