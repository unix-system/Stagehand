# Writing playtests

A practical guide for people and agents. The formal rules live in [spec.md](spec.md); the action and
condition list lives in [`schema/catalog.json`](../schema/catalog.json) (or the `list_actions` MCP tool).
Every example here runs against the sample game in [`examples/place`](../examples/place) and the specs in
[`examples/playtests`](../examples/playtests).

## Mental model: do, wait, expect

A playtest is a list of steps. Each step has exactly one **verb**:

| Verb | Think of it as | Fails when |
|---|---|---|
| `do: <action>` | "make this happen" | the action throws or exceeds `timeout` (default 10s) |
| `wait: <condition>` | "block until this is true" | still false at `timeout` |
| `expect: <condition>` | "this must be true now" (or within `within`) | false; aborts the run unless `soft: true` |
| `lua: <code>` | escape hatch action | the code errors |
| `parallel:` / `each:` | run steps concurrently / once per actor | any non-soft branch fails |

Write tests the way a player experiences the game: put the world in a state (`do`), let the game react
(`wait`), then check the outcome (`expect`). Prefer `wait` over fixed sleeps, and `expect … within: 2s` for
"this should happen shortly".

```yaml
- { do: character.equipTool, as: p1, tool: Gun }                                   # act
- { expect: instance.hasTag, target: "@p1.character", tag: Hostile, within: 2s }   # react + assert
```

Everything that is not the verb or a modifier (`as`, `on`, `timeout`, `within`, `soft`, `label`, `save`,
`if`, `with`) is a parameter of the action or condition. If a parameter name collides with a modifier, put
it under `with: { … }`.

## Where does a step run? (context rules in plain words)

You never write RemoteEvents to cross the client/server boundary; Stagehand picks the node for you.

1. If the step says `on: server | client | edit`, that wins (it must be allowed for that entry).
2. Otherwise the catalog **default** applies. Almost everything defaults to the **server**, because the
   server is the source of truth. Only things that only exist on a client (`gui.*`, `input.*`,
   `remote.fire`/`remote.invoke`) default to the client.
3. `as: p2` says *which player the step is about*. For a client step it picks p2's client window; for a
   server step it runs on the server with p2's `Player` bound.
4. In `edit` mode there are no clients: server steps run in the edit DataModel and client-only steps are a
   validation error.
5. `lua` steps run on the server unless you say `on: client`.

Five routing examples (Play or Multiplayer session):

| Step | Runs on | Why |
|---|---|---|
| `{ do: player.setTeam, as: p1, team: Blue }` | server, p1's Player | catalog default `server` |
| `{ do: gui.click, as: p2, target: "@p2.gui.SpawnGui.SpawnButton" }` | p2's client | `gui.*` is client-only |
| `{ do: character.teleport, as: p1, to: [0, 5, 0], on: client }` | p1's client | explicit `on` wins |
| `{ expect: instance.hasTag, target: "@p1.character", tag: Hostile }` | server | conditions default to server |
| `{ lua: "return workspace.DistributedGameTime" }` | server, no actor | `lua` defaults to server |

Steps about a player (`player.*`, `character.*`, `input.*`, `gui.*`) need `as` once there are 2+ players;
with one player `as` defaults to `p1`. Consecutive steps on the same node are batched into one round trip,
so switching nodes is the only thing that costs latency.

## Selectors cheat sheet

Any parameter documented as `format: selector` (usually `target`) accepts:

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

A trailing `[]` returns every match; conditions over many matches must hold for **all** of them. Quote
selectors that start with `@` or contain `[`/`*` in YAML: `target: "@p1.character"`.

## Values cheat sheet

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
  non-soft failure cancels the other branches. Use it for things that must overlap in time (two players
  equipping at once), not as a speed-up.

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

See [`two-players-spawn.playtest.yaml`](../examples/playtests/two-players-spawn.playtest.yaml).

## Session reuse and reset

Launching Play takes seconds, so by default (`session.reuse: true`) the Studio session stays alive between
runs of tests with the same mode and player count, and `setup:` runs once per session. Before every run in
a reused session, `session.reset` puts the world back:

| `reset` | Does | Use when |
|---|---|---|
| `respawn` (default) | `LoadCharacter()` for every actor, clear captured logs | the game has no global state worth resetting |
| `hook` | calls your `game.reset` hook | the game has match state, teams, rounds |
| `none` | nothing | the test deliberately builds on the previous run |

If a test passes alone but fails after another test, the reset is not resetting enough: register a
`game.reset` hook and use `reset: hook`, or set `reuse: false` for that test. `teardown:` always runs (even
after failure or cancel); mark cleanup steps `soft: true` so they never mask the real failure.

## Debugging a failed step from the report

