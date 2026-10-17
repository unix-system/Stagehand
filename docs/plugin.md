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

The plugin talks to `http://127.0.0.1:38491`–`38500` (the plugin setting `Stagehand.Port` and the daemon's
`STAGEHAND_PORT` move the start of that range). The first time it does so, Studio asks whether the plugin
may access `127.0.0.1`. **Allow** it. This permission is per plugin and per host, independent of the
game's `HttpService.HttpEnabled`, so you do not need to enable HTTP in Game Settings.

If you denied it by mistake: **Plugins → Manage Plugins → Stagehand → (edit permissions)** and allow
`127.0.0.1`. The prompt may appear again inside a test session window the first time a server or client
node connects; allow it there too.

Several MCP clients (for example two Claude Code sessions) each run their own daemon on the next free port.
The edit node attaches to all of them, so each client sees every open Studio; a test session's server and
client nodes talk only to the daemon that launched it. Studio runs one test at a time: a second daemon's
launch fails with "Studio is already running a test" until the first one ends.

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

## Input visualisation

Client nodes show what their `VirtualInput` is doing, so a watcher can follow a run in each client window
(Play has one, Multiplayer one per player). Drawn by `plugin/src/UI/InputOverlay.luau` into a `ScreenGui`
named `StagehandInput`:

- **Cursor**: Studio's arrow cursor drawn at 2x (`rbxasset://textures/Cursors/KeyboardMouse/ArrowFarCursor.png`,
  128 px, tip on the position last sent to `SendMousePosition`, with a blue dot under the tip). It is at full
  opacity while moves and clicks keep coming and for 1 s after the last one, then dims, and it is hidden
  after 5 s without input.
- **Motion trail**: `input.click` and `input.mouseMove { position }` no longer teleport the mouse. The
  cursor glides along a short Bézier curve (`plugin/src/Motion.luau`: bowed 3–7 % off the chord, side
  alternating per move, eased in and out) and each sample leaves a thin segment that fades over 0.5 s.
  `input.mouseMove { delta }` sends the raw delta and only moves the cursor. The glide starts from the
  real mouse only when it is inside the viewport and below the top bar (else the viewport centre), and
  samples on the way that VirtualInput rejects as CoreGui are skipped; only the target must be reachable.
- **Click pulse**: each press sends two pulses outwards from the tip (a ring and a soft disc growing
  10→96 px; blue for Left, amber for Right, grey for Middle), presses the arrow in, and keeps a static
  ring until the button is released.
- **Key strip**: key caps along the bottom centre for `input.key` and `input.move` (`W`, `Shift`, `Enter`…),
  lit while held and removed 0.6 s after release; `input.text` shows `⌨ "the text"` for a second.

The overlay is parented to **`CoreGui`** so nothing in the game can cover it or care about it; if that
parenting throws, it falls back to the local player's **`PlayerGui`**. Every element is `Active = false`
and the ScreenGui has `IgnoreGuiInset = true`, so positions are the raw screen pixels `VirtualInput` uses
and the overlay never intercepts the input it draws. `gui.visible`/`gui.click` ignore it because it is not
under `PlayerGui` (unless the fallback was taken). If a click ever fails with a CoreGui-related
`VirtualInput` error, this overlay is the first suspect: set `INPUT_VISUALS = false` and retry.

**Disable it** with `INPUT_VISUALS = false` in `plugin/src/Config.luau` (constants only; there is no
runtime setting yet). `MOUSE_SPEED_PX_S` (default 4000) sets the glide speed; each move is clamped to
0.06–0.22 s regardless of distance.

**Cost**: a glide is at most 24 position samples spread over ≤0.22 s (samples denser than 60 Hz are sent
in the same frame), followed by the one-frame press/release, so at 60 fps a click adds ≤0.25 s to a step
(a background client window rendering slower stretches the glide with it). Drawing
failures are swallowed: the step still runs, and the node warns once per DataModel.

## Progress widget

Every Studio window of a test shows the **Stagehand Progress** dock widget (`plugin/src/UI/Progress.luau`,
layout logic in the unit-tested `UI/ProgressModel.luau`), fed by the daemon's `progress` snapshots. It docks
on the left by default and opens the moment a session launches (edit window) or a test client window loads,
showing a "Starting session" placeholder until the first snapshot arrives:

- **Header**: run name, a status pill that pulses while the run is going, a progress bar, and the
  per-target summary (`SERVER 3/3   P1 2/5`). The subtitle names the step that is running right now.
- **Running step**: its dot pulses, a live counter shows elapsed time against the step's budget
  (`2.4s / 10s`, counted on the window's own clock between snapshots) and a thin bar under the label fills
  toward the budget, turning amber past 75 %. Finished steps keep their duration on the right.
- **Client windows (multiplayer)**: your own steps are tagged **YOU**; every run of consecutive steps that
  execute elsewhere (server, other players) folds into one clickable row — `7 steps on SERVER, P2 · running:
  wait player.onTeam as p2` — with a rolled-up status dot. The group that contains the running step, or the
  first failed one, expands by itself; click a row to toggle it. **MINE / ALL** in the header turns folding
  off for that window. The main window always lists every step.
- **Labels**: a step shows its `label:`; `lua` steps without one show their code (`lua: #game.Players…`),
  which is why validation recommends a label for every lua step.

## Phase 0 spike checklist

Whether plugin nodes really load in simulated **client** DataModels (and a few other platform facts) must
be confirmed by hand in Studio. Record your results in the
[Phase 0 spike checklist](architecture.md#phase-0-spike-checklist). If client nodes do not load, Stagehand
falls back to an injected client runtime behind the same protocol.

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
