# stagehand-hooks

Optional Wally package that lets a game expose its own actions and conditions to
[Stagehand](../README.md) playtests as `game.<name>` steps. The Stagehand plugin calls hooks through a
`BindableFunction` bridge, so they run with the game's live module state.

```toml
# wally.toml
[dependencies]
StagehandHooks = "stagehand/stagehand-hooks@0.1.0"
```

```lua
-- ServerScriptService/StagehandBindings.server.luau
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Hooks = require(ReplicatedStorage.Packages.StagehandHooks)
local MatchState = require(ReplicatedStorage.MatchState)

Hooks.server({
	requestSpawn = { run = function(player) MatchState:RequestSpawn(player) end, desc = "Request spawn for player" },
	inMatch = { run = function() return MatchState.active end, kind = "condition", desc = "A match is running" },
	reset = { run = function() MatchState:Reset() end, desc = "Reset the round (session.reset: hook)" },
})
```

```yaml
steps:
  - { do: game.requestSpawn, as: p1 }
  - { wait: game.inMatch, timeout: 5s }
```

- A hook is a function or `{ run, desc?, kind? = "action" | "condition", params? }`; `params` is an
  optional JSON Schema object shown to agents by `list_actions`.
- `run(player, params)`: `player` is the step actor's `Player` (or `nil` without `as`); `params` is the
  step's params map (JSON values). Condition hooks return truthy/falsy; action hooks may return a
  value for `save`.
- `Hooks.client({...})` from a LocalScript registers client-side hooks (bridge under
  `PlayerScripts.StagehandHooks.Invoke`); the server bridge is `ReplicatedStorage.StagehandHooks.Invoke`.
- The bridge is created only in Studio unless `Hooks.enabledInLive = true` is set before registering.
