# stagehand-progress

A Claude Code mod that shows Stagehand playtests live, inside Claude Code, while they run in Roblox Studio.

While a run started with `run_test`, `run_steps` or `run_suite` is active you get:

- **A band above the prompt** (any terminal width): run name, overall bar, `finished/total`, the running
  step with its target tag and `elapsed / budget` (amber from 75 % of the budget), the last finished step
  or the failure reason and hint. It collapses to one summary line when the run ends and clears on your next
  prompt.
- **A pane** (`/stagehand`; `/stagehand off` closes it; opened automatically where it docks beside the
  transcript, which the terminal does from 144 columns, or 110 once you have opened it yourself):
  status pill, session mode and players, per-target counts (`SERVER 3/5  P1 3/7`), every step with its
  status glyph, target, label and duration or live budget bar, failed steps with reason and hint, the last
  game log lines, `Cancel run` (press twice) and `Copy report path`, and the last five runs under `Recent`.
- **The status line** under the prompt (`stagehand ▶ spawn-two-players 7/16 · P1 click Play 2.4s / 10s`).
- **A toast and a native notification** when the run finishes.

Everything is read over the session's own `stagehand` MCP connection (`get_run format:"json"` and
`tail_run`), so it always follows the daemon this Claude Code session talks to, even when several daemons
share one Studio. The daemon needs no changes.

## Install

From a terminal session's prompt:

```
/plugin install stagehand-progress --marketplace <owner>/<repo>
```

(`y` to add the marketplace, then a scope.) From a shell: `claude plugin install stagehand-progress --marketplace <owner>/<repo>`.
The mod expects the MCP server to be registered under the name `stagehand` (see `docs/mcp.md`).

## Options

Set under `/config` (or `pluginConfigs["stagehand-progress"].options` in settings):

| Option | Default | Meaning |
|---|---|---|
| `pollMs` | 600 | poll interval while a run is active |
| `autoOpen` | true | open the pane when a run starts, where it docks (fullscreen) |
| `notify` | true | native notification when a run finishes |
| `historySize` | 5 | runs kept under Recent |
| `logLines` | 8 | game log lines in the pane |

## Developing

The mod is a plain hooks module (no build, no npm deps): `hooks/register.tsx` registers the hooks,
`hooks/poll.ts` follows the run, `hooks/parse.ts` and `hooks/format.ts` are pure, `hooks/view/*.tsx` draw,
`types/index.d.ts` declares the `$.state` contract.

Load it from a checkout for one session:

```sh
claude --plugin-dir packages/claude-mod
```

or for every session, put the absolute path in `CLAUDE_CODE_PLUGIN_DIRS` (the `env` block of
`~/.claude/settings.json` works). An interactive session hot-reloads the folder on save. The engine lays the
API typings beside the mod in `.claude-plugin/types/` on first load (ignored by git), after which
`tsc -p packages/claude-mod` type-checks it.

Checks:

```sh
claude plugin validate packages/claude-mod   # manifest + what the module hooks and calls
claude plugin test packages/claude-mod       # tests/*.test.ts against the engine (fake daemon via mcp.call hooks)
```

Known gap: a suite's "test N of M" is not exposed by the daemon; the band counts the runs it has seen since
the `run_suite` call started and uses `names.length` as the total when `names` was given.