Each run writes `.stagehand/runs/<timestamp>-<name>/` with an NDJSON event log, a JSON result, and a
Markdown summary (`get_run` / `stagehand://runs/latest` return the same data). Step ids are paths into the
spec, zero-based: `steps.5` is the sixth step, `steps.2.each.p2.1` the second step of p2's `each` pass,
`steps.4.parallel.1.0` the first step of the second parallel branch.

A failure looks like this (from `failing-example`):

```json
{ "type": "step.failed", "stepId": "steps.3",
  "reason": "condition instance.hasTag not true within 1s",
  "expected": { "target": "Workspace.Player1", "tag": "Champion", "value": true },
  "actual": { "value": false, "tags": [] },
  "error": { "code": "ASSERTION_FAILED", "message": "…" } }
```

Read it in this order:

1. **`error.code`** tells you the kind of failure: `ASSERTION_FAILED` (the game did not do it),
   `TIMEOUT` (a `wait` or action ran out of time), `RESOLVE_FAILED` (selector or actor did not resolve —
   usually a typo or a path that only exists on another node), `BAD_PARAMS`, `UNKNOWN_ACTION` (missing
   `game.*` hook or a typo), `ACTION_ERROR` / `LUA_ERROR` (code threw).
2. **`expected` vs `actual`** shows the resolved target and the observed state.
3. **`log` events** with the same `stepId` show Output lines from every node captured during the step.
   With `failOnError: true` an `error`-level line on any node fails the active step even if the
   assertion would have passed.
4. Re-run just the failing slice with `run_steps` (it reuses the session), add `soft: true` to the
   `expect` to see later steps, or insert a `lua` step that `return`s the state you are unsure about.

Steps after a hard failure are reported `skipped` with reason `aborted`; teardown still runs.

## Game hooks vs `lua`

| Use a **game hook** (`game.*`) when | Use **`lua`** when |
|---|---|
| the test needs game logic (spawn, start a round, reset a match) | you need a one-off probe or setup tweak |
| the logic lives in game modules with state | the code is three lines and not reused |
| you want agents to discover it via `list_actions` (hooks carry `desc`) | you are exploring before writing a hook |
| it should keep working as the game's internals change | |

Hooks run inside the game's own module state (the plugin calls them through a BindableFunction), so
`require` sees the same tables the game uses. A `lua` step runs in plugin identity, where `require` of a
game module returns a *separate* copy. The example place registers hooks in
[`StagehandBindings.server.luau`](../examples/place/src/server/StagehandBindings.server.luau):

```lua
Hooks.server({
	requestSpawn = { desc = "Spawn the player at their team's SpawnLocation", run = function(player) SpawnService.request(player) end },
	reset = { run = function() SpawnService.reset() end },
	hasSpawned = { kind = "condition", run = function(player) return SpawnService.hasSpawned(player) end },
})
```

Server hooks receive `(player, params)`; `player` is the `as` actor's Player (or nil). Condition hooks
work with `wait:` and `expect:`; `lua` conditions use `{ expect: lua, code: "return …" }`, where the code
sees `actor`, `player`, `character` and `vars`.

## Anti-patterns

- **Sleeping instead of waiting.** `session.wait: 2s` followed by `expect` is flaky and slow; use
  `wait: <condition>` or `expect … within:`.
- **Firing remotes to fake client behaviour.** If the player clicks a button, use `gui.click`; if you
  must skip the UI, call the same server code via a `game.*` hook. `remote.fire` is for testing the remote
  itself.
- **Asserting on the client what the server owns.** Tags, teams, health are server truth; leave
  conditions on their server default unless you are testing replication (then assert both).
- **Missing `as` in multiplayer.** Validation rejects it, but aliases like `blue`/`red` make intent clear.
- **Hard-coded instance names for players** (`Workspace.Player1`). Use `@p1.character`.
- **Teardown that can fail the run.** Make cleanup `soft: true`.
- **Giant `lua` blocks.** If a `lua` step is more than a few lines, it is a hook waiting to be written.
- **Tests that depend on order.** Each test must pass alone and after any other; fix `reset` instead.
- **Over-wide selectors.** `Workspace.**.Handle` matches more than you think; prefer explicit paths or
  tags.

## Agent workflow

1. `inspect` the place (`inspect { path: "Teams" }`, `inspect { tag: "Hostile" }`,
   `inspect { class: "RemoteEvent" }`) and `list_actions` to learn real paths and available hooks.
2. Draft the YAML.
3. `validate_test` — fixes schema errors, unknown actions, bad params, missing `as`.
4. `run_steps` with the draft steps to try them live without saving.
5. `save_test`, then `run_test` (and `run_suite` by tag) to confirm. See [mcp.md](mcp.md).
