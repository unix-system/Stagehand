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

## Install (sketch)

1. `pnpm install && pnpm build`
2. Add the server to your agent's MCP config: `{ "command": "stagehand-mcp", "args": [] }` (port `38491`, override with `STAGEHAND_PORT`).
3. Install `Stagehand.rbxm` into your Studio plugins folder (built from `plugin/` with Rojo) and allow localhost HTTP when prompted.
4. Optional: add the `stagehand-hooks` Wally package to your game to expose `game.*` actions.

## Repo layout

| Path | What |
|---|---|
| `packages/mcp/` | `stagehand-mcp`: MCP server, HTTP broker, engine, stores (TypeScript) |
| `plugin/` | Stagehand Studio plugin (Luau, Rojo) |
| `hooks/` | `stagehand-hooks` Wally package for game-defined actions |
| `tools/` | Lune scripts (catalog generator) |
| `schema/` | `catalog.json`, `playtest.schema.json` (shared contracts) |
| `examples/` | Sample place and playtests |
| `docs/` | Documentation |

## Docs

- [Architecture](docs/architecture.md)
- [Playtest spec](docs/spec.md)
- [Broker ↔ node protocol](docs/protocol.md)
- [Implementation brief](docs/implementation-brief.md)

MIT licensed.
