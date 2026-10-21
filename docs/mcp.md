# MCP server (`stagehand-mcp`)

`stagehand-mcp` is a stdio MCP server and HTTP broker. The Studio plugin connects to this broker.
The daemon selects the first available port in `127.0.0.1:38491`–`38500`. The `STAGEHAND_PORT` variable changes the range start.
Each MCP client can run a separate daemon. Each daemon can see all open Studio instances.
Use `--place` to select a Studio instance. The [architecture document](https://github.com/unix-system/Stagehand/blob/main/docs/architecture.md#mcp-surface-packagesmcpsrcserver) defines the MCP interface.

> This reference describes the definitions in `packages/mcp/src/server/tools.ts`. Your MCP client's input schema is the current source for tool arguments.

## Client configuration

Build from the repository root with `pnpm install && pnpm build`. Set the client command to `node packages/mcp/dist/index.js`.

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

To enable `eval_lua`, add `"--allow-eval"` to `args`.
Stagehand stores tests in `playtests/` and reports in `.stagehand/runs/`, relative to the project root.
Set the root with `--root`. The default is the daemon's working directory.

| Flag | Meaning |
|---|---|
| `--root <dir>` | project dir (tests in `<root>/playtests`, runs in `<root>/.stagehand/runs`; default cwd) |
| `--port <n>` | start of the broker port range (default `$STAGEHAND_PORT` or 38491); the first free port in `n`..`n+9` is used |
| `--place <id\|name>` | Studio instance to use when multiple instances are open: a placeId or a case-insensitive substring of the place name (default `$STAGEHAND_PLACE`, else the most recently attached Studio) |
| `--allow-eval` | enable the `eval_lua` tool |
| `--idle-timeout <dur>` | end idle Studio sessions after this long (default 120s; 0 = never) |
| `--broker-only` | run only the HTTP broker (no MCP stdio), for debugging |

## Live progress in Claude Code

The `stagehand-progress` Claude Code mod shows test progress above the prompt and in a `/stagehand` pane.
It shows the active step, time limit, logs, results, and a Cancel button. It sends a notification when the run ends.
The mod uses `get_run` and `tail_run` through the session's MCP connection.
Load it with `claude --plugin-dir packages/claude-mod`.
See the [mod README](https://github.com/unix-system/Stagehand/blob/main/packages/claude-mod/README.md) for details.

## Recommended agent workflow

```
inspect ──► draft YAML ──► validate_test ──► run_steps ──► save_test ──► run_test / run_suite
   ▲                            │                │
   └──────── fix paths ◄────────┴──── fix ◄──────┘
```

1. Use `stagehand_status` to examine the Studio connection.
2. Use `list_actions` to find actions and game hooks.
3. Use `inspect` to find instance paths.
4. Write the test. See [Writing playtests](writing-tests.md).
5. Use `validate_test` to validate the format, actions, parameters, contexts, and actors. This check does not need Studio.
6. Use `run_steps` to run unsaved steps.
7. Correct test errors.
8. Use `save_test` to save the test.
9. Use `run_test` to run the saved test.

The `write_playtest` prompt packages this workflow as a template.

## Tools

This reference describes `packages/mcp/src/server/tools.ts`. Use your MCP client's input schema for the current argument definitions.
The `?` symbol identifies an optional argument. Durations accept strings such as `"10s"`, `"500ms"`, and `"2m"`, or a number of milliseconds.

| Tool | Purpose |
|---|---|
| [`stagehand_status`](#stagehand_status) | Report the broker port, connected nodes, session, run status, and catalog state. |
| [`list_actions`](#list_actions) | List available actions, conditions, and game hooks. |
| [`inspect`](#inspect) | Find instances and paths in the selected DataModel. |
| [`validate_test`](#validate_test) | Validate a test against the schema and catalog without a test session. |
| [`run_steps`](#run_steps) | Run unsaved steps and return a report. By default, the call returns after 90 seconds if the run continues. |
| [`run_test`](#run_test) | Run a saved playtest and return its report. |
| [`run_suite`](#run_suite) | Run saved tests in sequence, selected by tag or name. The timeout limits how long the call waits. |
| [`get_run`](#get_run) | Get the available report for an active or completed run. |
| [`tail_run`](#tail_run) | Get events after a sequence number. Use `waitMs` to wait for new events. |
| [`cancel_run`](#cancel_run) | Cancel a queued or active run. |
| [`list_tests`](#list_tests) | List saved tests and shared fragments. |
| [`get_test`](#get_test) | Read a saved test's YAML source. |
| [`save_test`](#save_test) | Validate and save a playtest. Replace an existing test with the same name. |
| [`delete_test`](#delete_test) | Delete a saved test. Keep its previous reports. |
| [`start_session`](#start_session) | Start or reuse a Studio session with the selected mode and player count. |
| [`stop_session`](#stop_session) | Stop a Studio test session and wait for confirmation. |
| [`eval_lua`](#eval_lua) | Run Luau on a node and return its value and logs. |

### `stagehand_status`

This tool reports the broker port, Studio nodes, session, active run, and catalog state.
Call it first to examine the Studio connection.

This tool has no arguments. The `studioTest` field reports the test in Studio's shared Launcher, including tests from other daemons.
The `ours` field identifies a test started by this daemon's port or a session it ended.
The `tracked` field identifies the current session. An untracked test that belongs to this daemon includes a `stop_session` hint.

The `catalog.gameHooksVerified` field is true only while a game node is attached.
Between sessions, Stagehand keeps cached hook entries and applies less strict checks.

### `list_actions`

This tool lists actions, conditions, and available game hooks.
Use actions with `do`. Use conditions with `wait` or `expect`.
Each entry shows its name, kind, contexts, actor requirement, parameters, and description.
The `*` symbol identifies the default context. The `?` symbol identifies an optional parameter.
Set `name` to get the full JSON schema for one entry. The result also includes a step syntax reference.

| Arg | Type | Notes |
|---|---|---|
| `kind`? | `action` \| `condition` | Filter by kind |
| `namespace`? | string | Filter by namespace prefix, e.g. "character" or "game" |
| `context`? | `edit` \| `server` \| `client` | Only entries that can run in this context |
| `name`? | string | Return the full JSON entry for this exact name |

### `inspect`

This tool examines instances in the active DataModel and returns paths for selectors.
Specify exactly one of `path`, `tag`, or `className`.
During a session, the default context is the server. Otherwise, the tool uses the edit DataModel.
To examine a player's GUI, set `on: client` and `as: p1`.

| Arg | Type | Notes |
|---|---|---|
| `path`? | string | Instance path or selector to start from (default: game) |
| `tag`? | string | CollectionService tag to list |
| `className`? | string | List instances of this class (IsA) |
| `depth`? | integer | Child depth to include (default 1) |
| `limit`? | integer | Max nodes (default 200) |
| `on`? | `edit` \| `server` \| `client` | DataModel to examine |
| `as`? | string | Client to use with on: client (p1..p8; default p1) |

### `validate_test`

This tool validates a playtest against the schema and action catalog without a test session.
It accepts YAML, JSON, an object, or a saved test name.
The result includes errors, warnings, and the execution plan. Errors include paths and available line numbers.
Use this tool before `run_steps` or `save_test`.

| Arg | Type | Notes |
|---|---|---|
| `spec`? | string \| object | Playtest as YAML/JSON text or as an object |
| `name`? | string | Name of a saved test in playtests/ (instead of spec) |

### `run_steps`

This tool runs unsaved steps in Studio. It starts or reuses a session and returns a report.
The `steps` argument accepts a YAML or JSON step list, or a full playtest document.
Other arguments override fields in that document.
Set `session.players` to select Run mode (0), Play (1), or multiplayer (2–8).
Without a mode or player count, the tool reuses the current session with reset policy `none`.
The report identifies this reuse. A client can supply `progressToken` to receive progress updates.
By default, the call waits up to 90 seconds. It then returns the available report and `runId`.

| Arg | Type | Notes |
|---|---|---|
| `steps` | string \| object[] | Steps as YAML/JSON text or array |
| `session`? | object | Session: mode edit\|run (0 players) \| play (1) \| multiplayer (2..8); omitted mode is inferred from players; omitted entirely = the live session |
| `vars`? | object | Vars referenced as $name |
| `actors`? | object | Actor aliases, e.g. {blue: {player: 1}} |
| `setup`? | object[] |  |
| `teardown`? | object[] |  |
| `timeout`? | string \| number | Time limit for the full run (default 60s) |
| `failOnError`? | boolean | Fail the active step on any error-level Output (default true) |
| `name`? | string | Run name for the report (default adhoc) |
| `wait`? | boolean \| duration | true/omitted = wait up to 90s; false = return the runId at once; a duration = that cap. Past the cap the partial report is returned and the run continues |

The step table shows return values from Lua steps and actions as `→ value`.
The `Vars` section lists saved variables.
For known failure patterns, the report includes a **Hint**. For example, add `within` or use `on: client` to examine an attribute that exists only on the client.

### `run_test`

This tool runs `playtests/<name>.playtest.yaml` in Studio and returns a report.
The report includes status, failure details, logs, step values, and variables. Stagehand saves reports under `.stagehand/runs/`.
By default, the call waits up to 90 seconds. It then returns the available report and `runId`.
Use `tail_run` or `get_run` to read later results. Set `wait: false` to return the `runId` immediately.

| Arg | Type | Notes |
|---|---|---|
| `name` | string | Saved test name |
| `wait`? | boolean \| duration | see `run_steps` |
| `timeout`? | string \| number | Override the test's whole-run timeout |
| `vars`? | object | Override/add vars |

### `run_suite`

This tool runs saved tests in sequence. Select tests by tag or name. Without a selection, it runs all tests.
The result lists each run ID, status, and first failure cause. Use `get_run` for details.
The call waits until `timeout`, which defaults to 90 seconds.
At the time limit, it returns the available results. The active test continues, but remaining tests do not start.
Use `tail_run` with the active run ID to read later results.

| Arg | Type | Notes |
|---|---|---|
| `tag`? | string | Run tests with this tag |
| `names`? | string[] | Run these tests (in order) |
| `stopOnFailure`? | boolean | Stop after the first failing test (default false) |
| `timeout`? | string \| number | How long this call may block (default 90s) |

### `get_run`

This tool returns a report for `runId` or `"latest"`.
The report includes status, failure details, logs, step values, and final variables.
It supports active runs and saved runs under `.stagehand/runs/`. An active report shows only the results available so far.

| Arg | Type | Notes |
|---|---|---|
| `runId` | string | Run id from run_* tools, or "latest" |
| `format`? | `markdown` \| `json` | markdown (default) or full json |

### `tail_run`

This tool returns events after a specified sequence number.
Set `afterSeq` to the previous response's `lastSeq` to get new events.
Set `waitMs` to wait for an event. The maximum is 60 seconds.
The call returns when an event arrives, the run ends, or the time limit expires.

| Arg | Type | Notes |
|---|---|---|
| `runId` | string | Run id or "latest" |
| `afterSeq`? | integer | Only events with seq > afterSeq (default 0) |
| `limit`? | integer | Max events (default 200) |
| `waitMs`? | string \| number | Long-poll up to this long for new events (e.g. "30s"; max 60s). Default 0 |

### `cancel_run`

This tool cancels a queued or active run. The default is the active run.
Stagehand cancels active steps on their nodes, then runs teardown.

| Arg | Type | Notes |
|---|---|---|
| `runId`? | string | Run id (default: active run) |

### `list_tests`

This tool lists saved tests in `playtests/`, with descriptions and tags.
It also lists shared fragments from `playtests/_shared/`, with their names, descriptions, and step counts.
The list keeps fragments separate from tests. Use `use: <name>` to select a fragment.

| Arg | Type | Notes |
|---|---|---|
| `tag`? | string | Only tests with this tag |

### `get_test`

Return the YAML source of a saved playtest.

| Arg | Type | Notes |
|---|---|---|
| `name` | string |  |

### `save_test`

This tool validates a test and saves it to `playtests/<name>.playtest.yaml`.
It preserves YAML text and comments. It serializes object input.
The test's name must equal the `name` argument. Invalid input needs `force: true` to save.
This tool replaces an existing test with the same name.

| Arg | Type | Notes |
|---|---|---|
| `name` | string | Test name (lowercase kebab-case) |
| `spec` | string \| object | Playtest as YAML/JSON text or as an object |
| `force`? | boolean | Save even if validation fails |

### `delete_test`

This tool deletes `playtests/<name>.playtest.yaml`. It keeps previous run reports.

| Arg | Type | Notes |
|---|---|---|
| `name` | string |  |

### `start_session`

This tool starts or reuses a Studio session.
Set the player count to 0 for Run mode, 1 for Play, or 2–8 for multiplayer.
It waits for server and client nodes to attach and for characters to load.
If the game creates no characters, it can return 2.5 seconds after players join.
For such games, add `wait: character.loaded` after the step that creates a character.
The launch must start in 30 seconds or less. The session must become available in 60 seconds or less. Multiplayer limits are 1.5 times longer.

| Arg | Type | Notes |
|---|---|---|
| `mode`? | `run` \| `play` \| `multiplayer` |  |
| `players`? | integer |  |
| `reset`? | `respawn` \| `hook` \| `none` | Reset applied if an existing session is reused (default none) |

### `stop_session`

This tool ends the current Studio session. It calls `EndTest` on the server.
If that fails, it tries `RunService:Stop` on the edit node. This alternative operates only in Run mode.
For Play or multiplayer, the alternative returns `ended: false`.
The tool waits up to 20 seconds for Studio to confirm the stop through `studioStopped`.
It can also stop an untracked test started by this daemon, if the test's server node is attached.
Cancel an active run with `cancel_run` before you use this tool.
With `force: true`, it can stop an attached test started manually or by a restarted daemon.
Use the controlling daemon or Studio to stop a test that belongs to a different active daemon.

| Argument | Type | Notes |
|---|---|---|
| `force`? | boolean | Stop the active Studio test, including a test started manually or by a different daemon |

### `eval_lua`

This tool runs Luau on a node and returns its value and logs.
The code can access `actor`, `player`, `character`, and `vars`.
Start the daemon with `--allow-eval` to enable this tool. Otherwise, it returns `EVAL_DISABLED`.
The default context is the session server, or the edit DataModel when no session exists.
For debugging outside a Stagehand session, use a Studio MCP tool.

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

Tool errors include a code from the [protocol reference](protocol.md#error-object).
Examples include `RESOLVE_FAILED`, `TIMEOUT`, `BAD_PARAMS`, and `SESSION_ERROR`.
Daemon errors can also report connection problems, such as no attached Studio instance. See [plugin setup](plugin.md).
