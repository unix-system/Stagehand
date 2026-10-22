# Stagehand architecture

## Context

The `unix-system/Stagehand` repo is empty. The goal is a framework where a playtest is written as a short
declarative list of **actions**, **waits** and **expectations**, saved alongside the game, and run on demand
(or ad hoc, unsaved) inside Roblox Studio with live step-by-step reporting. It must be driven by coding
agents through an **MCP server**, backed by a **Studio plugin**, and must run steps on the **server and on
one or many clients** without the author thinking about where a step executes. Priorities: fast tests and
near-zero-code definitions.

Target example (one character):

```yaml
name: blue-team-gun-hostile
session: { mode: play, players: 1 }
steps:
  - { do: player.setTeam,      as: p1, team: Blue }
  - { do: game.requestSpawn,   as: p1 }                       # game-defined hook
  - { wait: character.loaded,  as: p1, timeout: 10s }
  - { do: character.teleport,  as: p1, to: [120, 5, -40] }
  - { do: character.equipTool, as: p1, tool: Gun }
  - { expect: instance.hasTag, target: "@p1.character", tag: Hostile, within: 2s }
```

Decisions already made with the user: daemon in **TypeScript/Node**, canonical spec format **YAML** (JSON
accepted), Roblox toolchain **Rojo + Wally + Lune**.

## Platform facts the design rests on (verified Oct 2026)

