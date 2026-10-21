# Game hooks

Give playtests a small vocabulary for your game: `game.requestSpawn`, `game.inMatch`, or `game.reset`.
Hooks call your real game modules through the optional `StagehandHooks` package and are discovered by the `list_actions` MCP tool while the game is running.

## Install the package

The repository's [sample place](https://github.com/unix-system/Stagehand/tree/main/examples/place) maps `hooks/src` to `ReplicatedStorage.Packages.StagehandHooks` through Rojo. You can use the same mapping in your project, or use the Wally dependency documented in the [package README](https://github.com/unix-system/Stagehand/blob/main/hooks/README.md).

## Register server actions and conditions

Create a server Script such as `ServerScriptService/StagehandBindings.server.luau`. This example assumes your game has a `MatchState` module with `RequestSpawn`, `Reset`, and `active`; adapt those calls to your game.

```lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Hooks = require(ReplicatedStorage.Packages.StagehandHooks)
local MatchState = require(ReplicatedStorage.MatchState)

Hooks.server({
    requestSpawn = {
        actor = "required",
        desc = "Spawn the selected player through the match system",
        run = function(player, params)
            return MatchState:RequestSpawn(player)
        end,
    },
    inMatch = {
        kind = "condition",
        actor = "none",
        desc = "A match is active",
        run = function()
            return MatchState.active
        end,
    },
    reset = {
        actor = "none",
        desc = "Reset the match",
        run = function()
            MatchState:Reset()
        end,
    },
})
```

```yaml
steps:
  - { do: game.requestSpawn, as: p1 }
  - { wait: game.inMatch, timeout: 5s }
```

Register names without the `game.` prefix. Names must start with a letter or underscore and contain only letters, digits, or underscores.

## Actors and parameters

Each callback receives `run(player, params)`. `player` is the selected Player, or `nil` when no actor is supplied; `params` is the step's JSON-compatible parameter map.

| Actor setting | Behavior |
| --- | --- |
| `required` | Uses `p1` automatically in a one-player session; requires an explicit actor with multiple players. |
| `optional` (default) | Receives the selected player, or `nil`. |
| `none` | Declares that the hook does not need a player. |

Add a `params` JSON Schema table to describe parameters to agents. For example, an action accepting an amount can declare:

```lua
params = {
    type = "object",
    properties = { amount = { type = "integer", minimum = 1 } },
    required = { "amount" },
    additionalProperties = false,
}
```

Read it as `params.amount` inside the callback. Avoid names shared with step modifiers (`as`, `on`, `timeout`, `within`, `soft`, `label`, `save`, `if`, `with`). If a hook needs such a parameter, put it under the step's `with` map.

Actions may return a value for the step's `save` field. Conditions return a truthy or falsy value and can be used with `wait` or `expect`; keep them safe to evaluate repeatedly.

## Client hooks

Call `Hooks.client({...})` from a LocalScript for client-side operations. It accepts the same hook definitions as `Hooks.server`. Register after the client modules your callbacks need are ready, and select the player with `as` in the playtest.

Server hooks use the bridge at `ReplicatedStorage.StagehandHooks.Invoke`; client hooks use the local player's `PlayerScripts.StagehandHooks.Invoke`. Let Stagehand discover and route hooks through these bridges.

## Reset a reused session

Register a server action named `reset` with `actor = "none"`, then select the hook reset policy:

```yaml
session:
  mode: play
  players: 1
  reuse: true
  reset: hook
```

When an existing session is reused, Stagehand calls `game.reset`. Make the callback restore the state your next test assumes. See the [session specification](spec.md) for other reset policies.

## Availability and troubleshooting

The package creates its bridges only inside Studio by default. Keep that default for playtesting; `Hooks.enabledInLive` is an explicit opt-in for live games.

If `game.*` is missing, start a session, confirm the bindings Script or LocalScript runs, then call `list_actions` again. A registration error appears in the game's logs. Check module paths and ensure server/client registrations run on the correct side.
