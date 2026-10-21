# Writing playtests

This guide explains how to write playtests. See [spec.md](spec.md) for the format rules.
See the [action reference](reference/index.md) or use `list_actions` for available actions and conditions.
The examples use the [sample game](https://github.com/unix-system/Stagehand/tree/main/examples/place) and [example tests](https://github.com/unix-system/Stagehand/tree/main/examples/playtests).

## Step types {#mental-model-do-wait-expect}

A playtest is a list of steps. Each step has exactly one **verb**:

| Verb | Function | Failure condition |
|---|---|---|
| `do: <action>` | Do an action | the action throws or exceeds `timeout` (default 10s) |
| `wait: <condition>` | Wait until the condition is true | still false at `timeout` |
| `expect: <condition>` | Compare the condition now, or until the `within` time limit | false; aborts the run unless `soft: true` |
| `lua: <code>` | run Lua code | the code errors |
| `parallel:` / `each:` | run steps at the same time / once per actor | any non-soft branch fails |

Use `do` to change game state. Use `wait` to wait for a condition. Use `expect` to compare the actual result with the expected result. Use `wait` instead of a fixed delay. To give time for a result, use `expect` with `within`.

```yaml
- { do: character.equipTool, as: p1, tool: Gun }                                   # act
- { expect: instance.hasTag, target: "@p1.character", tag: Hostile, within: 2s }   # react + assert
```

A step contains a verb, optional modifiers, and action or condition parameters.
The modifiers are `as`, `on`, `timeout`, `within`, `soft`, `label`, `save`, `if`, and `with`.
If a parameter has the same name as a modifier, put it under `with: { … }`.
Validation reports a missing required parameter if a modifier uses its name.

## Label your steps

The `label` field identifies a step in reports, `step.*` events, and the Studio progress widget.
Add a label to each `lua` step. Without a label, the display shows `lua: <first line of code…>` and validation gives a warning.

Labels also help identify repeated actions. For example, use `label: open the shop` and `label: buy the sword`.
Labels are display text. Stagehand does not use them to match steps.

## Reuse steps with fragments

Use a fragment when two or more tests need the same steps. Use `use:` to select the fragment. Changes to the fragment then apply to each test:

```yaml
# playtests/_shared/spawn-via-menu.fragment.yaml
name: spawn-via-menu
steps:
  - { do: gui.click, target: "@p1.gui.Menu.Play" }
  - { wait: player.onTeam, team: $team, timeout: 30s }
```

```yaml
steps:
  - { use: spawn-via-menu, as: p1, vars: { team: Blue } }
```

The `as` field supplies an actor to fragment steps that do not specify one. The `vars` field replaces references such as `$team`.
The `soft` and `if` fields apply to all steps in the fragment.
Expanded step IDs have this format: `steps.0.use.spawn-via-menu.1`.
A test's `fragments` map defines fragments for that file only. The `list_tests` tool lists shared fragments.

## Step context {#where-does-a-step-run-context-rules-in-plain-words}

Stagehand selects a node for each step. You do not need RemoteEvents to send test steps between the client and server.

1. If the step specifies `on`, Stagehand uses that context. The catalog entry must permit the context.
2. Otherwise, Stagehand uses the catalog default. Most entries use the server. The `gui.*`, `input.*`, `remote.fire`, and `remote.invoke` entries use the client.
3. The `as` field selects a player. Client steps run on that player's client. Server steps use that player's `Player` object.
4. In edit mode, server steps run in the edit DataModel. Validation rejects steps that need a client.
5. A `lua` step uses the server unless it specifies a different context.

Five routing examples (Play or Multiplayer session):

| Step | Runs on | Why |
|---|---|---|
| `{ do: player.setTeam, as: p1, team: Blue }` | server, p1's Player | catalog default `server` |
| `{ do: gui.click, as: p2, target: "@p2.gui.SpawnGui.SpawnButton" }` | p2's client | `gui.*` is client-only |
| `{ do: character.teleport, as: p1, to: [0, 5, 0], on: client }` | p1's client | the step specifies `on` |
| `{ expect: instance.hasTag, target: "@p1.character", tag: Hostile }` | server | conditions default to server |
| `{ lua: "return workspace.DistributedGameTime" }` | server, no actor | `lua` defaults to server |

Player-specific steps need `as` when the session has two or more players. With one player, the default actor is `p1`.
Stagehand groups consecutive steps for the same node into one request. Changes between nodes need more requests.

## Selector reference {#selectors-cheat-sheet}

A parameter with `format: selector` (usually `target`) accepts these forms:

| You write | You get |
|---|---|
| `Workspace.Map.Spawns.Blue`, `game.ReplicatedStorage.Remotes` | path walk from `game` |
| `Workspace.'Blue Spawn'` | quoted name (spaces or dots) |
| `@p1` / `@p1.player` | p1's `Player` |
| `@p1.character`, `@p1.character.HumanoidRootPart` | character / descendant |
| `@p1.gui.SpawnGui.SpawnButton` | `PlayerGui.SpawnGui.SpawnButton` |
| `@p1.backpack.Gun` | `Backpack.Gun` |
| `tag:Hostile` / `tag:Hostile[]` | first tagged instance / all of them |
| `Workspace.Enemies.*`, `Workspace.**.Spawn` | any child / any depth |
| `Workspace.Enemies[Name=Boss]`, `Workspace.*[@Team=Red,Health=100]` | property / `@attribute` filter |
| `$target` | a selector stored in a var |

A selector that ends with `[]` returns all matches. A condition must be true for all matched instances.
In YAML, put quotation marks around selectors that start with `@` or contain `[` or `*`.

## Value reference {#values-cheat-sheet}

| YAML | Becomes |
|---|---|
| `[120, 5, -40]` | `Vector3` |
| `{ pos: [0, 5, 0], look: [0, 0, -1] }` | `CFrame.lookAt(pos, pos + look)` |
| `"#ff3300"` | `Color3` |
| `"Enum.Material.Neon"` | `EnumItem` |
| `250ms`, `10s`, `1.5m`, `3` | seconds (for duration params) |
| `$spawn` | the var's value (whole value only; no `"x-$spawn"` interpolation) |
| anything else | passed through unchanged |

Comparison conditions take `op` ∈ `eq ne gt gte lt lte contains matches` (`matches` is a Lua pattern).

## Actors and multiplayer

- `session.players: N` creates actors `p1..pN` (N = 0 → Run mode, 1 → Play, 2–8 → Multiplayer).
- `actors:` adds readable aliases: `blue: { player: 1 }` makes `as: blue` the same as `as: p1`.
- `each: { actors: [p1, p2], steps: [...] }` repeats steps with `as` bound to each actor, in order. Use
  `actors: all` for every player.
- `parallel:` runs branches at the same time and joins; a branch is one step or a list. The first
  non-soft failure cancels the other branches. Use it when actions must occur at the same time, such as two players who equip tools together.

```yaml
session: { players: 2 }
actors: { blue: { player: 1 }, red: { player: 2 } }
steps:
  - { do: player.setTeam, as: blue, team: Blue }
  - { do: player.setTeam, as: red,  team: Red }
  - each: { actors: [p1, p2], steps: [ { do: game.requestSpawn }, { wait: character.loaded, timeout: 15s } ] }
  - parallel:
      - { do: character.equipTool, as: p1, tool: Gun }
      - { do: character.equipTool, as: p2, tool: Gun }
```

See [`two-players-spawn.playtest.yaml`](https://github.com/unix-system/Stagehand/blob/main/examples/playtests/two-players-spawn.playtest.yaml).

## Session reuse and reset

By default, `session.reuse: true` keeps a Studio session open between tests with the same mode and player count.
Stagehand runs `setup` once per reused session. Before each subsequent run, `session.reset` restores game state:

| `reset` | Does | Use when |
|---|---|---|
| `respawn` (default) | `LoadCharacter()` for every actor, clear captured logs | the next test does not need a reset of global game state |
| `hook` | calls your `game.reset` hook | the game has match state, teams, rounds |
| `none` | nothing | the test needs the state from the previous run |

If a test fails only after a different test, examine the reset procedure.
Use a `game.reset` hook with `reset: hook` to restore the necessary state. As an alternative, set `reuse: false` for that test.
Stagehand always runs `teardown`, including after a failure or cancellation. Set cleanup steps to `soft: true` to preserve the original failure.

## Find the cause of a failed step {#debugging-a-failed-step-from-the-report}

Each run saves files in `.stagehand/runs/<timestamp>-<name>/`. These files contain an NDJSON event log, a JSON result, and a Markdown summary.
The `get_run` tool and `stagehand://runs/latest` resource return the same data.
Step IDs use zero-based indexes. For example, `steps.5` identifies the sixth step.
The ID `steps.2.each.p2.1` identifies the second step in the `each` sequence for `p2`.
The ID `steps.4.parallel.1.0` identifies the first step of the second parallel branch.

A failure looks like this (from `failing-example`):

```json
{ "type": "step.failed", "stepId": "steps.3",
  "reason": "condition instance.hasTag not true within 1s",
  "expected": { "target": "Workspace.Player1", "tag": "Champion", "value": true },
  "actual": { "value": false, "tags": [] },
  "error": { "code": "ASSERTION_FAILED", "message": "…" } }
```

Read it in this order:

1. Read `error.code` to identify the failure type. See the [error codes](protocol.md#error-object) for their meanings.
2. Compare `expected` and `actual` to find the difference in state.
3. Read log events with the same `stepId`. With `failOnError: true`, an error log from any session node fails the active step.
4. Read `hint`, if present. A failed immediate check can need `within: 2s` to give time for replication or deferred handlers. An attribute set only on a client can need `on: client`.
5. Use `run_steps` to repeat the failed steps. Without session settings, this tool reuses the current session. Set an expectation to `soft: true` to continue after failure. Use a labeled `lua` step to return state values when necessary. The report shows return values without a `save` field.

After a non-soft failure, Stagehand marks later steps `skipped` with reason `aborted`. Teardown still runs.
By default, `run_test` and `run_steps` return after 90 seconds, even if the run continues.
Use the returned `runId` with `get_run` or `tail_run` to read subsequent results.

Roblox reserves Escape and other menu keys. These keys do not reach the game through `input.key`.
Use a menu button or game hook to close a menu.
A server condition cannot read attributes set only on a client. Use `on: client` to examine those attributes.

## Game hooks vs `lua`

| Use a **game hook** (`game.*`) when | Use **`lua`** when |
|---|---|
| the test needs game logic (spawn, start a round, reset a match) | you need a single diagnostic check or setup change |
| the operation uses state in game modules | the code is three lines and not reused |
| you want agents to find it through `list_actions` (hooks include `desc`) | you need to examine game state before you write a hook |
| the game's implementation can change, but the test must stay the same | |

Hooks use the game's module state through a BindableFunction. A hook's `require` call returns the same module tables that the game uses.
A `lua` step runs under plugin identity. Its `require` call returns a separate copy of a game module.
The sample place registers hooks in [StagehandBindings.server.luau](https://github.com/unix-system/Stagehand/blob/main/examples/place/src/server/StagehandBindings.server.luau):

```lua
Hooks.server({
	requestSpawn = { desc = "Spawn the player at their team's SpawnLocation", run = function(player) SpawnService.request(player) end },
	reset = { run = function() SpawnService.reset() end },
	hasSpawned = { kind = "condition", run = function(player) return SpawnService.hasSpawned(player) end },
})
```

Server hooks receive `(player, params)`. The `player` argument is the actor's Player, or `nil` when there is no actor.
For a hook that needs a player, set `actor = "required"`. Stagehand then supplies `p1` in a one-player session.
With two or more players, validation rejects a step without `as`.
Use condition hooks with `wait` or `expect`. For a Lua condition, use `{ expect: lua, code: "return …" }`.
Lua conditions can access `actor`, `player`, `character`, and `vars`.
Do not use modifier names for hook parameters. If necessary, pass these parameters under `with`.

## Test design rules {#anti-patterns}

- Use `wait` or `expect` with `within` instead of a fixed delay.
- Use `gui.click` for a test of a button interaction. Use `remote.fire` for a test of the remote itself.
- Examine server-owned state on the server. For replication tests, examine both the server and client.
- Set `as` for player-specific steps in multiplayer tests.
- Use actor selectors such as `@p1.character` instead of fixed player instance names.
- Set cleanup steps to `soft: true`.
- Move long or repeated Lua operations into game hooks.
- Add a label to each `lua` step.
- Use fragments for steps shared by two or more tests.
- Put hook parameters that share a modifier name under `with`.
- Make each test independent of test order. Reset the necessary state before the test.
- Use exact paths or tags to prevent incorrect selector matches.

## Agent workflow

1. Use `stagehand_status` to examine the connection.
2. Use `inspect` to find instance paths.
3. Use `list_actions` to find actions and hooks.
4. Write the YAML test.
5. Use `validate_test` to find format and parameter errors.
6. Correct the reported errors.
7. Use `run_steps` to run unsaved steps.
8. Use `save_test` to save the test.
9. Use `run_test` to run the saved test. See [MCP tools](mcp.md).
