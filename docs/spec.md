# Playtest spec (v1)

A playtest is a file at `playtests/<name>.playtest.yaml`. YAML is the standard format; JSON is also accepted.
Stagehand validates the file against `schema/playtest.schema.json`.
It then checks action names, condition names, and parameters against `schema/catalog.json` and available `game.*` hooks.

## Top-level fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string `^[a-z0-9][a-z0-9-]*$` | **required** | id; must match the file name |
| `description` | string | — | |
| `tags` | string[] | `[]` | used by `run_suite` |
| `session.mode` | `edit \| run \| play \| multiplayer` | from `players` | |
| `session.players` | integer 0..8 | `0` (or `1` if mode=play, `2` if mode=multiplayer) | |
| `session.reuse` | boolean | `true` | keep the Studio session alive between runs |
| `session.reset` | `respawn \| hook \| none` | `respawn` | applied before a run in a reused session |
| `timeout` | duration | `60s` | time limit for the complete run (setup + steps + teardown) |
| `failOnError` | boolean | `true` | any `error`-level Output on any node fails the active step |
| `actors` | map name → `{ player: 1..8 }` | `p1..pN` | extra aliases; `p1..pN` always exist |
| `vars` | map name → value | `{}` | referenced as `$name` |
| `fragments` | map name → step[] | `{}` | named step lists for `use:` steps; take priority over shared fragments of the same name (see [Fragments](#fragments)) |
| `setup` | step[] | `[]` | once per session when reused, every run otherwise |
| `steps` | step[] (≥1) | **required** | |
| `teardown` | step[] | `[]` | always runs, even after failure or cancel |

Mode ↔ players (validation errors otherwise):

| mode | players | Studio launch |
|---|---|---|
| `edit` | 0 | none (steps run on the edit node) |
| `run` | 0 | `ExecuteRunModeAsync` |
| `play` | 1 | `ExecutePlayModeAsync` |
| `multiplayer` | 2..8 | `ExecuteMultiplayerTestAsync(players)` |

If `mode` is omitted: 0 → `run`, 1 → `play`, ≥2 → `multiplayer`.
`reset: respawn` = `Player:LoadCharacter()` for every actor + clear captured logs; `hook` = call `game.reset`;
`none` = nothing.

## Steps

Each step is a map with exactly one verb key and optional modifiers.
For `do`, `wait`, and `expect`, other keys are parameters of the named action or condition.

| Verb | Value | Meaning |
|---|---|---|
| `do` | action name | perform; fails if the action errors or exceeds `timeout` |
| `wait` | condition name | block until true; fail at `timeout` |
| `expect` | condition name | assert now; with `within`, poll until true for that long; failure aborts unless `soft` |
| `lua` | string, or `{ code, returns? }` | Lua action. Runs on the resolved node with `actor, player, character, vars` in scope; return value can be `save`d |
| `parallel` | array of branches; a branch is a step list or a single step | branches run concurrently, then join; first non-soft failure cancels the others |
| `each` | `{ actors: [names] \| "all", steps: [...] }` | run `steps` once per actor with `as` bound (sequentially, in listed order) |
| `use` | fragment name | Insert a named step list (`fragments:` in this file, else `playtests/_shared/<name>.fragment.yaml`); modifiers: `as` (actor for steps that name none), `vars` (map substituted into the fragment's steps), `soft`, `label`, `if` |

Use the condition form for Lua conditions: `{ wait: lua, code: "return workspace:GetAttribute('Ready')" }` or `{ expect: lua, code: "…" }`.
A truthy return value means the condition is true. A `lua:` step is always an action.
Add a `label` to each Lua step. Without a label, the display shows `lua: <code…>` and validation gives a warning.

### Modifiers

| Modifier | Type | Applies to | Meaning |
|---|---|---|---|
| `as` | actor name | all | which player the step is about / which client runs it |
| `on` | `edit \| server \| client` | do/wait/expect/lua | override the context |
| `timeout` | duration | do/wait/expect/lua | default `10s`; for `expect` only used with `within` as upper bound |
| `within` | duration | expect | wait-then-assert window; absent = instant |
| `soft` | boolean | all | failure is recorded, run continues |
| `label` | string | all | display name in reports and the Studio progress widget; recommended for every `lua` step |
| `save` | var name | do/lua | store the return value in `vars[save]`; vars are run-wide, so a `save` inside `each` is overwritten by every later actor (the last value remains) — read it inside the same iteration or use distinct names |
| `if` | `"$var"` | all | skip (reported `step.skipped`, reason `if`) when the var is falsy (`nil`, `false`, `0`, `""`) |
| `with` | map | do/wait/expect | params, merged over flat params; **required** for a param whose name is a modifier (`label`, `timeout`, `as`, …), which would otherwise be read as the modifier |

Actions such as `character.moveTo` use the step's `timeout` field. They do not have a separate timeout parameter.
The report shows Lua return values and non-nil action return values, including without `save`.
Use `save` to store the value for later `$name` references.

### Fragments

A fragment is a named step list that `use:` steps can reuse.
Define a local fragment under `fragments:` in the playtest.
To share a fragment, save it as `playtests/_shared/<name>.fragment.yaml` with `{ name, description?, steps }`.
The name must match the file name and use lowercase words separated by hyphens.
A local fragment takes priority over a shared fragment with the same name.
Fragments can contain `use:` steps, with a nesting limit of 8. A fragment cannot reference itself.

```yaml
fragments:
  spawn-via-menu:
    - { do: gui.click, target: "@p1.gui.Menu.Play" }      # `as` comes from the use step
    - { wait: player.onTeam, team: $team, timeout: 30s }
steps:
  - { use: spawn-via-menu, as: p1, vars: { team: Blue } }
  - { use: spawn-via-menu, as: p2, vars: { team: Red }, soft: true }
```

Stagehand expands fragments at compile time. Expanded step IDs use `steps.N.use.<name>.i`.
Steps inherit `as` when they have no actor. They also inherit `soft` from the `use` step.
The `use` step's `vars` replace whole-value `$name` references first.
The `if` field applies to the complete expansion.
Stagehand does not replace fixed actor names in selectors, such as `@p1.gui`. Use a fixed actor only when required.

### Context resolution

1. `on` if present (error if not in the entry's `contexts`).
2. Otherwise the catalog entry's `default`.
3. If `session.mode` is `edit`, `server` resolves to `edit`; a `client`-only step is a validation error.
4. `lua` steps default to `server` (`edit` in edit mode).

Then the target node:

| Context | `as` given | `as` absent |
|---|---|---|
| `client` | that actor's client node | `p1`; error if `players` is 0 |
| `server` | server node; actor bound to its `Player` | server node; no actor |
| `edit` | edit node; actor ignored (warning) | edit node |

Player-specific steps require `as` when `players` is 2 or more. These include `player.*`, `character.*`, `input.*`, and `gui.*`.
With one player, the default actor is `p1`.
Outside edit mode, this default also applies to optional actors in Lua steps and most game hooks.
Thus, a server Lua step can use `player` and `character` in a one-player session.

## Selectors

Params with `format: selector` accept:

| Form | Example | Resolves to |
|---|---|---|
| path | `Workspace.Map.Spawns.Blue`, `game.ReplicatedStorage.Remotes` | instance by `FindFirstChild` walk from `game` |
| actor | `@p1`, `@p1.player` | the actor's `Player` |
| | `@p1.character`, `@p1.character.HumanoidRootPart` | character model / descendant |
| | `@p1.gui.Menu.Spawn` | `PlayerGui.Menu.Spawn` |
| | `@p1.backpack.Gun` | `Backpack.Gun` |
| tag | `tag:Hostile` / `tag:Hostile[]` | first tagged instance / all |
| var | `$target` | value of the var (must be a selector string or Instance path) |
| wildcard | `Workspace.Enemies.*`, `Workspace.**.Spawn` | `*` = any child, `**` = any depth |
| filter | `Workspace.Enemies[Name=Boss]`, `Workspace.*[@Team=Red,Health=100]` | children matching property (or `@attribute`) equality |

A selector that ends with `[]` returns all matches. Otherwise, it returns the first match in depth-first child order.
A condition must be true for all matched instances.
No matches causes `RESOLVE_FAILED`, except for `instance.exists`, which returns false.

```ebnf
selector   = ( var | tag | actor | path ) [ "[]" ] ;
var        = "$" ident ;
tag        = "tag:" tagname ;
actor      = "@" ident [ "." actorroot { "." segment } ] ;
actorroot  = "player" | "character" | "gui" | "backpack" ;
path       = [ "game." ] segment { "." segment } ;
segment    = ( name | "*" | "**" ) [ filter ] ;
filter     = "[" pred { "," pred } "]" ;
pred       = [ "@" ] ident "=" literal ;
name       = ident | "'" { any char except "'" } "'" ;
ident      = ( letter | "_" ) { letter | digit | "_" } ;
tagname    = { any char except "[" } ;
literal    = number | "true" | "false" | { any char except "," | "]" } ;
```

Put quotation marks around names that contain spaces or dots: `Workspace.'Blue Spawn'`.
Filter values recognize numbers and `true` or `false`. Other filter values are strings.

## Values

The catalog parameter schema controls value conversion. Values without a specified type remain JSON values.

| YAML value | Param schema | Roblox value |
|---|---|---|
| `[x, y, z]` | vector3 / any | `Vector3` |
| `{ pos: [x,y,z], look: [x,y,z] }` | any | `CFrame.lookAt(pos, pos + look)` |
| `"#rrggbb"` | any | `Color3` |
| `"Enum.Material.Neon"` | any | `EnumItem` |
| `"10s"`, `"250ms"`, `"1.5m"`, or a number | `format: duration` | seconds (number); bare numbers are seconds |
| `"@p1.character"`, `"tag:X"`, path | `format: selector` | `Instance` (or list for `[]`) |
| `"$name"` | any | value of `vars.name` (whole-value only; no interpolation inside strings) |
| anything else | any | unchanged (string, number, boolean, null, map, list) |

Duration grammar: `^\d+(\.\d+)?(ms|s|m)$`.
`op` ∈ `eq ne gt gte lt lte contains matches` (`matches` = Lua pattern; `contains` = substring or list
membership).

## Examples

### 1. One character (Play)

```yaml
name: blue-team-gun-hostile
description: Blue spawn → equip gun → Hostile tag appears
tags: [smoke, combat]
session: { mode: play, players: 1 }
vars:
  spawn: [120, 5, -40]
steps:
  - { do: player.setTeam,      as: p1, team: Blue }
  - { do: game.requestSpawn,   as: p1 }
  - { wait: character.loaded,  as: p1, timeout: 10s }
  - { do: character.teleport,  as: p1, to: $spawn }
  - { do: character.equipTool, as: p1, tool: Gun }
  - { expect: instance.hasTag, target: "@p1.character", tag: Hostile, within: 2s }
teardown:
  - { do: character.unequip, as: p1, soft: true }
```

### 2. No characters (Run)

```yaml
name: night-mode-toggle
tags: [smoke]
session: { players: 0 }          # → mode: run
steps:
  - { do: instance.set, target: Lighting, prop: ClockTime, value: 0 }
  - { expect: instance.property, target: Lighting, prop: ClockTime, op: eq, value: 0 }
  - { do: instance.setAttribute, target: Workspace.Map, name: Night, value: true }
  - { wait: instance.hasTag, target: "Workspace.Map.Lamps.*[]", tag: Lit, timeout: 3s }
  - { lua: "return #game:GetService('CollectionService'):GetTagged('Lit')", label: count lamps, save: lit }
  - { expect: lua, code: "return vars.lit > 0" }
  - { expect: log.noErrors }
```

### 3. Two players (Multiplayer, `each` + `parallel`)

```yaml
name: two-player-teams
tags: [multiplayer]
session: { players: 2, reset: respawn }
actors:
  blue: { player: 1 }
  red:  { player: 2 }
steps:
  - { do: player.setTeam, as: blue, team: Blue }
  - { do: player.setTeam, as: red,  team: Red }
  - each:
      actors: [p1, p2]
      steps:
        - { do: player.respawn }
        - { wait: character.loaded, timeout: 15s }
        - { expect: character.alive }
  - parallel:
      - - { do: character.jump, as: p1 }
        - { wait: character.near, as: p1, to: [0, 5, 0], radius: 50 }
      - - { do: input.move, as: p2, direction: [0, 0, -1], duration: 1s }
  - { expect: player.count, op: eq, value: 2 }
  - { expect: player.onTeam, as: red, team: Red }
  - { expect: gui.visible, as: p2, target: "@p2.gui.TeamBadge", within: 2s }
```
