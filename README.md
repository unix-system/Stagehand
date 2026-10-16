<p align="center"><img src="docs/logo.svg" alt="Stagehand" width="160"></p>

# Stagehand

Declarative, agent-driven playtests for Roblox Studio. Write a playtest as a short YAML list of
**actions**, **waits** and **expectations**; a coding agent runs it through the `stagehand-mcp` MCP server,
and the Stagehand Studio plugin executes each step on the edit, server or client DataModel, with live
step-by-step reporting.

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

## Quickstart

1. Build the daemon: `pnpm install && pnpm build` (Node 20+, pnpm 10). This produces the `stagehand-mcp`
   binary at `packages/mcp/dist/index.js`.
2. Register it with your agent, from your game's project directory, e.g.
   `claude mcp add stagehand -- node /path/to/Stagehand/packages/mcp/dist/index.js` (broker port `38491`,
   override with `--port` or `STAGEHAND_PORT`; add `--allow-eval` to enable `eval_lua`). See [docs/mcp.md](docs/mcp.md).
3. Build and install the Studio plugin: `rojo build plugin --plugin Stagehand.rbxm` (or
   `rojo build plugin -o Stagehand.rbxm` and copy it into your plugins folder). Allow localhost HTTP when
   Studio prompts. See [docs/plugin.md](docs/plugin.md).
4. Optional: expose game-defined `game.*` actions with the `hooks/` package (`StagehandHooks`); the example
   place maps it from `hooks/src` via Rojo.
5. Try the example: `rojo build examples/place -o StagehandExample.rbxl`, open it in Studio, and point the
   daemon at `--root examples` to run the playtests in `examples/playtests/`.

## Repo layout

| Path | What |
|---|---|
| `packages/mcp/` | `stagehand-mcp` (bin): MCP server, HTTP broker, engine, stores (TypeScript, vitest) |
| `plugin/` | Stagehand Studio plugin (Luau, Rojo; Lune tests in `plugin/tests/`) |
| `hooks/` | `StagehandHooks` package for game-defined `game.*` actions |
| `tools/` | Lune scripts (`gen-catalog.luau` regenerates/checks `schema/catalog.json`) |
| `schema/` | `catalog.json`, `playtest.schema.json` (shared contracts) |
| `examples/place/` | Sample Rojo place (teams, spawns, gun tool, hook bindings) |
| `examples/playtests/` | Sample `*.playtest.yaml` files |
| `docs/` | Documentation |

## Docs

- [Writing tests](docs/writing-tests.md)
- [MCP server and tools](docs/mcp.md)
- [Studio plugin](docs/plugin.md)
- [Playtest spec](docs/spec.md)
- [Broker ↔ node protocol](docs/protocol.md)
- [Architecture](docs/architecture.md)
- [Implementation brief](docs/implementation-brief.md)

MIT licensed.
