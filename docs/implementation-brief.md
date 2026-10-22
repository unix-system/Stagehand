# Implementation brief (Phase 1–4, parallel agents)

Read first: [architecture.md](architecture.md) (design), then the contracts below. Do not commit or push.

## Ownership

| Agent | Owns (may create/edit) | Must not edit |
|---|---|---|
| **A — TypeScript daemon** | `packages/mcp/**` (package `stagehand-mcp`, bin `stagehand-mcp`) | everything else |
| **B — Luau plugin** | `plugin/**`, `hooks/**`, `tools/**` | everything else |
| **C — Example + docs** | `examples/**`, `docs/writing-tests.md` | everything else |

Root files and the shared contracts are **read-only** for all three: `package.json`, `pnpm-workspace.yaml`,
`tsconfig.base.json`, `schema/catalog.json`, `schema/playtest.schema.json`, `docs/protocol.md`,
`docs/spec.md`, `docs/architecture.md`. If a contract looks wrong, work to the contract as written and put the
proposed change in your final report (one line each). Remove the `.gitkeep` in your directory once it has
real files.

## Contracts consumed

| Contract | A | B | C |
|---|---|---|---|
| `docs/protocol.md` (HTTP broker ↔ node, commands, events, errors) | implements broker side | implements node side | — |
| `schema/catalog.json` (actions/conditions, contexts, params) | loads for offline validation + routing | `Actions/*.luau` metas must match exactly; `tools/gen-catalog.luau` must reproduce the file byte-for-byte (2-space JSON, entries in file order) | uses names/params |
| `schema/playtest.schema.json` + `docs/spec.md` | zod schema equivalent to the JSON Schema; compiler follows spec.md resolution rules | coercion table + selector grammar (spec.md) in `Resolve.luau` | every example validates |

Key fixed values: port `45491` / `STAGEHAND_PORT`; long-poll 25 s; event flush 50 ms; daemon timeout = node
timeout + 2 s; idle session end 120 s; `protocolVersion: 1`; sessionId via
`StudioTestService:GetTestArgs().stagehand.sessionId`, fallback plugin setting `Stagehand.Session`.

## Per-agent checklist

**A — `packages/mcp`**
- [ ] `package.json` (type module, `build`/`test`/`lint` scripts, `tsconfig.json` extending `../../tsconfig.base.json`)
- [ ] `src/broker/*` per protocol.md, incl. playerIndex assignment + `session.ready` re-numbering, 410 re-attach
- [ ] `src/spec/*` loader (YAML/JSON), zod schema, catalog merge (static + live `game.*`), selectors (syntax), values
- [ ] `src/engine/*` compile → segments (merge consecutive same-node steps; `parallel` fork/join; `each` expansion; step ids per protocol.md), sessions (reuse/reset), run, reporter (`.stagehand/runs/<ts>-<name>/` NDJSON + JSON + Markdown)
- [ ] `src/server/*` MCP tools/resources/prompt listed in architecture.md
- [ ] vitest: routing for every catalog default, selector parsing, segment merging, spec examples, broker with a fake node (attach/poll/result/timeout/cancel)

**B — `plugin/`, `hooks/`, `tools/`**
- [ ] Rojo `default.project.json`, `wally.toml`, `selene.toml`, `stylua.toml` in `plugin/`
- [ ] `init.server.luau`, `Node`, `Transport/Http` (+ `Transport/Remote` stub), `Runner`, `Resolve`, `Conditions`, `Registry`, `Launcher`, `LogCapture`, `UI/`
- [ ] `Actions/*.luau` covering every `schema/catalog.json` entry, plus `GameHooks` (live `game.*`) and `Lua`
- [ ] `hooks/` Wally package `stagehand-hooks` (`Hooks.server{}`, `Hooks.client{}`, BindableFunction bridge)
- [ ] `tools/gen-catalog.luau` (Lune) → `schema/catalog.json`; write its output to a temp path, never overwrite the committed file
- [ ] Lune tests in `plugin/tests/` for `Resolve`, `Conditions`, `Registry` against a stubbed DataModel

**C — `examples/`, `docs/writing-tests.md`**
- [ ] `examples/place/` Rojo project: Teams Blue/Red, `ReplicatedStorage.Remotes.RequestSpawn` RemoteEvent, `Gun` tool, server script tagging characters that equip Gun `Hostile`, `StagehandBindings` registering `game.requestSpawn` / `game.reset` / `game.inMatch`
- [ ] `examples/playtests/*.playtest.yaml`: the three spec.md examples + 2–3 more; all must validate against `schema/playtest.schema.json` and use only catalog names (or `game.*` registered by the place)
- [ ] `docs/writing-tests.md`: author-facing guide (agent workflow: `inspect` → draft → `validate_test` → `run_steps` → `save_test`)

## Conventions

- TypeScript: strict (`tsconfig.base.json`), ESM, Node ≥ 20, vitest, no runtime deps beyond `@modelcontextprotocol/sdk`, `zod`, `yaml` without a note.
- Luau: `--!strict` where cheap (`--!nonstrict` acceptable for Roblox-API-heavy files), tabs (stylua defaults), selene `roblox` std. Configs live in `plugin/`.
- All tests run **offline with no Studio**: daemon tests use a fake node over real HTTP on an ephemeral port; Luau tests use a stubbed DataModel under Lune.
- JSON files: 2-space indent, trailing newline.

## Environment (this container)

- Available: **node 22**, **pnpm 10**, **cargo**.
- **Not installed:** `lune`, `rojo`, `wally`, `selene`, `stylua`. Luau code and Lune tests may be written but **cannot be executed here**; say so in your report and keep them syntactically conservative. Do not try to install them via cargo unless told to.
