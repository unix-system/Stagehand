# Your first playtest

Build Stagehand, connect your coding agent, and run a playtest against the included sample game.

## Prerequisites

- Roblox Studio installed and signed in.
- Node.js 20 or newer, pnpm 10, and Git.
- [Rojo 7.x](https://rojo.space/docs/v7/getting-started/installation/) for building the plugin and sample place.
- An MCP-capable coding agent. The example below uses Claude Code; see [client configuration](mcp.md#client-configuration) for other clients.

## 1. Build the server and Studio files

```sh
git clone https://github.com/unix-system/Stagehand.git
cd Stagehand
pnpm install --frozen-lockfile
pnpm build
rojo build plugin -o Stagehand.rbxm
rojo build examples/place -o StagehandExample.rbxl
```

The MCP entry point is `packages/mcp/dist/index.js`. In Studio, open **Plugins → Plugins Folder** and copy `Stagehand.rbxm` into that folder. Restart Studio, then open `StagehandExample.rbxl`.

The sample place already includes the game hooks and tools used by the example tests. You do not need to install Wally packages for this sample.

## 2. Connect your coding agent

Register Stagehand from the directory where you use your agent. Replace both paths below with absolute paths to your checkout:

```sh
claude mcp add stagehand -- node /absolute/path/Stagehand/packages/mcp/dist/index.js --root /absolute/path/Stagehand/examples
```

On Windows, quote paths containing spaces; forward slashes work for Node paths, such as `"C:/Users/you/Projects/Stagehand/examples"`.

Restart or reconnect your agent's MCP session after registration. The `--root` directory contains the `playtests/` folder; use `examples` for this walkthrough, not the repository root.

When Studio requests permission for the plugin to access localhost, allow it. The daemon uses the first free port in its configured localhost range; `stagehand_status` reports the selected port. See [plugin setup](plugin.md) if the connection does not appear.

## 3. Check the connection and run the test

Ask your agent:

> Use Stagehand to check its status and list the saved tests. Validate and run `blue-team-gun-hostile`, then explain the result and any failing step.

The corresponding MCP tools are `stagehand_status`, `list_tests`, `validate_test`, and `run_test`. Keep the sample place open in edit mode; Stagehand launches the Play session.

The test puts `p1` on the Blue team, spawns the character using a game hook, equips the Gun, and checks for the `Hostile` tag. A successful run reports passed steps. If it fails, inspect the reported reason and nearby logs before retrying.

::: tip Multiple open places
Pass `--place` with a place ID or a distinctive part of its name to select the Studio instance to drive.
:::

## 4. Bring Stagehand to your game

Register the same MCP binary with `--root` pointing to your game's project directory. Save tests in that project's `playtests/` folder, use [built-in actions](reference/index.md), and expose game-specific operations through [game hooks](game-hooks.md).

- [Writing playtests](writing-tests.md) covers selectors, actors, fragments, and expectations.
- [MCP tools](mcp.md) covers inspecting the live game and reviewing runs.
- [Playtest specification](spec.md) documents the complete format.

## Common setup problems

| Symptom | Check |
| --- | --- |
| No Studio node appears | Confirm the plugin is installed, the place is open, and localhost permission is allowed. |
| No saved tests appear | Check that `--root` points to the directory containing `playtests/`. |
| The sample cannot find a hook or tool | Open the built sample place, rather than an empty baseplate. |
| Studio is already running a test | Stop the current test or use the MCP `stop_session` tool before launching another. |
