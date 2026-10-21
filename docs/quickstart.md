# Your first playtest

Use this guide to install Stagehand and run a test in the sample game.

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

The MCP entry point is `packages/mcp/dist/index.js`.

1. In Studio, open **Plugins → Plugins Folder**.
2. Copy `Stagehand.rbxm` into that folder.
3. Restart Studio.
4. Open `StagehandExample.rbxl`.

The sample place includes the hooks and tools for the example tests. This sample does not need Wally packages.

## 2. Connect your coding agent

Register Stagehand from your agent's project directory. Replace the two example paths with absolute paths to your local repository:

```sh
claude mcp add stagehand -- node /absolute/path/Stagehand/packages/mcp/dist/index.js --root /absolute/path/Stagehand/examples
```

On Windows, put quotation marks around paths that contain spaces. Node accepts forward slashes, for example `"C:/Users/you/Projects/Stagehand/examples"`.

After registration, restart your agent's MCP session. Set `--root` to the `examples` directory for this procedure. Stagehand looks for `playtests/` in that directory.

When Studio requests localhost access for the plugin, select **Allow**. The daemon uses the first available port in its configured range. The `stagehand_status` tool reports the selected port. If Stagehand does not connect, see [plugin setup](plugin.md).

## 3. Check the connection and run the test

Ask your agent:

> Use Stagehand to check the connection. List the saved tests. Validate `blue-team-gun-hostile`. Run the test. Explain the result and any failed step.

Use the `stagehand_status`, `list_tests`, `validate_test`, and `run_test` MCP tools for these actions. Keep the sample place open in edit mode. Stagehand starts the Play session.

The test assigns `p1` to the Blue team. A game hook creates the character. The test equips the Gun and checks for the `Hostile` tag. If the test fails, read the cause and logs before you run it again.

::: tip Multiple open places
Pass `--place` with a place ID or a distinctive part of its name to select the Studio instance to drive.
:::

## 4. Configure Stagehand for your game {#_4-bring-stagehand-to-your-game}

Set `--root` to your game's project directory. Save tests in its `playtests/` folder. Use [built-in actions](reference/index.md) for common operations. Use [game hooks](game-hooks.md) to call functions in your game.

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
