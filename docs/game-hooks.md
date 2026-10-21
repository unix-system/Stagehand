# Game hooks

Game hooks let playtests call functions in your game. Hook names include `game.requestSpawn`, `game.inMatch`, and `game.reset`.
The optional `StagehandHooks` package connects these functions to Stagehand. The `list_actions` MCP tool lists available hooks while the game runs.

## Install the package

The [sample place](https://github.com/unix-system/Stagehand/tree/main/examples/place) uses Rojo to map `hooks/src` to `ReplicatedStorage.Packages.StagehandHooks`.
Use this mapping in your project. Alternatively, use the Wally dependency in the [package README](https://github.com/unix-system/Stagehand/blob/main/hooks/README.md).

## Register server actions and conditions

Create a server Script, for example `ServerScriptService/StagehandBindings.server.luau`.
This example needs a `MatchState` module with `RequestSpawn`, `Reset`, and `active` members.
Replace these calls with the functions and properties in your game.

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

Register names without the `game.` prefix. Start each name with a letter or underscore. Use only letters, digits, and underscores.

## Actors and parameters

Stagehand calls each function as `run(player, params)`. The `player` argument identifies the selected Player. It is `nil` if the step has no actor. The `params` argument contains the step parameters as JSON-compatible values.

| Actor setting | Behavior |
| --- | --- |
| `required` | Uses `p1` automatically in a one-player session; requires an explicit actor with multiple players. |
| `optional` (default) | Receives the selected player, or `nil`. |
| `none` | Declares that the hook does not need a player. |

Use a `params` JSON Schema table to describe parameters to agents. This example defines an integer parameter named `amount`:

```lua
params = {
    type = "object",
    properties = { amount = { type = "integer", minimum = 1 } },
    required = { "amount" },
    additionalProperties = false,
}
```

Read the value from `params.amount` in the callback. Do not use step modifier names for parameters. These names are `as`, `on`, `timeout`, `within`, `soft`, `label`, `save`, `if`, and `with`. If a parameter must use one of these names, put it in the step's `with` map.

An action can return a value for the step's `save` field. A condition returns a truthy or falsy value. Use conditions with `wait` or `expect`. Make sure that repeated condition checks do not change game state.

## Client hooks

For client operations, call `Hooks.client({...})` from a LocalScript. This function accepts the same definitions as `Hooks.server`. Register hooks after their required modules are ready. Set `as` in the playtest to select a player.

Server hooks use the bridge at `ReplicatedStorage.StagehandHooks.Invoke`. Client hooks use `PlayerScripts.StagehandHooks.Invoke` under the local player. Stagehand uses these bridges to find and call hooks.

## Reset a reused session

Register a server action named `reset` with `actor = "none"`. Then set the session reset policy:

```yaml
session:
  mode: play
  players: 1
  reuse: true
  reset: hook
```

When Stagehand reuses a session, it calls `game.reset`. Use this callback to restore the state that the next test needs. See the [session specification](spec.md) for other reset policies.

## Availability and troubleshooting

By default, the package creates bridges only in Studio. Keep this setting for playtests. The `Hooks.enabledInLive` option permits bridges in live games.

If a hook is missing, start a session. Check that the bindings Script or LocalScript runs. Then call `list_actions` again. Check the game logs for registration errors. Check the module paths and the server or client context.