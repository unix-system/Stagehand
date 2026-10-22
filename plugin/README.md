# Stagehand plugin

Roblox Studio plugin that turns every DataModel Studio opens into a **node** of the local
`stagehand-mcp` daemon: the edit DataModel launches test sessions and shows a dock, the play-session
server and client DataModels execute playtest steps. Contracts: [`docs/protocol.md`](../docs/protocol.md)
(broker ↔ node), [`docs/spec.md`](../docs/spec.md) (selectors, values), [`schema/catalog.json`](../schema/catalog.json)
(actions and conditions).

## Build

```sh
rokit install                          # or install rojo/lune/selene/stylua manually
rojo build plugin -o Stagehand.rbxm    # from the repo root
```

The project (`default.project.json`) builds one `Script` named `Stagehand` whose children are the
modules in `src/`.

## Install

Copy `Stagehand.rbxm` into the Studio plugins folder (Studio: *Plugins → Plugins Folder*), or
`rojo build plugin --plugin Stagehand.rbxm` to write it there directly. Restart Studio or reload plugins. A
**Stagehand** toolbar button toggles the dock.

## First run: HTTP permission

The plugin talks to `http://127.0.0.1:45491` (the daemon broker). On the first request Studio asks
whether *Stagehand* may access `127.0.0.1`: choose **Allow**. This is independent of the game's
`HttpService.HttpEnabled`. If you denied it, re-enable it under *Plugins → Manage Plugins →
Stagehand → Permissions*. Until the daemon is running the dock shows *connecting* and the node
retries with backoff (0.5 s … 10 s).

## How nodes attach

| DataModel | Detected by | Role | sessionId |
|---|---|---|---|
| Edit | `RunService:IsEdit()` | `edit` | always `null` |
| Play server | `RunService:IsServer()` | `server` | `StudioTestService:GetTestArgs().stagehand.sessionId`, else plugin setting `Stagehand.Session` |
| Play client | `RunService:IsClient()` | `client` | same as server |

1. Each node `POST /v1/attach`es, emits `node.ready` (with a sha1 `catalogHash`) and long-polls
   `GET /v1/poll` (25 s). Commands run in their own threads; `cancel` and `ping` are handled while a
   segment is running. Events are batched every 50 ms and flushed immediately on step end.
2. `launch_session` (edit node) writes `Stagehand.Session`, then calls
   `ExecuteRunModeAsync` / `ExecutePlayModeAsync` / `ExecuteMultiplayerTestAsync(players, args)` with
   `args = { stagehand = { sessionId, port, mode, players } }`. Run mode simulates inside the edit
   DataModel, so the edit plugin instance also hosts that session's server node.
3. The server node emits `session.ready` once the expected players have joined and loaded characters
   (players from the test args; otherwise after 1.5 s without joins).
4. A `410` from the broker makes the node re-attach (seq restarts at 1; unsent events are kept).

Port: test args `stagehand.port`, else plugin setting `Stagehand.Port`, else `45491`. Keep the
daemon on the default unless you must change it (`STAGEHAND_PORT`); the edit node forwards its port
into every session it launches.

## Layout

| Path | Purpose |
|---|---|
| `src/init.server.luau` | role detection, node start, dock (edit) |
| `src/Node.luau`, `src/Transport/Http.luau` | protocol loop over `HttpService:RequestAsync` |
| `src/Transport/Remote.luau` | fallback relay through the server node (`Config.USE_REMOTE_RELAY`) for an injected client runtime |
| `src/Runner.luau` | segment execution: timeouts, `within`, `soft`, `save`, `if`, cancel |
| `src/Resolve.luau`, `src/Conditions.luau` | selectors + value coercion; comparisons + signal-first waits |
| `src/Registry.luau`, `src/Actions/*` | catalog entries (`meta` + `run`), live `game.*` hooks |
| `src/Launcher.luau`, `src/LogCapture.luau`, `src/UI/Dock.luau` | sessions, Output capture, dock |

Actions modules declare metas with the pure helpers in `src/Meta.luau` and only touch Roblox APIs
inside `run`, so `tools/gen-catalog.luau` and the tests load them under Lune.

## Tests and checks

```sh
lune run plugin/tests/run.luau        # Resolve, Conditions, Registry, Runner, Node (stub DataModel)
lune run tools/gen-catalog.luau       # CI: fails if schema/catalog.json drifts from the Actions metas
selene plugin/src && stylua --check plugin/src tools hooks/src
```

`gen-catalog`: no args = write a temp copy and compare with `schema/catalog.json` (exit 1 on drift);
`<path>` / `--out <path>` = write there (CI: `schema/catalog.json` then `git diff --exit-code`);
`--stdout`; `--write` = overwrite the committed file for an intentional catalog change.

## Troubleshooting

- **Dock says "connecting … HttpService is not allowed"**: allow the localhost permission (above).
- **Dock says "connecting … ConnectFail"**: the daemon is not running or uses another port.
- **Server/client node attaches as orphan**: `GetTestArgs()` was unreadable and `Stagehand.Session`
  was not set; launch sessions through the daemon (`start_session` / `run_test`), not F5.
- **Client steps never run**: check the client node attached (`stagehand_status`). If plugins do not
  load in simulated clients, enable `USE_REMOTE_RELAY` in `src/Config.luau` and inject the node as a
  LocalScript (fallback path, skeleton only).
- **`input.*` fails with "VirtualInput:Send… failed"**: the client could not create or drive
  `UserInputService:CreateVirtualInput()` (one instance per node, documented signatures, see
  `src/Actions/Input.luau`); check that the step runs on a client node and the Studio version supports it.
- **Session does not end**: `end_session` calls `StudioTestService:EndTest` from the server node and
  falls back to `RunService:Stop()` from the edit node.
