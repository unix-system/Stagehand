# stagehand-mcp

The Stagehand daemon: an **MCP server** (stdio) for coding agents plus an **HTTP broker** on
`127.0.0.1:38491` that the Stagehand Roblox Studio plugin attaches to. Agents write declarative YAML
playtests; the daemon validates them, launches Studio test sessions (Run / Play / multiplayer), routes each
step to the right DataModel (edit, server, client N), and returns pass/fail reports with expected/actual
values and the Output logs around a failure.

See [`docs/spec.md`](../../docs/spec.md) for the playtest format and [`docs/protocol.md`](../../docs/protocol.md)
for the broker protocol.

## Install

```sh
pnpm add -D stagehand-mcp      # or: npm i -D stagehand-mcp
```

From this repo:

```sh
pnpm install
pnpm -F stagehand-mcp build    # dist/ + bundled dist/schema
pnpm -F stagehand-mcp test
```

Requires Node 20+. Install the Stagehand plugin in Roblox Studio and open your place; the plugin's edit
node attaches to the broker automatically (plugin setting `Stagehand.Port` must match the daemon port).

## Run

```sh
npx stagehand-mcp --root .              # MCP over stdio + broker on 127.0.0.1:38491
npx stagehand-mcp --root . --allow-eval # also enable the eval_lua tool
npx stagehand-mcp --broker-only         # broker only, for debugging plugins (curl /v1/health)
```

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | cwd | project dir: tests in `<root>/playtests/*.playtest.yaml`, reports in `<root>/.stagehand/runs/<ts>-<name>/` |
| `--port <n>` | `$STAGEHAND_PORT` or `38491` | broker port |
| `--allow-eval` | off | enable `eval_lua` (arbitrary Luau in Studio) |
| `--idle-timeout <dur>` | `120s` | end an idle reused Studio session (`0` = never) |

Each run writes `events.ndjson`, `result.json` and `summary.md` under `.stagehand/runs/`.

## MCP client configuration

**Claude Code**

```sh
claude mcp add stagehand -- npx stagehand-mcp --root .
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "stagehand": {
      "command": "npx",
      "args": ["stagehand-mcp", "--root", "."]
    }
  }
}
```

Only one daemon can own the broker port; if a second client starts one, `stagehand_status` reports the
port conflict (use `--port` / `STAGEHAND_PORT` and the matching plugin setting).

## Tools

| Tool | Purpose |
|---|---|
| `stagehand_status` | broker, attached Studio nodes, session, active run, catalog |
| `list_actions` | actions/conditions (+ live `game.*` hooks) with params and a syntax cheat sheet |
| `inspect` | browse the live DataModel (paths, tags, attributes) to write selectors |
| `validate_test` | schema + catalog validation with line numbers, compiled plan |
| `run_steps` | run unsaved steps (ad hoc) |
| `run_test` / `run_suite` | run saved tests (by name / tag) |
| `get_run` / `tail_run` / `cancel_run` | reports, event streaming, cancellation |
| `list_tests` / `get_test` / `save_test` / `delete_test` | manage `playtests/` |
| `start_session` / `stop_session` | keep a Studio session warm / end it |
| `eval_lua` | run Luau on a node (requires `--allow-eval`) |

Resources: `stagehand://catalog`, `stagehand://tests/{name}`, `stagehand://runs/latest`.
Prompt: `write_playtest` (inspect → draft → validate_test → run_steps → save_test).

During `run_*` calls the server sends `notifications/progress` and logging messages for every step when
the client provides a `progressToken`.

## Layout

```
src/index.ts      bin entry (flags, stdio transport)
src/daemon.ts     wiring
src/broker/       HTTP broker, node registry, command queues (docs/protocol.md)
src/spec/         YAML/JSON loader, JSON Schema validation, catalog, selector parser, values
src/engine/       compiler (plan/segments), sessions, runner, reporter
src/store/        playtests/ and .stagehand/runs/
src/server/       MCP tools, resources, prompt
test/             vitest (fake Studio nodes over real HTTP)
```
