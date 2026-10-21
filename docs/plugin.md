# Studio plugin

The Stagehand plugin creates a node in each Studio DataModel. Each node receives commands from the local `stagehand-mcp` daemon over HTTP.
Install the plugin once. The daemon then uses it to start sessions and run test steps.

## Install

**From a release:** download `Stagehand.rbxm` from a GitHub release or the latest CI artifact.
Copy the file into the local plugins folder:

| OS | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Roblox\Plugins` |
| macOS | `~/Documents/Roblox/Plugins` |

To find this folder in Studio, select **Plugins → Plugins Folder**. After copying the file, restart Studio or reopen the place.

**From source** (needs [Rojo](https://rojo.space) 7.x; the plugin has no Wally dependencies):

```sh
rojo build plugin --plugin Stagehand.rbxm      # builds straight into the Studio plugins folder
# or: rojo build plugin -o Stagehand.rbxm      # then copy it manually
```

The **Stagehand** toolbar button opens the dock widget. The widget contains the test list, run button, logs, and last result.

## HTTP permission prompt

The plugin connects to `http://127.0.0.1:38491`–`38500`.
The `Stagehand.Port` plugin setting and `STAGEHAND_PORT` daemon variable change the range start.
Studio asks for permission to access `127.0.0.1`. Select **Allow**.
This permission applies to the plugin and host. It does not depend on `HttpService.HttpEnabled` in Game Settings.

If access was denied, open **Plugins → Manage Plugins → Stagehand → (edit permissions)**.
Allow access to `127.0.0.1`.
Studio can request this permission again when a server or client node first connects. Allow access in that window also.

Each MCP client runs a daemon on the next available port. Edit nodes attach to each daemon, so every daemon sees open Studio instances.
Test server and client nodes connect only to the daemon that started their session.
Studio runs one test at a time. Another launch fails until the current test ends.

## How nodes map to DataModels

Studio loads plugins in each DataModel. One plugin installation can therefore create several nodes:

| DataModel | Node role | Detected by | What runs there |
|---|---|---|---|
| Edit (the place you have open) | `edit` | `RunService:IsEdit()` | `edit`-mode steps, `inspect`, launching/ending sessions |
| Test server (Run, Play, Multiplayer) | `server` | `RunService:IsServer()` | server-context steps (the default for most actions/conditions), `EndTest` |
| Each test client (Play: 1, Multiplayer: 2–8) | `client` | `RunService:IsClient()` | client-context steps (`gui.*`, `input.*`, `remote.fire`), with `playerIndex` = actor `pN` |

The edit node writes the session ID to `Stagehand.Session`.
It also passes the ID in test arguments through `StudioTestService` when it calls the selected `Execute*Async` method.
Server and client nodes use this ID to attach to the session.
A node without a session ID attaches as an **orphan**. Stagehand does not send test steps to orphan nodes.
See [protocol.md](protocol.md) for communication details and [writing-tests.md](writing-tests.md) for context selection.

## Input visualisation

Each client window displays its `VirtualInput` actions. Play has one client window; multiplayer has one per player.
The `plugin/src/UI/InputOverlay.luau` module draws these indicators in the `StagehandInput` ScreenGui:

- **Cursor:** a 128-pixel arrow uses `rbxasset://textures/Cursors/KeyboardMouse/ArrowFarCursor.png`, displayed at twice its normal size. Its tip follows `SendMousePosition`, with a blue dot below it. The arrow dims after one second without input. It disappears after five seconds.
- **Motion trail:** `input.click` and position-based `input.mouseMove` move the cursor along a short Bézier curve. The curve offset is 3–7% of the straight-line distance and alternates sides. Each trail segment fades after 0.5 seconds. Delta-based movement uses the raw delta without this curve. Movement starts at the current mouse position if it is inside the viewport and below the top bar. Otherwise, it starts at the viewport center. Intermediate samples rejected as CoreGui are skipped. The target position must remain reachable.
- **Click pulse:** each press shows a ring and disc that expand from 10 to 96 pixels. Left clicks use blue, right clicks use amber, and middle clicks use gray. The arrow moves inward on a press. A static ring remains until release.
- **Key strip:** `input.key` and `input.move` display pressed keys at the bottom center. Indicators remain for 0.6 seconds after release. The `input.text` indicator shows the entered text for one second.

