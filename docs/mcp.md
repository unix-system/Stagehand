# MCP server (`stagehand-mcp`)

`stagehand-mcp` is a stdio MCP server that also runs the HTTP broker the Studio plugin connects to
(`127.0.0.1:38491`, override with `STAGEHAND_PORT`). One daemon serves one Studio instance. Tool names come
from [architecture.md](architecture.md#mcp-surface-packagesmcpsrcserver).

> **Argument details may be refined by `packages/mcp`.** Tool names are fixed; argument names, defaults and
> response fields below are the intended shape. When in doubt, trust the tool's own input schema as listed
> by your MCP client. Items marked *(tbc)* are the most likely to change.

## Client configuration

Build once from the repo root: `pnpm install && pnpm build`. Then point your client at the binary (or at
`node packages/mcp/dist/index.js`).

**Claude Code** — from your game's project directory:

```sh
claude mcp add stagehand -- npx stagehand-mcp
# or, from a checkout:
claude mcp add stagehand -- node /path/to/Stagehand/packages/mcp/dist/index.js
```

or commit a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "stagehand": {
      "command": "npx",
      "args": ["stagehand-mcp"],
      "env": { "STAGEHAND_PORT": "38491" }
    }
  }
}
```

**Cursor** — `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "stagehand": {
      "command": "npx",
      "args": ["stagehand-mcp"]
    }
  }
}
```

Add `"--allow-eval"` to `args` only if you want agents to use `eval_lua`. Tests and run reports are stored
relative to the daemon's working directory: `playtests/*.playtest.yaml` and `.stagehand/runs/` *(tbc:
a `--root` flag may override)*.

## Recommended agent workflow

```
inspect ──► draft YAML ──► validate_test ──► run_steps ──► save_test ──► run_test / run_suite
   ▲                            │                │
   └──────── fix paths ◄────────┴──── fix ◄──────┘
```

1. `stagehand_status` — is Studio attached? Which nodes exist?
2. `list_actions` + `inspect` — learn the catalog, the game's `game.*` hooks, and real instance paths.
3. Draft the playtest (see [writing-tests.md](writing-tests.md)).
4. `validate_test { spec }` — schema, catalog names, params, contexts, actors. Cheap, offline.
5. `run_steps { steps, session }` — run the draft live without saving; iterate on failures.
6. `save_test { name, spec }`, then `run_test { name }` to confirm the saved file passes.

The `write_playtest` prompt packages this workflow as a template.

## Tools

### `stagehand_status`

Daemon, broker and node state (mirrors the broker's `GET /v1/health`, see protocol.md).

```json
{ "name": "stagehand_status", "arguments": {} }
```
```json
{
  "ok": true,
  "version": "0.1.0",
  "port": 38491,
  "allowEval": false,
  "nodes": [
    { "nodeId": "n_1", "role": "edit", "sessionId": null, "playerIndex": null, "orphan": false, "lastSeenMs": 120 }
  ],
  "sessions": [],
  "activeRun": null
}
```

### `list_actions`

The merged catalog: static entries from `schema/catalog.json` plus live `game.*` hooks from the attached
place. Optional filters.

| Arg | Type | Notes |
|---|---|---|
| `namespace` | string? | e.g. `character`, `game` |
| `kind` | `action \| condition`? | |

```json
{ "name": "list_actions", "arguments": { "namespace": "game" } }
```
```json
{
  "entries": [
    { "name": "game.requestSpawn", "kind": "action", "contexts": ["server"], "default": "server",
      "summary": "Spawn the player at their team's SpawnLocation (same path as the SpawnButton)",
      "actor": "optional", "params": { "type": "object", "additionalProperties": true }, "source": "hook" },
    { "name": "game.hasSpawned", "kind": "condition", "contexts": ["server"], "default": "server",
      "summary": "The player has a living character", "actor": "optional",
      "params": { "type": "object", "additionalProperties": true }, "source": "hook" }
  ]
}
```

### `inspect`

Browse the DataModel to discover remotes, teams, tools and GUI paths. Give one of `path`, `tag`, `class`.

| Arg | Type | Notes |
|---|---|---|
| `path` | selector? | any selector form, e.g. `ReplicatedStorage.Remotes`, `@p1.gui` |
| `tag` | string? | CollectionService tag |
| `class` | string? | `IsA` match, e.g. `RemoteEvent`, `Tool`, `GuiButton` |
| `depth` | integer? | children depth, default 1 *(tbc)* |
| `on` / `as` | context / actor? | which node to inspect; defaults to the edit node, or the server in a session *(tbc)* |

```json
{ "name": "inspect", "arguments": { "class": "RemoteEvent" } }
```
```json
{
  "matches": [
    { "path": "ReplicatedStorage.Remotes.RequestSpawn", "class": "RemoteEvent", "tags": [], "attributes": {} }
  ]
}
```

### `validate_test`

Validate a spec (object or YAML string) or a saved test by name. Does not need Studio for static catalog
entries; unknown `game.*` names are only errors once a node has reported its catalog.

| Arg | Type | Notes |
|---|---|---|
| `spec` | object \| string? | the playtest, as JSON or YAML text |
| `name` | string? | a saved test |

```json
{ "name": "validate_test", "arguments": { "spec": "name: t\nsession: { players: 2 }\nsteps:\n  - { do: player.setTeam, team: Blue }\n" } }
```
```json
{
  "valid": false,
  "errors": [ { "path": "steps.0", "code": "MISSING_ACTOR", "message": "player.setTeam needs `as` when players >= 2" } ],
  "warnings": [],
  "plan": null
}
```

On success `plan` lists the compiled segments (which node runs which steps) — useful to check routing.

### `run_steps`

Run unsaved steps (ad hoc). Reuses a compatible live session or launches one.

| Arg | Type | Notes |
|---|---|---|
| `steps` | step[] | same grammar as a spec's `steps` |
| `session` | object? | `{ mode, players, reuse, reset }`, default `{ players: 0 }` (Run) |
| `vars` / `actors` / `setup` / `teardown` | optional | as in a spec *(tbc)* |
| `timeout` | duration? | whole-run budget, default `60s` |

```json
{
  "name": "run_steps",
  "arguments": {
    "session": { "players": 1 },
    "steps": [
      { "do": "player.setTeam", "as": "p1", "team": "Blue" },
      { "do": "game.requestSpawn", "as": "p1" },
      { "wait": "character.loaded", "as": "p1" }
    ]
  }
}
```
```json
{
  "runId": "r_20261015T101502_adhoc",
  "status": "passed",
  "durationMs": 4120,
  "session": { "id": "s_3", "mode": "play", "players": 1, "reused": false, "launchMs": 3310 },
  "steps": [
    { "id": "steps.0", "status": "passed", "durationMs": 8 },
    { "id": "steps.1", "status": "passed", "durationMs": 41 },
    { "id": "steps.2", "status": "passed", "durationMs": 690 }
  ],
  "reportDir": ".stagehand/runs/20261015T101502-adhoc"
}
```

### `run_test`

Run a saved test.

| Arg | Type | Notes |
|---|---|---|
| `name` | string | |
| `wait` | boolean? | default `true`; `false` returns `{ runId }` immediately — then poll `tail_run` |
| `timeout` | duration? | overrides the spec's `timeout` |

```json
{ "name": "run_test", "arguments": { "name": "failing-example" } }
```
```json
{
  "runId": "r_20261015T101910_failing-example",
  "status": "failed",
  "failedStep": {
    "id": "steps.3", "label": "never true: nothing adds Champion",
    "reason": "condition instance.hasTag not true within 1s",
    "expected": { "target": "Workspace.Player1", "tag": "Champion", "value": true },
    "actual": { "value": false, "tags": [] },
    "error": { "code": "ASSERTION_FAILED" },
    "logs": []
  },
  "steps": [
    { "id": "steps.0", "status": "passed" }, { "id": "steps.1", "status": "passed" },
    { "id": "steps.2", "status": "passed" }, { "id": "steps.3", "status": "failed" },
    { "id": "steps.4", "status": "skipped" }
  ],
  "reportDir": ".stagehand/runs/20261015T101910-failing-example"
}
```

### `run_suite`

Run several saved tests sequentially, sharing sessions where `mode`/`players` match.

| Arg | Type | Notes |
|---|---|---|
| `tag` | string? | e.g. `smoke` |
| `names` | string[]? | explicit list |
| `exclude` | string[]? | tags to skip, e.g. `["demo-failure"]` *(tbc)* |

```json
{ "name": "run_suite", "arguments": { "tag": "smoke" } }
```
```json
{
  "suiteId": "u_20261015T102200",
  "status": "passed",
  "results": [
    { "name": "run-mode-smoke", "runId": "r_…", "status": "passed", "durationMs": 2410 },
    { "name": "blue-team-gun-hostile", "runId": "r_…", "status": "passed", "durationMs": 5120 },
    { "name": "gui-spawn-button", "runId": "r_…", "status": "passed", "durationMs": 1460 }
  ]
}
```

### `get_run`

Full result of a run (same content as `.stagehand/runs/<dir>/result.json`).

```json
{ "name": "get_run", "arguments": { "id": "r_20261015T101910_failing-example" } }
```

Response: the `run_test` shape plus `events` count, per-step `startedAt`, segment timings and the Markdown
summary path.

### `tail_run`

Events since a sequence number — for streaming progress of a run started with `wait: false`.

| Arg | Type | Notes |
|---|---|---|
| `id` | string | runId |
| `afterSeq` | integer? | default 0 |

```json
{ "name": "tail_run", "arguments": { "id": "r_…", "afterSeq": 12 } }
```
```json
{
  "events": [
    { "seq": 13, "type": "step.started", "stepId": "steps.5" },
    { "seq": 14, "type": "step.passed", "stepId": "steps.5", "durationMs": 312 },
    { "seq": 15, "type": "run.finished", "status": "passed" }
  ],
  "lastSeq": 15,
  "done": true
}
```

### `cancel_run`

```json
{ "name": "cancel_run", "arguments": { "id": "r_…" } }
```
```json
{ "runId": "r_…", "status": "cancelled", "teardown": "ran" }
```

### `list_tests`

| Arg | Type | Notes |
|---|---|---|
| `tag` | string? | filter |

```json
{ "name": "list_tests", "arguments": { "tag": "multiplayer" } }
```
```json
{ "tests": [ { "name": "two-players-spawn", "tags": ["multiplayer", "combat"], "players": 2, "mode": "multiplayer",
  "path": "playtests/two-players-spawn.playtest.yaml" } ] }
```

### `get_test`

```json
{ "name": "get_test", "arguments": { "name": "blue-team-gun-hostile" } }
```
```json
{ "name": "blue-team-gun-hostile", "path": "playtests/blue-team-gun-hostile.playtest.yaml",
  "yaml": "name: blue-team-gun-hostile\n…", "spec": { "name": "blue-team-gun-hostile", "steps": [ … ] } }
```

### `save_test`

Validates, then writes `playtests/<name>.playtest.yaml`. Refuses invalid specs.

| Arg | Type | Notes |
|---|---|---|
| `name` | string | must equal `spec.name` |
| `spec` | object \| string | JSON object or YAML text (YAML is preserved verbatim, comments included) |
| `overwrite` | boolean? | default `true` *(tbc)* |

```json
{ "name": "save_test", "arguments": { "name": "spawn-blue", "spec": "name: spawn-blue\nsession: { players: 1 }\nsteps:\n  - { do: game.requestSpawn, as: p1 }\n" } }
```
```json
{ "saved": true, "path": "playtests/spawn-blue.playtest.yaml", "warnings": [] }
```

### `delete_test`

```json
{ "name": "delete_test", "arguments": { "name": "spawn-blue" } }
```
```json
{ "deleted": true }
```

### `start_session`

Launch (or reuse) a Studio test session explicitly, e.g. to `inspect` a running game.

| Arg | Type | Notes |
|---|---|---|
| `mode` | `run \| play \| multiplayer`? | default from `players` |
| `players` | integer? | 0..8 |

```json
{ "name": "start_session", "arguments": { "players": 2 } }
```
```json
{ "session": { "id": "s_4", "mode": "multiplayer", "players": 2,
  "nodes": [ { "nodeId": "n_5", "role": "server" }, { "nodeId": "n_6", "role": "client", "playerIndex": 1 },
             { "nodeId": "n_7", "role": "client", "playerIndex": 2 } ], "launchMs": 7420 } }
```

### `stop_session`

Ends the active session (`EndTest` from the server node). Idle sessions also end on their own after 120 s.

```json
{ "name": "stop_session", "arguments": {} }
```
```json
{ "stopped": true, "sessionId": "s_4" }
```

### `eval_lua` (guarded)

Runs arbitrary Luau on a node. Disabled unless the daemon was started with `--allow-eval`; otherwise
returns `EVAL_DISABLED`.

| Arg | Type | Notes |
|---|---|---|
| `code` | string | |
| `on` | `edit \| server \| client`? | default `server` in a session, else `edit` |
| `as` | actor? | for `client`, which window |

```json
{ "name": "eval_lua", "arguments": { "code": "return #game:GetService('Teams'):GetTeams()", "on": "server" } }
```
```json
{ "value": 2, "logs": [] }
```

## Resources

| URI | Content |
|---|---|
| `stagehand://catalog` | merged catalog JSON (what `list_actions` returns, unfiltered) |
| `stagehand://tests/{name}` | the saved YAML of a test |
| `stagehand://runs/latest` | result JSON of the most recent run |

## Prompt

`write_playtest` (args: `goal`, optional `players`) — instructs the agent to `inspect`, draft YAML,
`validate_test`, `run_steps`, then `save_test`.

## Errors

Tool errors carry a code from [protocol.md](protocol.md#error-object): `RESOLVE_FAILED`, `TIMEOUT`,
`ASSERTION_FAILED`, `UNKNOWN_ACTION`, `BAD_PARAMS`, `SESSION_ERROR`, `EVAL_DISABLED`, … plus daemon-level
conditions such as "no Studio attached" (start Studio with the plugin, see [plugin.md](plugin.md)).