| Fact | Consequence |
|---|---|
| `StudioTestService` (plugin security) has `ExecuteRunModeAsync(args)`, `ExecutePlayModeAsync(args)`, `ExecuteMultiplayerTestAsync(n, args)` (≤8 clients), `AddPlayers(n)`, `GetTestArgs()`, `EndTest(result)`, `LeaveTest()`. Execute* yields until `EndTest`. | Sessions with 0 / 1 / N characters are launched programmatically. `args` carries the run id into the session. No OS-level F5 hacks. |
| Plugins load again inside play-session DataModels. Roblox's own (archived) MCP plugin classifies with `IsEdit()` → Edit, `IsServer()` → Server, `IsClient()` → Client, and runs a stop-monitor in the **server** DataModel that calls `EndTest`. | Each DataModel can host a "node" of our plugin that talks to the local daemon directly. No script injection needed for server/edit. Client DataModels: expected to work the same, **must be confirmed in Phase 0**. |
| `UserInputService:CreateVirtualInput()` → `VirtualInput` (`SendKey`, `SendMouseButton`, `SendMousePosition`, `SendMouseDelta`, `SendTextInput`), security None, errors if it would hit CoreGui. | Real input simulation from the client node without privileged APIs. |
| Plugins may call `HttpService` against `localhost` (one-time per-address permission prompt, independent of the game's HttpEnabled). The official plugin long-polled `http://localhost:44755`. | Localhost HTTP long-poll is the node ↔ daemon transport. |
| Roblox's OpenGameEval runner proves the injection-based alternative (server Script + StarterPlayerScripts LocalScript, RemoteEvents for results, `EndTest` to return). Staff state per-client control in multiplayer tests is "a gap". | We keep an **injected-runtime fallback** behind the same node protocol in case plugin nodes do not load in simulated clients. |
| Known rough edges: `EndTest` occasionally not tearing down; multiplayer windows steal focus; `AddPlayers` bug report on macOS. | Daemon owns session lifecycle with timeouts and a `RunService:Stop()`-from-edit fallback; session reuse keeps launches rare. |

## Architecture

```
 Agent (Claude Code / Cursor)                     Roblox Studio
 ┌──────────────┐  stdio/MCP   ┌───────────────┐  localhost HTTP  ┌──────────────────────────────┐
 │  MCP client  │◄────────────►│ stagehand-mcp │◄────────────────►│ Plugin node: EDIT DataModel  │ launches sessions,
 └──────────────┘              │  (Node/TS)    │   long-poll      │ UI dock, catalog              │ edit-mode steps
                               │  ├ MCP server │◄────────────────►│ Plugin node: SERVER DataModel│ server steps, EndTest
                               │  ├ Broker     │◄────────────────►│ Plugin node: CLIENT #1       │ client steps, VirtualInput
                               │  ├ Engine     │◄────────────────►│ Plugin node: CLIENT #N       │
                               │  ├ Stores     │                  └──────────────────────────────┘
                               └───────────────┘                   ▲ optional: game's StagehandHooks module
                                   ▲ files                         │ (BindableFunction bridge → game.* actions)
                     playtests/*.playtest.yaml, .stagehand/runs/*.json
```

Three deliverables:

1. **`stagehand-mcp`** (TypeScript, `packages/mcp`): MCP server over stdio + local HTTP **broker** on
   `127.0.0.1:45491` (configurable) + **engine** (compile spec → plan → dispatch segments → report) +
   **stores** (tests on disk, run history).
2. **`stagehand-plugin`** (Luau, Rojo → `Stagehand.rbxm`, `plugin/`): one plugin, one entry script. On load
   it detects its DataModel kind and becomes an **edit**, **server** or **client** node. Edit node also shows
   the dock UI (test list, run, live log) and owns `StudioTestService` launches.
3. **`stagehand-hooks`** (Luau, Wally package, `hooks/`): tiny optional module a game requires to expose
   named, game-specific actions/conditions (`game.requestSpawn`, `game.reset`, `game.inMatch`…).

The orchestrator lives in the daemon (single source of truth, trivial MCP streaming, cross-process clients
are just more nodes). Efficiency comes from **segment batching** (consecutive same-node steps ship as one
command, waits run node-locally) and **session reuse** (one Studio session serves many tests).

## Test spec (YAML, JSON-Schema validated)

```yaml
name: blue-team-gun-hostile            # id; file is playtests/blue-team-gun-hostile.playtest.yaml
description: Blue spawn → equip gun → Hostile tag appears
tags: [smoke, combat]
session:
  mode: play                           # edit | run | play | multiplayer   (default from players)
  players: 1                           # 0 → run (no characters), 1 → play, 2..8 → multiplayer
  reuse: true                          # keep the Studio session alive between runs (default true)
  reset: respawn                       # respawn | hook | none — what to do before a run in a reused session
timeout: 60s                           # whole-run budget
failOnError: true                      # any Output error on any node fails the active step
actors:                                # optional; p1..pN auto-defined from players
  p1: { player: 1 }
vars:
  spawn: [120, 5, -40]
setup: [ ... ]                         # same step grammar; runs once per session when reused
steps:
  - { do: player.setTeam,      as: p1, team: Blue }
  - { do: game.requestSpawn,   as: p1 }
  - { wait: character.loaded,  as: p1, timeout: 10s }
  - { do: character.teleport,  as: p1, to: $spawn }
  - { do: character.equipTool, as: p1, tool: Gun }
  - { expect: instance.hasTag, target: "@p1.character", tag: Hostile, within: 2s }
teardown: [ ... ]                      # always runs, even on failure
```

**Step grammar** — exactly one verb per step, plus optional modifiers:

| Verb | Meaning |
|---|---|
| `do: <action>` | perform an action; fails if the action errors |
| `wait: <condition>` | block until condition true or `timeout` (default 10s) |
| `expect: <condition>` | assert now; with `within: 5s` behaves as wait-then-assert; failure aborts unless `soft: true` |
| `parallel: [steps]` | run sub-lists concurrently (different actors/nodes), join |
| `each: { actors: [p1,p2], steps: [...] }` | fan the same steps over actors with `as` bound |
| `lua: "<code>"` | escape hatch; runs in plugin identity on the resolved node with `actor/player/character/vars` in scope; flagged as a code step in reports |

Modifiers: `as` (actor), `on` (`server` / `client` / `edit` override), `timeout`, `within`, `soft`,
`label`, `save: name` (store the action's return value in `vars`), `if: $var` (skip when falsy).

**Context resolution (the "seamless" part)** — every catalog entry declares the contexts it supports and a
default. Rule: explicit `on` wins; otherwise the catalog default; `as` picks *which* client node for client
steps and resolves to the `Player` instance for server steps. Conditions default to the **server** (source of
truth) unless `on: client` or the condition is client-only (`gui.visible`, `input.*`). Authors never write
RemoteEvents to cross the boundary; the engine routes.

**Selectors** — `Workspace.Map.Spawns.Blue`, `@p1.character`, `@p1.player`, `@p1.gui.Menu.Spawn`
(PlayerGui), `@p1.backpack.Gun`, `$var`, `tag:Hostile` (first match; `tag:Hostile[]` for all),
`*` / `**` path wildcards, `Workspace.Enemies[Name=Boss]` attribute/property filters.

**Values** — `[x,y,z]` → Vector3; `{pos:[..], look:[..]}` → CFrame; `"#ff0000"` → Color3;
`"Enum.Material.Neon"` → EnumItem; `10s` / `250ms` durations; everything else passes through.

## Execution model

1. **Load & validate** (`spec/loader.ts`, `spec/schema.ts`): YAML/JSON → zod schema → unknown actions or
   bad params fail before anything launches. Catalog comes from `schema/catalog.json` (generated from the
   Luau action metas) merged with the **live** catalog from attached nodes (adds `game.*` hooks).
2. **Compile** (`engine/compile.ts`): resolve actors, contexts, selectors (syntax only), durations → a
   **plan**: list of **segments**, each `{ nodeRole: server | client#i | edit, steps[] }`. Consecutive steps
   on the same node merge into one segment. `parallel` produces a fork/join node in the plan.
3. **Session** (`engine/sessions.ts`): ensure a session matching `{mode, players}` exists. If none, send
   `launch_session` to the edit node, which calls the matching `StudioTestService:Execute*Async` in a
   coroutine with `args = { stagehand = { sessionId, port } }` and reports back. Wait until the required
   nodes attach (server + N clients) and each client has a character or is explicitly characterless. With
   `reuse`, a matching live session is reused after applying `reset` (`respawn` = `LoadCharacter()` for
   actors + clear captured logs; `hook` = call `game.reset`). Idle sessions end after 120s (configurable).
4. **Dispatch** (`engine/run.ts`): segments go to nodes via the broker command queue; the node's `Runner`
   executes steps sequentially and streams `step.started/passed/failed` + log events; the segment result
   returns; next segment. Waits are **signal-first** on the node (`CollectionService:GetInstanceAddedSignal`,
   `GetAttributeChangedSignal`, `GetPropertyChangedSignal`, `ChildAdded`, `CharacterAdded`, `PlayerAdded`),
   falling back to Heartbeat polling (≤60 Hz) for predicates that have no signal. Timeouts are enforced on
   the node and again in the daemon (node timeout + 2s).
5. **Failure** — a failing step cancels in-flight segments on all nodes, runs `teardown`, and the run
   finishes `failed` with `{ step, reason, expected, actual, node, logsAround }`. Output errors captured via
   `LogService.MessageOut` on every node are attributed to the active step.
6. **Report** (`engine/reporter.ts`): NDJSON event log + final JSON + Markdown summary stored under
   `.stagehand/runs/<timestamp>-<name>/`. During the MCP call, events surface as `notifications/progress`
   and `logging` messages so the agent sees steps as they pass.

## Node protocol (broker ↔ plugin)

HTTP, JSON, localhost only, 25s long-poll. Nodes identify by `{ role, placeId, placeName, sessionId,
playerName, userId, pluginVersion }`; `sessionId` comes from `StudioTestService:GetTestArgs()` inside a
session (fallback channel if that is not readable from plugin context: `plugin:SetSetting` written by the
edit node before launch, as the official plugin did for its stop flag).

| Endpoint | Direction | Purpose |
|---|---|---|
| `POST /v1/attach` | node → broker | register; returns `nodeId` |
| `GET  /v1/poll?node=` | node → broker | long-poll for the next command |
| `POST /v1/result` | node → broker | command result (segment done, eval output, catalog, inspect data) |
| `POST /v1/events` | node → broker | batched step/log events (flushed every 50ms or on step end) |
| `GET  /v1/health` | anyone | daemon status, attached nodes |

Commands: `run_segment`, `cancel`, `catalog`, `inspect`, `eval`, `launch_session` (edit), `end_session`
(server → `EndTest`; edit fallback → `RunService:Stop()`), `add_players` (server), `ping`.
Edit and server nodes use `Transport/Http.luau`. Client nodes use `Transport/Remote.luau` (RemoteFunction
relay through the server node): in a Studio play client, HttpService errors "Http requests can only be
executed by game server" even from plugin code.

## Catalog (initial actions & conditions)

One Luau file per namespace under `plugin/src/Actions/`; each export is `{ name, kind = "action" |
"condition", contexts, default, params, run }`. A Lune script emits `schema/catalog.json` so the daemon can
validate offline; the live node adds `game.*` entries. The MCP `list_actions` tool renders this with param
schemas, so agents author tests without reading source.

| Namespace | Actions | Conditions |
|---|---|---|
| `session` | `wait(duration)`, `addPlayers(n)`, `disconnect(as)` | — |
| `player` | `setTeam`, `respawn`, `setAttribute`, `giveTool`, `setLeaderstat` | `onTeam`, `count`, `exists`, `attribute` |
| `character` | `teleport(to)`, `moveTo(to, timeout)`, `jump`, `equipTool`, `unequip`, `setHealth`, `kill` | `loaded`, `alive`, `dead`, `near(to, radius)`, `hasTool`, `health(op, value)` |
| `input` (client) | `key(code, hold?)`, `click(target or position)`, `mouseMove`, `text`, `move(direction, duration)` | — |
| `gui` (client) | `click(target)`, `setText(target, text)` | `visible(target)`, `text(target, op, value)` |
| `remote` | `fire(name, args)` client→server, `invoke(name, args)`, `fireClient(name, as, args)` | — |
| `instance` | `set(target, prop, value)`, `setAttribute`, `addTag`, `removeTag`, `destroy`, `clone(target, parent)`, `call(target, method, args)` | `exists`, `hasTag`, `property(target, prop, op, value)`, `attribute(...)`, `childCount(op, n)` |
| `log` | — | `matches(pattern)`, `noErrors` |
| `game` | whatever `StagehandHooks.server{…}` / `.client{…}` registered | hooks returning booleans are usable in `wait`/`expect` |
| `lua` | `lua:` step | `lua:` returning boolean |

`op` ∈ `eq ne gt gte lt lte contains matches`.

## Game hooks (`hooks/`, Wally package `stagehand-hooks`)

```lua
-- ServerScriptService/StagehandBindings.server.luau (game-owned, optional)
local Hooks = require(ReplicatedStorage.Packages.StagehandHooks)
Hooks.server({
  requestSpawn = { run = function(player) SpawnService:Request(player) end, desc = "Request spawn for player" },
  inMatch      = { run = function() return MatchState.active end, kind = "condition" },
  reset        = { run = function() MatchState:Reset() end },
})
```

The module creates `ReplicatedStorage/StagehandHooks/Invoke` (BindableFunction) on the server and a
per-client bindable on clients; the plugin node invokes through it, so hooks run with the **game's live
module state** (plugin `require` would otherwise get a separate module instance). Hooks ship with
descriptions so `list_actions` documents them for agents.

## MCP surface (`packages/mcp/src/server/`)

Tools: `stagehand_status`, `list_actions`, `inspect(path | tag | class, depth)` (lets agents discover
remotes, teams, tools, GUI paths), `validate_test(spec | name)`, `run_steps(steps, session?)` (ad hoc,
unsaved), `run_test(name, wait=true, timeout)`, `run_suite(tag | names)`, `get_run(id)`, `tail_run(id,
afterSeq)`, `cancel_run(id)`, `list_tests`, `get_test`, `save_test(name, spec)`, `delete_test`,
`start_session(mode, players)`, `stop_session`, `eval_lua(code, on, as)` (guarded; off unless
`--allow-eval`).
Resources: `stagehand://catalog`, `stagehand://tests/{name}`, `stagehand://runs/latest`.
Prompt: `write_playtest` (template that instructs an agent to `inspect`, draft YAML, `validate_test`,
`run_steps`, then `save_test`).

## Repo layout

```
Stagehand/
  package.json  pnpm-workspace.yaml  tsconfig.base.json
  packages/mcp/                 # stagehand-mcp (bin: stagehand-mcp)
    src/index.ts                # stdio entry; starts broker
    src/server/{tools,resources,prompts}.ts
    src/broker/{http,nodes,protocol}.ts
    src/engine/{compile,plan,run,sessions,reporter}.ts
    src/spec/{schema,loader,catalog,selectors,values}.ts
    src/store/{tests,runs}.ts
    test/                       # vitest: compile, routing, selectors, fake-node broker tests
  plugin/                       # Rojo project → Stagehand.rbxm
    default.project.json  wally.toml  selene.toml  stylua.toml
    src/init.server.luau        # detect DataModel kind, start node (+UI in edit)
    src/{Node,Runner,Resolve,Conditions,Registry,Launcher,LogCapture}.luau
    src/Transport/{Http,Remote}.luau
    src/Actions/{Session,Player,Character,Input,Gui,Remote,Instance,Log,GameHooks,Lua}.luau
    src/UI/                     # dock widget
    tests/                      # Lune tests for Resolve/Conditions/Registry with a fake DataModel
  hooks/                        # stagehand-hooks Wally package
  schema/{playtest.schema.json,catalog.json}   # generated + committed
  tools/gen-catalog.luau        # Lune: Actions metas → schema/catalog.json
  examples/place/               # Rojo sample game: Teams, spawn remote, Gun tool, Hostile tagger
  examples/playtests/*.playtest.yaml
  docs/{architecture,spec,writing-tests,mcp,plugin}.md
  .github/workflows/ci.yml     # pnpm test, lune test, selene/stylua, rojo build artifact
```

## Implementation phases

**Phase 0 — spikes (throwaway plugin, half a day).** Confirm in Studio, record results in
`docs/architecture.md`: (a) plugin instance runs in server DataModel for `ExecuteRunModeAsync` and
`ExecutePlayModeAsync`; (b) plugin instance runs in **client** DataModels for Play and
`ExecuteMultiplayerTestAsync(2)`; (c) `StudioTestService:GetTestArgs()` readable from plugin context in
those DataModels; (d) `HttpService:RequestAsync` to localhost from plugin in each DataModel, note the
permission prompt; (e) `VirtualInput` from plugin context in a client DataModel moves the character;
(f) `EndTest` from the server node ends all windows; measure launch latency for run / play / 2-player.
Outcome gates the fallback: if (b) fails, enable `Transport/Remote` + injected client runtime in Phase 2.

**Phase 1 — vertical slice.** Workspace scaffold; `packages/mcp` with stdio MCP, broker, node registry,
`stagehand_status`, `run_steps` supporting `lua`, `instance.*`, `wait`/`expect`, event streaming,
JSON report; plugin with `init`, `Node`, `Transport/Http`, `Runner`, `Launcher` for `run` mode (0 players).
Done when an agent can run `[{ do: instance.set, ... }, { expect: instance.property, ... }]` in Run mode
and see per-step progress.

**Phase 2 — spec & engine.** YAML loader, zod schema → `schema/playtest.schema.json`, compiler with
segments/actors/selectors/values, `play` and `multiplayer` sessions, session reuse + reset, test store,
run store, all list/get/save/validate tools, `inspect`, Markdown summary. Fallback transport if Phase 0
demanded it.

**Phase 3 — action library & example.** Full catalog table above, `LogCapture` + `failOnError`,
`stagehand-hooks` package, Lune catalog generator, `examples/place` (Blue/Red teams, `RequestSpawn`
RemoteEvent, `Gun` tool, server script that tags equipped characters `Hostile`) and the target
`blue-team-gun-hostile` playtest passing end to end.

**Phase 4 — multi-actor & polish.** `parallel`, `each`, `session.addPlayers/disconnect`, `run_suite`,
dock UI (tests, run button, live log, last result), docs, CI, release workflow publishing
`Stagehand.rbxm` and the npm package.

## Execution approach (per user)

- Implementation is delegated to **Opus 5.5 sub-agents** with tight, self-contained briefs; the lead
  session only writes briefs, integrates, commits and pushes. Optimise for cost: no redundant reads,
  parallel agents own disjoint directories, one integration pass at the end.
- Order: (1) contracts + scaffold agent (already drafted, writes on approval) → (2) three parallel agents:
  `packages/mcp`, `plugin/ + hooks/ + tools/`, `examples/ + docs/writing-tests.md` → (3) one
  integration/review agent runs vitest, type-checks, lints and fixes → lead commits and pushes.
- Container has node 22 / pnpm 10 / cargo; **no lune, rojo, wally, selene, stylua**. Agents may install
  them via cargo or GitHub releases if the network allows; otherwise Luau tests are written but reported
  as not executed here, and Phase 0 Studio spikes remain a user-side checklist in `docs/architecture.md`.

## Verification

- `pnpm test` (vitest): compile routing for every catalog default, selector parsing, segment merging,
  broker with a fake node exercising attach/poll/result/timeout/cancel.
- `lune run tests` for `Resolve`, `Conditions`, `Registry` against a stubbed DataModel; `selene` + `stylua`.
- `tools/gen-catalog.luau` output is committed; CI fails if regenerating changes it.
- Manual end to end in Studio with `examples/place`: open place, start `stagehand-mcp` via the MCP
  Inspector, `stagehand_status` shows the edit node, `run_test blue-team-gun-hostile` launches Play Solo,
  streams six step events, returns `passed`, and a second run reuses the session (launch skipped, visible
  in the report timings). Then `players: 2` variant with `each` over `p1,p2`, and a `players: 0` smoke
  test in Run mode. Break the Hostile tagger and confirm the failure report names step 6 with the expected
  vs actual tag state and the captured log lines.

## Risks and open questions

- **Plugin not loading in simulated clients** → covered by injected-runtime fallback (same protocol).
- **`EndTest` not tearing down / stray sessions** → daemon-side session timeout, `RunService:Stop()`
  fallback from the edit node, and `stop_session` tool; `stagehand_status` always reports live nodes.
- **`GetTestArgs` from plugin context** → fallback to plugin settings handshake.
- **Multiplayer launch cost (~10–20s, windows steal focus)** → session reuse is on by default; suites are
  grouped by `{mode, players}` so a suite launches each topology at most once.
- **Plugin `require` of game modules gets separate state** → documented; `game.*` hooks are the supported
  path to live state.
- **Security of `lua`/`eval_lua`** → localhost-only broker, eval disabled by default, code steps marked in
  reports.

## References

- StudioTestService reference: https://create.roblox.com/docs/en-us/reference/engine/classes/StudioTestService
- Introducing StudioTestService: https://devforum.roblox.com/t/introducing-studiotestservice/4116257
- New Studio Testing APIs (multiplayer, VirtualInput): https://devforum.roblox.com/t/new-studio-testing-apis-and-assistant-improvements/4657854
- VirtualInput reference: https://create.roblox.com/docs/en-us/reference/engine/classes/VirtualInput
- Studio testing modes: https://create.roblox.com/docs/studio/testing-modes
- Roblox studio-rust-mcp-server (archived; DataModelType, GameStopUtil, RunScriptInPlayMode): https://github.com/Roblox/studio-rust-mcp-server
- OpenGameEval Eval Runner user guide (injection pattern): https://github.com/Roblox/open-game-eval/blob/main/EvalPlugin/USER_GUIDE.md
- rodeo (CLI-first Studio automation, prior art): https://github.com/rodeo-rbx/rodeo
- HttpService docs (plugin localhost access, permission prompt): https://create.roblox.com/docs/en-us/cloud-services/http-service

## Phase 0 spike checklist

Record results here (Studio version, OS, date). Gate: if (b) fails, enable `Transport/Remote` + injected client runtime.

- [ ] **(a)** Plugin instance runs in the **server** DataModel for `ExecuteRunModeAsync` and `ExecutePlayModeAsync`.
  - Result:
  - Notes:
- [ ] **(b)** Plugin instance runs in **client** DataModels for Play and `ExecuteMultiplayerTestAsync(2)`.
  - Result:
  - Notes:
- [ ] **(c)** `StudioTestService:GetTestArgs()` readable from plugin context in server and client DataModels.
  - Result:
  - Notes:
- [ ] **(d)** `HttpService:RequestAsync` to `http://127.0.0.1:45491` from the plugin in each DataModel (note permission prompt behaviour per DataModel).
  - Result:
  - Notes:
- [ ] **(e)** `UserInputService:CreateVirtualInput()` from plugin context in a client DataModel moves the character.
  - Result:
  - Notes:
- [ ] **(f)** `EndTest` from the server node ends all windows; launch latency measured.
  - Result:
  - Notes:
- [ ] **(g)** Input overlay (`StagehandInput` ScreenGui in CoreGui, docs/plugin.md "Input visualisation") visible in each client window; `VirtualInput` clicks through it without a CoreGui error.
  - Result:
  - Notes:

| Topology | Launch → all nodes attached (ms) | EndTest → torn down (ms) |
|---|---|---|
| run (0 players) | | |
| play (1 player) | | |
| multiplayer (2 players) | | |
