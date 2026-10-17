# Stagehand

Declarative, agent-driven playtests for Roblox Studio. A test is a YAML list of `do` / `wait` / `expect`
steps; an MCP server (`stagehand-mcp`, TypeScript) compiles it and drives a Studio plugin (Luau) that runs
as a node inside each DataModel (edit, server, every client). Read `docs/architecture.md` first for the
design; `docs/protocol.md`, `docs/spec.md` and `schema/*.json` are the contracts everything else follows.

## Layout

| Path | What | Toolchain |
|---|---|---|
| `packages/mcp/` | `stagehand-mcp`: MCP server (stdio) + localhost broker + engine + stores. `src/{broker,engine,spec,server,store}` | TypeScript strict, NodeNext ESM, vitest, ajv, zod |
| `plugin/` | Studio plugin (Rojo project → `Stagehand.rbxm`). `src/{Node,Runner,Resolve,Conditions,Registry,Launcher,LogCapture}.luau`, `src/Actions/*.luau`, `src/UI/` | Luau, Rojo, Lune tests in `plugin/tests`, selene, stylua |
| `hooks/` | `stagehand-hooks` Wally package: `Hooks.server{}` / `Hooks.client{}` expose game-specific `game.*` actions through a BindableFunction | Luau |
| `packages/claude-mod/` | `stagehand-progress`: Claude Code mod (function hooks) that shows runs live in a band, a pane and the status line by polling `get_run`/`tail_run` over the session's MCP connection. Not a pnpm package | `claude plugin validate/test`, tsc against the engine-laid types |
| `tools/` | `gen-catalog.luau` (Lune) regenerates `schema/catalog.json`; `lib/loader.luau` loads plugin modules outside Studio | Lune |
| `schema/` | `catalog.json` (all actions/conditions, contexts, params) and `playtest.schema.json` | committed, CI-checked |
| `examples/` | `place/` sample game (Rojo) and `playtests/*.playtest.yaml` | Rojo |
| `docs/` | architecture, protocol, spec, writing-tests, mcp, plugin, implementation-brief | |

## Commands

```bash
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r test                     # daemon: tsc build + vitest (173 tests)
pnpm --filter stagehand-mcp lint                  # tsc --noEmit
lune run plugin/tests/run.luau                    # plugin unit tests against a stub DataModel (44)
lune run tools/gen-catalog.luau schema/catalog.json && git diff --exit-code schema/catalog.json
stylua --check --config-path plugin/stylua.toml plugin hooks tools examples/place/src
cd plugin && selene generate-roblox-std && selene . ../hooks   # needs network for the API dump
rojo build plugin -o Stagehand.rbxm; rojo build hooks -o hooks.rbxm; rojo build examples/place -o place.rbxl
```

CI (`.github/workflows/ci.yml`) runs exactly these. Run the relevant ones before pushing; all must stay green.
Luau tools install via GitHub release binaries (versions pinned in ci.yml); `cargo`/`npm` do not provide them.

## Invariants (do not break)

- **Catalog parity.** `plugin/src/Actions/*.luau` metas are the source of truth; `schema/catalog.json` must
  be byte-identical to the generator output. Add or change an action in the Luau meta, regenerate, then
  update the daemon only if routing or param handling changes. Never hand-edit `catalog.json`.
- **Instance-path requires only** in `plugin/src` and `hooks/src`: `require(script.Parent.X)`. No string
  requires (selene rejects them). Lune tests and the generator load modules through `tools/lib/loader.luau`,
  which builds a fake Instance tree from the directory; use `H.require(H.src.X)` in specs.
- **Protocol changes go through `docs/protocol.md` first**, then both `packages/mcp/src/broker/protocol.ts`
  and `plugin/src/Node.luau`. Daemon and plugin were built against that document; keep it accurate.
- **Spec/schema.** `schema/playtest.schema.json`, `docs/spec.md` and the zod schema in
  `packages/mcp/src/spec/schema.ts` must agree. Every file in `examples/playtests` must validate.
- **Context routing** lives in the catalog (`contexts`, `default`, `actor`) and `packages/mcp/src/engine/compile.ts`.
  Authors never choose server/client; do not add per-step routing hacks elsewhere.
- Tests must run offline with no Studio: fake nodes over real HTTP for the daemon, stub DataModel for Luau.

## Conventions

- TypeScript: strict, no `any` in `src/` without a comment, small modules, vitest files mirror `src/`.
- Luau: `--!strict` where cheap, pcall around every Studio-only service, never error on plugin load.
- Durations in specs are strings (`10s`, `250ms`); plain numbers mean seconds.
- Error codes, event names and command names are listed in `docs/protocol.md`; add new ones there.
- Commit messages: imperative subject, body explains why. No model names in commits or code.

## Gotchas

- Nothing has been verified inside real Roblox Studio yet. `docs/architecture.md` ends with the Phase 0
  spike checklist (plugin loading in client DataModels, `GetTestArgs` from plugin context, localhost HTTP
  permission prompt, VirtualInput, `EndTest` teardown). If a Studio API misbehaves, start in
  `plugin/src/Launcher.luau` and `plugin/src/Actions/Input.luau`.
- `selene generate-roblox-std` needs network access to the Roblox API dump; in sandboxes without it, rely on CI.
- Nodes that re-attach with the id of an already-ended session attach as orphans with no session id
  (`packages/mcp/src/broker/nodes.ts`); session-manager tests depend on this.
- Multiplayer sessions open extra Studio windows and take 10–20 s; keep `session.reuse` on in suites.
- `plugin/selene.toml` excludes `tests/**`; the hooks package is linted with the plugin config from `plugin/`.
