# MCP server (`stagehand-mcp`)

`stagehand-mcp` is a stdio MCP server that also runs the HTTP broker the Studio plugin connects to
(the first free port in `127.0.0.1:38491`–`38500`; `STAGEHAND_PORT` moves the range start). Several MCP
clients can run their own daemons at once, each sees every open Studio, and `--place` picks which Studio a
daemon drives when more than one is open. Tool names come from
[architecture.md](architecture.md#mcp-surface-packagesmcpsrcserver).

> The tool reference below is generated from `packages/mcp/src/server/tools.ts`. When in doubt, trust the
> tool's own input schema as listed by your MCP client.

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
relative to the project root (`--root <dir>`, default the daemon's working directory):
`playtests/*.playtest.yaml` and `.stagehand/runs/`.

| Flag | Meaning |
|---|---|
| `--root <dir>` | project dir (tests in `<root>/playtests`, runs in `<root>/.stagehand/runs`; default cwd) |
| `--port <n>` | start of the broker port range (default `$STAGEHAND_PORT` or 38491); the first free port in `n`..`n+9` is used |
| `--place <id\|name>` | Studio to drive when several are open: a placeId or a case-insensitive substring of the place name (default `$STAGEHAND_PLACE`, else the most recently attached Studio) |
| `--allow-eval` | enable the `eval_lua` tool |
| `--idle-timeout <dur>` | end idle Studio sessions after this long (default 120s; 0 = never) |
| `--broker-only` | run only the HTTP broker (no MCP stdio), for debugging |

## Live progress in Claude Code

`packages/claude-mod/` is a Claude Code mod (`stagehand-progress`) that follows runs while they go: a band
above the prompt with the running step and its budget, a `/stagehand` pane with every step, the game log
tail and a Cancel button, the status line, and a toast plus native notification on finish. It needs nothing
from the daemon beyond `get_run format:"json"` and `tail_run`, which it calls over the session's own MCP
connection. Load it with `claude --plugin-dir packages/claude-mod` (details in
[`packages/claude-mod/README.md`](../packages/claude-mod/README.md)).

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

Generated from the tool definitions in `packages/mcp/src/server/tools.ts` (the input schema your MCP
client lists is authoritative). `?` = optional. Durations accept `"10s"`, `"500ms"`, `"2m"` or milliseconds.

| Tool | Purpose |
|---|---|
| [`stagehand_status`](#stagehand_status) | Show daemon health: broker port, attached Studio nodes (edit/server/client with sessionId and playerIndex), the current test session, the active run and catalog state. |
| [`list_actions`](#list_actions) | List the catalog of playtest actions (use with do:) and conditions (use with wait:/expect:), including live game.* hooks from the running game. |
| [`inspect`](#inspect) | Inspect instances in the live DataModel to discover paths for selectors: remotes, teams, tools, GUI elements, tagged parts, attributes. |
| [`validate_test`](#validate_test) | Validate a playtest (YAML/JSON text, object, or a saved test by name) against the schema and the action catalog without running it. |
| [`run_steps`](#run_steps) | Run unsaved steps in Studio right away (reuses the live session as it is when no mode/players are given) and return a pass/fail report with reason/expected/actual, lua return values and vars; bounded wait (default 90s) with a partial report past it. |
| [`run_test`](#run_test) | Run a saved playtest from playtests/<name>.playtest.yaml in Studio and return the report (status, failing step with reason/expected/actual/hint, logs around the failure, per-step table with values, vars); bounded wait. |
| [`run_suite`](#run_suite) | Run several saved playtests sequentially, selected by tag and/or names (no selector = all tests); bounded by `timeout`. |
| [`get_run`](#get_run) | Get the result of a run by runId (or "latest"): status, failure (step, reason, expected, actual, hint, node, logs around), per-step statuses with reasons and values, final vars. Works for in-progress runs. |
| [`tail_run`](#tail_run) | Return a run's events after a sequence number (step.started/passed/failed/skipped, log, session, run.finished); `waitMs` long-polls. |
| [`cancel_run`](#cancel_run) | Cancel a queued or running run (default: the active run). |
| [`list_tests`](#list_tests) | List saved playtests in playtests/ with description and tags, plus the shared fragments in playtests/_shared/. |
| [`get_test`](#get_test) | Return the YAML source of a saved playtest. |
| [`save_test`](#save_test) | Validate and save a playtest to playtests/<name>.playtest.yaml (YAML text is saved verbatim, keeping comments; objects are serialized). |
| [`delete_test`](#delete_test) | Delete a saved playtest (playtests/<name>.playtest.yaml). |
| [`start_session`](#start_session) | Start (or reuse) a Studio test session so later runs and inspect calls are fast: players 0 = Run mode, 1 = Play, 2-8 = multiplayer (Studio simulated players). |
| [`stop_session`](#stop_session) | End the current Studio test session and wait for Studio to confirm; also ends a test this daemon launched but lost track of. |
| [`eval_lua`](#eval_lua) | Run arbitrary Luau on a node and return its value and captured logs. |

### `stagehand_status`

Show daemon health: broker port, attached Studio nodes (edit/server/client with sessionId and playerIndex), the current test session, the active run and catalog state. Call this first to check that Roblox Studio with the Stagehand plugin is connected.

No arguments. `studioTest` reports the test Studio's shared Launcher is running right now (any daemon's), with
`ours` (launched by this daemon's port, or a session it ended) and `tracked` (it is the current session); a
test of ours that is not tracked comes with a `hint` to run `stop_session`. `catalog.gameHooksVerified` is
true only while a game node is attached; between sessions the `game.*` entries are cached and checked loosely.

### `list_actions`

List the catalog of playtest actions (use with do:) and conditions (use with wait:/expect:), including live game.* hooks from the running game. Each line: name [kind] (contexts, * = default) needs-as? {params; ? = optional}: summary. Pass `name` for one entry's full JSON schema. Includes a step-syntax cheat sheet.

| Arg | Type | Notes |
|---|---|---|
| `kind`? | `action` \| `condition` | Filter by kind |
| `namespace`? | string | Filter by namespace prefix, e.g. "character" or "game" |
| `context`? | `edit` \| `server` \| `client` | Only entries runnable in this context |
| `name`? | string | Return the full JSON entry for this exact name |

### `inspect`

Inspect instances in the live DataModel to discover paths for selectors: remotes, teams, tools, GUI elements, tagged parts, attributes. Give exactly one of path (e.g. "ReplicatedStorage.Remotes", "@p1.gui"), tag, or className. Runs on the server of the current session if one is running, else on the edit DataModel; use on: client with as: p1 to see a player's GUI.

| Arg | Type | Notes |
|---|---|---|
| `path`? | string | Instance path or selector to start from (default: game) |
| `tag`? | string | CollectionService tag to list |
| `className`? | string | List instances of this class (IsA) |
| `depth`? | integer | Child depth to include (default 1) |
| `limit`? | integer | Max nodes (default 200) |
| `on`? | `edit` \| `server` \| `client` | Which DataModel to inspect |
| `as`? | string | Client to use with on: client (p1..p8; default p1) |

### `validate_test`

Validate a playtest (YAML/JSON text, object, or a saved test by name) against the schema and the action catalog without running it. Returns errors with paths and line numbers, warnings, and the compiled plan (which node each step runs on, merged segments). Use before run_steps/save_test.

| Arg | Type | Notes |
|---|---|---|
| `spec`? | string \| object | Playtest as YAML/JSON text or as an object |
| `name`? | string | Name of a saved test in playtests/ (instead of spec) |

### `run_steps`

Run unsaved steps in Studio right away (launches or reuses a test session) and return a pass/fail report with reason/expected/actual for failures. steps is a YAML/JSON list of steps (or a whole playtest document; the other arguments are merged over it), e.g. "- { do: player.setTeam, as: p1, team: Blue }\n- { expect: player.onTeam, as: p1, team: Blue }". Set session.players (0 = Run mode, 1 = Play, 2-8 = multiplayer); **with no mode/players the live session is reused as it is** (reset `none`), and the report says so. Streams step progress when the client sends a progressToken. Waits up to 90s by default, then returns the partial report with the runId.

| Arg | Type | Notes |
|---|---|---|
| `steps` | string \| object[] | Steps as YAML/JSON text or array |
| `session`? | object | Session: mode edit\|run (0 players) \| play (1) \| multiplayer (2..8); omitted mode is inferred from players; omitted entirely = the live session |
| `vars`? | object | Vars referenced as $name |
| `actors`? | object | Actor aliases, e.g. {blue: {player: 1}} |
| `setup`? | object[] |  |
| `teardown`? | object[] |  |
| `timeout`? | string \| number | Whole-run budget (default 60s) |
| `failOnError`? | boolean | Fail the active step on any error-level Output (default true) |
| `name`? | string | Run name for the report (default adhoc) |
| `wait`? | boolean \| duration | true/omitted = wait up to 90s; false = return the runId at once; a duration = that cap. Past the cap the partial report is returned and the run keeps going |

The report's step table shows each `lua` step's (and any action's) return value as `→ value`, a `## Vars`
section lists the saved vars, and a failure carries a one-line **Hint** when the daemon recognises the shape
(instant `expect` → `within:`; attribute unset on the server → `on: client`).

### `run_test`

Run a saved playtest from playtests/<name>.playtest.yaml in Studio and return the report (status, failing step with reason/expected/actual/hint, logs around the failure, per-step table with values, vars). Reports are stored under .stagehand/runs/. Waits up to 90s by default, then returns the partial report with the runId to follow via tail_run/get_run; wait: false returns the runId at once.

| Arg | Type | Notes |
|---|---|---|
| `name` | string | Saved test name |
| `wait`? | boolean \| duration | see `run_steps` |
| `timeout`? | string \| number | Override the test's whole-run timeout |
| `vars`? | object | Override/add vars |

### `run_suite`

Run several saved playtests sequentially, selected by tag and/or names (no selector = all tests). Returns a pass/fail table with each runId and the first failure reason; use get_run for details. Blocks up to `timeout` (default 90s): past it the table so far is returned, the in-flight test keeps running (follow its runId with tail_run) and the remaining tests are not started.

| Arg | Type | Notes |
|---|---|---|
| `tag`? | string | Run tests having this tag |
| `names`? | string[] | Run these tests (in order) |
| `stopOnFailure`? | boolean | Stop after the first failing test (default false) |
| `timeout`? | string \| number | How long this call may block (default 90s) |

### `get_run`

Get the result of a run by runId (or "latest"): status, failure (step, reason, expected, actual, hint, node, logs around), per-step statuses with reasons and values, and final vars. Works for in-progress runs (the same markdown, headed "(in progress)", with the reasons and values known so far) and past runs stored in .stagehand/runs/.

| Arg | Type | Notes |
|---|---|---|
| `runId` | string | Run id from run_* tools, or "latest" |
| `format`? | `markdown` \| `json` | markdown (default) or full json |

### `tail_run`

Return a run's events after a sequence number (step.started/passed/failed/skipped, log, session, run.finished). Poll with afterSeq = the returned lastSeq to follow a run started with wait: false. With `waitMs` the call long-polls: it returns as soon as a new event arrives, when the run finishes, or after waitMs (max 60s), so following a run costs one call per event burst instead of a sleep loop.

| Arg | Type | Notes |
|---|---|---|
| `runId` | string | Run id or "latest" |
| `afterSeq`? | integer | Only events with seq > afterSeq (default 0) |
| `limit`? | integer | Max events (default 200) |
| `waitMs`? | string \| number | Long-poll up to this long for new events (e.g. "30s"; max 60s). Default 0 |

### `cancel_run`

Cancel a queued or running run (default: the active run). In-flight steps are cancelled on the nodes, then teardown runs.

| Arg | Type | Notes |
|---|---|---|
| `runId`? | string | Run id (default: active run) |

### `list_tests`

List saved playtests in playtests/ with description and tags, plus the shared step fragments in playtests/_shared/ (`name`, `description`, step count) that `use: <name>` steps can reference. The `_shared` folder is never listed as tests.

| Arg | Type | Notes |
|---|---|---|
| `tag`? | string | Only tests with this tag |

### `get_test`

Return the YAML source of a saved playtest.

| Arg | Type | Notes |
|---|---|---|
| `name` | string |  |

### `save_test`

Validate and save a playtest to playtests/<name>.playtest.yaml (YAML text is saved verbatim, keeping comments; objects are serialized). The spec's name must equal `name`. Refuses invalid specs unless force: true. Overwrites an existing test.

| Arg | Type | Notes |
|---|---|---|
| `name` | string | Test name (lowercase kebab-case) |
| `spec` | string \| object | Playtest as YAML/JSON text or as an object |
| `force`? | boolean | Save even if validation fails |

### `delete_test`

Delete a saved playtest (playtests/<name>.playtest.yaml). Past run reports are kept.

| Arg | Type | Notes |
|---|---|---|
| `name` | string |  |

### `start_session`

Start (or reuse) a Studio test session so later runs and inspect calls are fast: players 0 = Run mode, 1 = Play, 2-8 = multiplayer (Studio simulated players). Waits until the server and all clients are attached and characters are loaded (or 8s after the players joined, for games that spawn characters from a menu; use wait: character.loaded in tests then).

| Arg | Type | Notes |
|---|---|---|
| `mode`? | `run` \| `play` \| `multiplayer` |  |
| `players`? | integer |  |
| `reset`? | `respawn` \| `hook` \| `none` | Reset applied if an existing session is reused (default none) |

### `stop_session`

End the current Studio test session (EndTest on the server; RunService:Stop via the edit node as fallback, which only works for Run mode, and the fallback says so honestly with `ended: false` for a Play/multiplayer test) and wait, bounded by 20s, for Studio to confirm the teardown (`studioStopped`), so a `start_session` right after does not race. Without a tracked session it still ends a test Studio reports as launched by this daemon (a failed launch, a detached server node) when that test's server node is attached, and otherwise explains what to do. Refused while a run is active; cancel_run first. With force: true also ends a test launched by another (restarted) daemon or by hand whose server node is attached here; a test driven by another live daemon must be stopped from that daemon or in Studio.

| Argument | Type | Notes |
|---|---|---|
| `force`? | boolean | Stop whatever test Studio is running, even one launched by another daemon or by hand |

### `eval_lua`

Run arbitrary Luau on a node and return its value and captured logs. `actor`, `player`, `character` and `vars` are in scope. Disabled unless the daemon was started with --allow-eval (returns EVAL_DISABLED). Defaults to the session's server, else the edit DataModel.

| Arg | Type | Notes |
|---|---|---|
| `code` | string | Luau chunk, e.g. "return #game.Players:GetPlayers()" |
| `on`? | `edit` \| `server` \| `client` |  |
| `as`? | string | Actor p1..p8 (client to run on, or the player bound on the server) |
| `vars`? | object |  |

## Resources

| URI | Content |
|---|---|
| `stagehand://catalog` | merged catalog JSON (what `list_actions` returns, unfiltered) |
| `stagehand://tests/{name}` | the saved YAML of a test |
| `stagehand://runs/latest` | result JSON of the most recent run |

## Prompt

`write_playtest` (args: `goal`, optional `name`) — instructs the agent to `inspect`, draft YAML,
`validate_test`, `run_steps`, then `save_test`.

## Errors

Tool errors carry a code from [protocol.md](protocol.md#error-object): `RESOLVE_FAILED`, `TIMEOUT`,
`ASSERTION_FAILED`, `UNKNOWN_ACTION`, `BAD_PARAMS`, `SESSION_ERROR`, `EVAL_DISABLED`, … plus daemon-level
conditions such as "no Studio attached" (start Studio with the plugin, see [plugin.md](plugin.md)).