The overlay uses `CoreGui` as its parent. If that operation fails, it uses the local player's `PlayerGui`.
Elements have `Active = false`. The ScreenGui has `IgnoreGuiInset = true`, so positions use the same screen coordinates as `VirtualInput`.
The overlay does not intercept input. GUI actions ignore it unless it uses the PlayerGui alternative.
For CoreGui-related click errors, set `INPUT_VISUALS = false` and repeat the test.

To disable these indicators, set `INPUT_VISUALS = false` in `plugin/src/Config.luau`. This option is not a runtime setting.
The `MOUSE_SPEED_PX_S` constant controls cursor speed, with a default of 4000.
Movement duration is limited to 0.06–0.22 seconds, regardless of distance.

A cursor movement uses at most 24 position samples over 0.22 seconds.
Samples above 60 Hz share a frame. A press and release follow in one frame.
At 60 fps, a click adds at most 0.25 seconds to a step. A slower background window can increase this duration.
If drawing fails, the test step continues. The node gives one warning per DataModel.

## Progress widget

The daemon sends progress snapshots to the **Stagehand Progress** dock widget.
The widget code is in `plugin/src/UI/Progress.luau`. The layout code is in `UI/ProgressModel.luau`.
In the edit window, the widget opens on the left when a session starts.
It shows **Starting session** until a snapshot arrives.
Client windows do not open the widget automatically. Select **Progress** in the client window's Stagehand toolbar.
Dock the widget at the required position. Studio restores that position for later tests.

- **Header:** shows the run name, status, progress bar, and results by target. The subtitle identifies the active step.
- **Running step:** shows elapsed time and the time limit, for example `2.4s / 10s`. A bar turns amber after 75% of the limit. Completed steps show their duration.
- **Client windows:** mark local steps with **YOU**. Consecutive steps on other targets appear in a single expandable group. The active or first failed group expands automatically. Select **MINE / ALL** to control grouping. The main window always lists all steps.
- **Labels:** show the step's `label` value. Lua steps without labels show their code. Add a label to each Lua step.

## Phase 0 spike checklist

Check plugin loading in simulated client DataModels manually in Studio.
Record the results in the [Phase 0 checklist](https://github.com/unix-system/Stagehand/blob/main/docs/architecture.md#phase-0-spike-checklist).
If client nodes do not load, Stagehand uses an injected client runtime with the same protocol.

## Troubleshooting

**Daemon not found** (the widget shows *disconnected* or `stagehand_status` lists no nodes)

1. Check that the MCP client runs `stagehand-mcp`.
2. Check the daemon's `STAGEHAND_PORT` and the plugin's `Stagehand.Port` settings.
3. Check localhost access permissions.
4. Check for another process on port 38491.
5. If needed, select an available port range for both the daemon and plugin.
6. Run `curl http://127.0.0.1:38491/v1/health` to check the broker.

**Session does not start** (`launching` persists or a step reports `SESSION_ERROR`)

1. Check for Studio dialogs that require a response.
2. If nodes are marked `orphan`, stop the test. Start it again through the MCP tool instead of F5.
3. Use `stop_session` or Studio's **Stop** button. The daemon also ends sessions after 120 seconds without activity.
4. During investigation, set `session.reuse: false`.

**Test windows remain open**

The daemon tries the edit node if `EndTest` does not finish within the time limit.
If windows remain open, select **Stop** in Studio or close the client windows. The next run starts a new session.

**Multiplayer windows receive keyboard focus**

Client windows receive focus when they open. `VirtualInput` actions target the selected client and do not depend on operating-system focus.
Do not type in Studio while a multiplayer session starts.
Keep `session.reuse: true` to open windows once per suite. Use `run_suite { tag: "multiplayer" }` to group multiplayer tests.

**`UNKNOWN_ACTION game.*`**

The game has not registered the hook, or the hooks package is missing.
The sample place maps `hooks/src` to `ReplicatedStorage.Packages.StagehandHooks` with Rojo.
During an active session, run `list_actions { namespace: "game" }` to check available hooks.