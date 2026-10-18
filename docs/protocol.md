# Broker ↔ node protocol (v1)

The `stagehand-mcp` daemon runs an HTTP **broker**. Each plugin instance (one per DataModel) is a **node** that
attaches, long-polls for commands, posts results and streams events.

| Item | Value |
|---|---|
| Base URL | `http://127.0.0.1:<port>/v1` |
| Port | range `38491`–`38500`: the daemon binds the first free port in it (`--port` / `STAGEHAND_PORT` move the range start); the edit node attaches to every live daemon in the range (plugin setting `Stagehand.Port` moves its range start); server/client nodes attach only to the daemon that launched them (see "Several daemons and Studios") |
| Bind | `127.0.0.1` only |
| Encoding | JSON, UTF-8, `Content-Type: application/json` |
| `protocolVersion` | `1` (broker rejects a mismatch with `400 BAD_REQUEST`) |
| Long-poll | 25 000 ms |
| Event flush | every 50 ms, and immediately on any `step.passed/failed/skipped` |
| Daemon-side step timeout | node `timeoutMs` (or `withinMs`) + 2 000 ms |

## Endpoints

| Method + path | Direction | Success | Errors |
|---|---|---|---|
| `POST /v1/attach` | node → broker | `200` attach response | `400` |
| `GET /v1/poll?node=<nodeId>[&wait=<ms>]` | node → broker | `200 {command}` or `204` after 25 s (or `wait` ms) | `410` unknown node → re-attach |
| `POST /v1/result` | node → broker | `200 {ok:true}` | `404 BAD_REQUEST` unknown commandId (late result after a daemon timeout/cancel; the node ignores it), `410` |
| `POST /v1/events` | node → broker | `200 {ack:<lastSeq>}` | `410` |
| `GET /v1/health` | anyone | `200` health | — |

All non-2xx bodies are `{ "error": ErrorObject }`.

## Node roles and sessionId

| Role | Detected by | `sessionId` source |
|---|---|---|
| `edit` | `RunService:IsEdit()` | always `null` |
| `server` | `RunService:IsServer()` and not edit | 1. `StudioTestService:GetTestArgs().stagehand.sessionId`  2. `plugin:GetSetting("Stagehand.Session")`  3. `null` |
| `client` | `RunService:IsClient()` and not edit | same as server |

The edit node writes `Stagehand.Session` = sessionId and `Stagehand.SessionPort` = the launching daemon's
port **before** calling `Execute*Async` and clears them on `end_session`. A server/client node that finds no
sessionId still attaches; the broker marks it `orphan` and never dispatches steps to it.

## Several daemons and Studios

Every MCP client runs its own daemon, and several Studio windows may be open, so:

- A daemon binds the first free port in `38491`–`38500` and reports it in `stagehand_status` / `health`.
  Two daemons never share a port; a third-party process on a port is skipped like a daemon.
- The edit plugin instance keeps one edit **node per port in the range**, each attaching (with the usual
  backoff) to whatever daemon is there. Every daemon therefore sees every open Studio.
- A daemon that sees several edit nodes drives the one selected by `--place` / `STAGEHAND_PLACE` (placeId
  or a case-insensitive substring of the place name), else the most recently attached one; status lists
  them all so the choice is visible.
- `launch_session` test args carry the **launching daemon's port**; server/client nodes attach to that
  port only (fallback: the `Stagehand.SessionPort` setting). Another daemon never sees those nodes, so it
  cannot end them as strays; Studio runs one test at a time and its `launch_session` fails with
  `SESSION_ERROR "Studio is already running test session … for the daemon on port N"` while another
  daemon's session is live (the edit node waits up to 10 s for a stopping test first).
- A daemon that restarts lands on the same port, so a session it left behind re-attaches to it as a
  stray; before launching it sends `end_session` (EndTest) to that server node and waits for the edit
  node's `session.ended` (up to 20 s). `RunService:Stop()` on the edit node only ends Run mode: a
  Play/multiplayer test lives in its own DataModel and ignores it.
- `session.ended` is emitted on every edit node of that Studio; daemons ignore sessions they do not own.

## Attach

Request:

```json
{
  "protocolVersion": 1,
  "role": "client",
  "placeId": 1234567890,
  "placeName": "Example Place",
  "sessionId": "s_01J9Z4K2",
  "playerName": "Player1",
  "userId": -1,
  "playerIndex": null,
  "pluginVersion": "0.1.0",
  "transport": "http",
  "instanceId": "9f3a1c2e-41b07d55"
}
```

| Field | Type | Notes |
|---|---|---|
| `role` | `"edit" \| "server" \| "client"` | |
| `placeId` | integer | `game.PlaceId` (0 for unpublished) |
| `placeName` | string | `game.Name` |
| `sessionId` | string \| null | see table above |
| `playerName` | string \| null | client only (`Players.LocalPlayer.Name`); null for edit/server |
| `userId` | integer \| null | client only; Studio test users are negative |
| `playerIndex` | null | always null from nodes; the broker assigns it |
| `pluginVersion` | string | semver |
| `transport` | `"http" \| "remote"` | `remote` = client node relayed through the server node (play clients cannot use HttpService) |
| `instanceId` | string, optional | random per plugin Node, stable across its re-attaches |

Response:

```json
{ "nodeId": "n_7", "playerIndex": 1, "pollTimeoutMs": 25000, "eventFlushMs": 50, "brokerVersion": "0.1.0" }
```

Re-attaching with the same `instanceId` (or, when absent, the same `{role, sessionId, userId}` /
`{role:"edit", placeId}`) replaces the old node, keeps its `playerIndex`, and drops the old node's queued
commands with `CANCELLED`. `instanceId` keeps two Studio windows with unpublished places (both `placeId` 0)
from evicting each other in a loop.

### playerIndex assignment

1. Client nodes receive `playerIndex` 1..N in **attach order** within a session.
2. When the server node emits `session.ready {players:[…]}` (order of `Players:GetPlayers()`), the broker
   **re-numbers** clients so that `playerIndex = i` ⇔ `players[i-1].userId` (match by userId, then name).
3. No `run_segment` is dispatched for a session before `session.ready` and before all N clients are attached.
   Nodes read their final index from `run_segment.steps[].actor.playerIndex`; they never need to store it.

### Actor → node resolution (done by the daemon at compile/dispatch time)

| Step context | Target node | Actor meaning on the node |
|---|---|---|
| `client` | client node with `{sessionId, playerIndex: actor.playerIndex}`; no actor → p1; players=0 → compile error | `Players.LocalPlayer` |
| `server` | the session's server node | `Player` whose userId = `session.ready.players[playerIndex-1].userId` |
| `edit` | edit node with matching `placeId` | none (actor ignored) |

## Poll and commands

```http
GET /v1/poll?node=n_7
GET /v1/poll?node=n_7&wait=0
```

`wait` (ms, optional) caps how long the broker holds the request open; it is clamped to
`[0, pollTimeoutMs]` and defaults to `pollTimeoutMs`. `wait=0` answers at once (`200` if a command is
queued, else `204`).

**Session nodes short-poll.** A game server in a Studio test caps its concurrent HttpService requests
(measured: with the server's long-poll and one relayed client long-poll open, further requests ran one
at a time), so long-polls from the server node and the clients it relays starve each other's polls,
events and results, and commands reached clients seconds late. Server and client nodes therefore poll
with `wait=0` and re-poll after `100 ms` when nothing is queued (at once after a command). The edit node
keeps the long-poll.

`200`:

```json
{ "command": { "id": "c_42", "type": "run_segment", "params": { } } }
```

`204` (no body) → poll again immediately. The node handles one command at a time per type except
`run_segment`, `cancel` and `ping`, which it processes concurrently (each in its own coroutine, while it
keeps polling).

**One command per type per node**, except `run_segment`, `cancel` and `ping`. The broker enforces this on
its side too: it delivers at most one in-flight command of each other type to a node (a second `eval` stays
queued until the first one's result arrives or times out). Several `run_segment`s may be in flight on one
node, so parallel branches that target the same node run concurrently (e.g. holding Shift in one branch
while `input.move` holds W in another). Each segment has its own `segmentId`, vars and cancel flag; a `log`
event's `stepId` is the most recently started step that is still running on that node.

## Result

```json
{ "node": "n_7", "commandId": "c_42", "ok": true, "result": { } }
```

```json
{ "node": "n_7", "commandId": "c_42", "ok": false, "error": { "code": "RESOLVE_FAILED", "message": "…" } }
```

A failed step is **not** a command error: `run_segment` returns `ok:true` with `status:"failed"`.
`ok:false` is for commands that could not execute at all.

## Commands

| type | Sent to | params | result |
|---|---|---|---|
| `run_segment` | any | see below | see below |
| `cancel` | any | `{ "segmentId": "seg_3" }` or `{ "segmentId": "all" }` | `{ "cancelled": ["seg_3"] }` |
| `catalog` | any | `{}` | `{ "entries": [CatalogEntry…] }` (static + live `game.*`, shape of `schema/catalog.json` entries) |
| `inspect` | any | `{ "path"?: string, "tag"?: string, "className"?: string, "depth": 1, "limit": 200 }` (exactly one of path/tag/className) | `{ "nodes": [InspectNode…], "truncated": false }` |
| `eval` | any | `{ "code": string, "env": { "actor"?: Actor, "vars"?: object } }` | `{ "value": any, "logs": [LogEvent…] }` |
| `launch_session` | edit | `{ "sessionId": string, "mode": "run" \| "play" \| "multiplayer", "players": 0..8 }` | `{ "accepted": true }` (immediately; readiness = `session.ready` event) |
| `end_session` | server (edit fallback) | `{ "sessionId": string, "result"?: "passed" \| "failed", "abandon"?: boolean }` | `{ "ended": boolean, "via": "EndTest" \| "RunService.Stop", "reason"?: string, "abandoned"?: boolean }` — the edit fallback answers `ended: false` with a `reason` for a Play/multiplayer test, which `RunService:Stop()` cannot end. `abandon` (edit only): the daemon gave up on a launch whose server node never attached; the Launcher forgets that session (`current` → `null`, `last.result` = `"abandoned: …"`) so the next `launch_session` is not refused for a test Studio may never have started |
| `launcher_status` | edit | `{}` | `{ "current": { sessionId, mode, players, port, startedAt } \| null, "last": { sessionId, ok, result, endedAt, elapsedMs } \| null }` — what the shared Launcher believes Studio is running (any daemon's test) |
| `add_players` | server | `{ "count": 1..7 }` | `{ "requested": 1 }` |
| `ping` | any | `{}` | `{ "pong": true, "t": 1234.5 }` |
| `progress` | edit, client | Progress snapshot (below) | `{}` |

`progress` drives the "Stagehand Progress" dock widget in every Studio window of a test. The daemon sends
the whole snapshot to the newest edit node and to every client node of the run's session once the session
is ready, whenever a step changes (coalesced to one send per 150 ms), and once when the run finishes.
Failures to deliver are ignored. The edit node's widget covers the main window in Run mode and in a
multiplayer test (where the main window stays on the edit DataModel); every client node shows its own
widget, because in Play solo the main window displays the client DataModel and hides the edit node's
widgets until the test stops, and multiplayer clients have windows of their own. Snapshot:

```json
{
  "runId": "r_…", "name": "smoke-play", "status": "running",
  "total": 11, "finished": 4,
  "steps": [
    { "id": "steps.0", "display": "wait character.alive as p1", "target": "server", "status": "passed",
      "verb": "wait", "soft": false, "timeoutMs": 10000, "durationMs": 1204 },
    { "id": "steps.4", "display": "spawn via menu", "target": "client#1", "status": "running",
      "verb": "do", "soft": false, "timeoutMs": 10000, "elapsedMs": 2400 },
    { "id": "steps.5", "display": "expect character.health as p1 on client", "target": "client#1",
      "status": "failed", "verb": "expect", "soft": false, "timeoutMs": 3000, "durationMs": 3002,
      "reason": "condition character.health not true within 3s" }
  ]
}
```

`status` (run): `running | passed | failed | cancelled | error`. Step `status`: `pending | running | passed |
failed | skipped | cancelled`. `target`: `server | client#N | edit | daemon`; the widget groups its
per-client summary by it, and a client's widget marks its own `client#<playerIndex>` steps and folds the
runs of steps that execute elsewhere into collapsible groups. `elapsedMs` (running steps) is the time since
the step started as of this snapshot: the widget keeps counting with its own clock, so no clock
synchronisation is needed; `timeoutMs` is the step budget, `durationMs` the final time of finished steps.
Older snapshot fields stay as they were; a plugin ignores fields it does not know.

`launch_session` on the edit node: write the `Stagehand.Session` / `Stagehand.SessionPort` settings, then
call (in a new thread) `ExecuteRunModeAsync(args)` for `run`, `ExecutePlayModeAsync(args)` for `play`,
`ExecuteMultiplayerTestAsync(players, args)` for `multiplayer`, with
`args = { stagehand = { sessionId = …, port = <port of the daemon that sent the command>, mode = …, players = … } }`. The server node reads
`players` from `GetTestArgs().stagehand` to know how many players to wait for before `session.ready`
(Run mode: 0; without test args it emits after 1.5 s without joins). Run mode simulates inside the edit
DataModel, so the edit plugin instance also hosts that session's server node. When `Execute*Async`
returns (test stopped, `EndTest`, or an error) the edit node clears the setting (unless a newer launch
owns it) and emits `session.ended`.

The daemon bounds an accepted launch twice: the test's server node must attach within 30 s (Studio
normally starts a test in 3–6 s; it stalls when paused in the background, behind a modal dialog, or
while still tearing down the previous test), and `session.ready` must arrive within 60 s; multiplayer
gets 1.5× both. On either timeout the launch fails with `SESSION_ERROR` and the daemon ends the test
(`end_session` on the server node, else the edit node with `abandon: true`).

The server node emits `session.ready` once the expected players are in and every character is loaded,
or after a grace period: 8 s when some character model exists but is still loading, 2.5 s when no
player has a character at all (the game spawns them itself, e.g. after a menu).

There is no `clear_logs` command. Node-side log buffers (used by node-evaluated `log.*` steps with
`scope: server|client` and by `eval` logs) are scoped per `runId`: the window starts at the first
`run_segment` of a new run on that node and is not cleared by a reset (`respawn` / `hook`). The daemon's own
log window (for `scope: all`) is per run as well.

### run_segment

```json
{
  "runId": "r_20261015T150102_blue-team-gun-hostile",
  "segmentId": "seg_2",
  "vars": { "spawn": [120, 5, -40] },
  "actors": { "p1": 1, "blue": 1 },
  "steps": [
    {
      "id": "steps.3",
      "verb": "do",
      "name": "character.teleport",
      "params": { "to": [120, 5, -40] },
      "timeoutMs": 10000,
      "withinMs": null,
      "soft": false,
      "actor": { "name": "p1", "playerIndex": 1 },
      "label": null,
      "save": null
    },
    {
      "id": "steps.5",
      "verb": "expect",
      "name": "instance.hasTag",
      "params": { "target": "@p1.character", "tag": "Hostile" },
      "timeoutMs": 10000,
      "withinMs": 2000,
      "soft": false,
      "actor": { "name": "p1", "playerIndex": 1 },
      "label": null,
      "save": null
    },
    {
      "id": "steps.6",
      "verb": "lua",
      "name": null,
      "params": { "code": "return workspace:GetAttribute('Round')" },
      "timeoutMs": 10000,
      "withinMs": null,
      "soft": false,
      "actor": null,
      "label": "read round",
      "save": "round"
    }
  ]
}
```

| Step field | Type | Notes |
|---|---|---|
| `id` | string | stable path in the spec: `setup.N`, `steps.N`, `teardown.N`, nested `steps.4.parallel.1.0`, `steps.2.each.p2.1`, `steps.0.use.<fragment>.3` (a `use:` expansion) |
| `verb` | `"do" \| "wait" \| "expect" \| "lua"` | `parallel`/`each` are compiled away by the daemon |
| `name` | string \| null | catalog name (`lua` for `wait: lua`/`expect: lua`); null for a `lua` verb |
| `params` | object | `$var` already substituted where known at compile time; values still in JSON form (node coerces per catalog param type) |
| `timeoutMs` | integer | wait budget / action budget |
| `withinMs` | integer \| null | `expect` only: poll until true for this long; null = instant check |
| `soft` | boolean | failure is recorded but the segment continues |
| `actor` | `{name, playerIndex}` \| null | |
| `label` | string \| null | display only |
| `save` | string \| null | store the action's / lua's return value in `vars[save]` |
| `if` | string? | **optional, normally absent.** The daemon evaluates `if: $var` itself before dispatch (see below) and does not send it. A node that receives it skips the step (`step.skipped`, reason `if`) when the var is falsy; absent = run |

| Segment field | Type | Notes |
|---|---|---|
| `runId`, `segmentId` | string | reset segments use `reset_<sessionId>_<n>` / `reset_<n>` |
| `vars` | object | the run's vars at dispatch time |
| `actors` | object | **always sent**: the run's full actor map, name → playerIndex (`p1..pN` plus spec aliases). Nodes use it to resolve selectors naming an actor other than the step's own (`@red.character` in a step `as: blue`); unknown names fall back to `pN` parsing |
| `steps` | WireStep[] | |

### Daemon-evaluated steps

Some steps never reach a node; the daemon runs them itself and emits the same `step.*` events to MCP:

| Step | Daemon behaviour |
|---|---|
| `if: $var` (any step, `parallel`, `each`) | checked against the run's vars just before the step's segment would be dispatched; falsy (`null`, `false`, `0`, `""`, missing; same rule on nodes) → every step in scope is `skipped` with reason `if`; a step carrying `if` is dispatched as its own segment |
| `wait`/`expect` `log.noErrors`, `log.matches` with `scope: all` (the default) | evaluated over the run's collected `log` events from every node of the session (after a 150 ms settle, polling until `timeoutMs`/`withinMs`) |
| `log.*` with `scope: server` / `client` | sent to that node like any condition (node-side buffer, see above) |
Node rules: execute steps in order; vars referenced as `$name` that were left unresolved are substituted from
`params.vars` + values saved earlier in this segment; on a non-soft failure stop and mark remaining steps
`skipped` (reason `aborted`).

Result:

```json
{
  "segmentId": "seg_2",
  "status": "failed",
  "steps": [
    { "id": "steps.3", "status": "passed", "durationMs": 12, "value": 2 },
    { "id": "steps.5", "status": "failed", "durationMs": 2003,
      "reason": "condition instance.hasTag not true within 2s",
      "expected": { "target": "Workspace.Player1", "tag": "Hostile", "value": true },
      "actual": { "value": false, "tags": ["Blue"] },
      "error": { "code": "ASSERTION_FAILED", "message": "…", "stepId": "steps.5" } },
    { "id": "steps.6", "status": "skipped", "durationMs": 0 }
  ],
  "vars": { "spawn": [120, 5, -40] }
}
```

`status` ∈ `passed | failed | cancelled`; step `status` ∈ `passed | failed | skipped | cancelled`.

| Result entry field | When | Notes |
|---|---|---|
| `value` | a `lua` step or an action returned a non-nil value, or the step has `save` | the serialized return value (`save` stores it in `vars`; with `save` a nil value is sent as `null`) |
| `reason` | `failed` / `cancelled` | the same text as the `step.failed` event (`"cancelled"` for cancelled) |
| `expected`, `actual` | `failed`, when known | **omitted** when unknown (not `null`); conditions fill them, actions do not |
| `error` | `failed` / `cancelled` | ErrorObject, same as the event |

The failure details are carried in the result **and** in the `step.failed` event: the result is the
authoritative, in-order answer to the command, while events travel on a separate channel (client nodes relay
them through the server) and may arrive after the result. The daemon fills a step record from whichever
arrives first and only completes missing fields from the other. `vars` is the full var map after the segment
(the daemon merges it).

### Cancel

On `cancel` the node flips the segment's cancel flag; the running step stops at its next yield, and the node
reports it as **`step.failed` with `error.code: "CANCELLED"`** (result entry `status: "cancelled"`); remaining
steps get result status `cancelled`. The daemon records such a step as **`cancelled`, not `failed`**, when it
sent the `cancel` itself (run cancel, a sibling `parallel` branch failed, run timeout). Exceptions: a step
the daemon already failed (run timeout → `TIMEOUT`, daemon-side step timeout) keeps its failure, and a
`CANCELLED` the daemon did not initiate (e.g. re-attach dropped the command) counts as a failure.

## Events

```json
{
  "node": "n_7",
  "events": [
    { "seq": 101, "type": "step.started", "t": 5123.4, "runId": "r_…", "segmentId": "seg_2", "stepId": "steps.5" },
    { "seq": 102, "type": "log", "t": 5130.0, "level": "warn", "message": "Gun: no ammo", "node": "n_7", "stepId": "steps.5" },
    { "seq": 103, "type": "step.failed", "t": 7126.9, "runId": "r_…", "segmentId": "seg_2", "stepId": "steps.5",
      "reason": "condition instance.hasTag not true within 2s",
      "expected": { "target": "Workspace.Player1", "tag": "Hostile", "value": true },
      "actual": { "value": false, "tags": ["Blue"] },
      "error": { "code": "ASSERTION_FAILED", "message": "…" } }
  ]
}
```

Every event has `seq` (monotonic per node, starts at 1 per attach), `type`, `t` (ms, `os.clock()*1000` on the
node). Response `{ "ack": 103 }`; the node may drop acknowledged events.

| type | Emitted by | Extra fields |
|---|---|---|
| `node.ready` | node, after attach + catalog built | `role`, `catalogHash` (see below) |
| `session.ready` | server node, after required players joined and their characters loaded, or after a grace period when the game does not spawn them (2.5 s with no character at all, e.g. menu flows; 8 s while a character is still loading) | `sessionId`, `players: [{name, userId}]` in `Players:GetPlayers()` order, `charactersLoaded` (boolean; false after the grace period) |
| `session.ended` | edit node, when `Execute*Async` returns | `sessionId`, `ok` (boolean), `reason` (string), `result?` (string: what `Execute*Async` returned, i.e. the `EndTest` argument when the game or a tool ended the test), `elapsedMs?` (test lifetime) |
| `segment.started` | node | `runId`, `segmentId` |
| `segment.finished` | node | `runId`, `segmentId`, `status` |
| `step.started` | node | `runId`, `segmentId`, `stepId` |
| `step.passed` | node | `…stepId`, `durationMs`, `value?` |
| `step.failed` | node | `…stepId`, `durationMs`, `reason` (string), `expected` (any), `actual` (any), `error` (ErrorObject) |
| `step.skipped` | node or daemon | `…stepId`, `reason: "if" \| "aborted"` |
| `log` | node (`LogService.MessageOut`) | `level: "info" \| "warn" \| "error"`, `message`, `node` (nodeId), `stepId \| null` |
| `run.started` / `run.finished`, `step.cancelled` | daemon only (never on the wire; forwarded to MCP) | `runId`, `status?` |

`catalogHash`: lowercase sha1 hex of the node's catalog entries (static + live `game.*`) sorted by `name`,
one line per entry `name .. compactJson(params)`, lines joined by `"\n"`. The daemon treats it as
**opaque**: it stores it per node (shown in health) and only ever compares hashes for equality; it always
fetches the full catalog with the `catalog` command after `node.ready`.

`session.ended` handling: if `sessionId` is the daemon's current session (and the daemon is not already
ending it), the daemon marks the session `ended`, clears its current session, and drops the session's
server/client nodes, which rejects their in-flight commands (an in-flight `run_segment` fails its step with
`SESSION_ERROR`). The next run launches a fresh session.

`MessageOutput` → level: `MessageOutput`/`MessageInfo` → `info`, `MessageWarning` → `warn`, `MessageError` → `error`.
With `failOnError: true` the daemon fails the active step on any `log` with `level:"error"` from any node in the session
(error code `ACTION_ERROR`, `expected: {errors: 0}`); an error logged while no step is active fails the run.

## Health

```json
{
  "ok": true,
  "version": "0.1.0",
  "port": 38491,
  "uptimeMs": 81234,
  "nodes": [
    { "nodeId": "n_1", "role": "edit", "placeId": 1234567890, "sessionId": null, "playerIndex": null, "playerName": null, "orphan": false, "lastSeenMs": 120 },
    { "nodeId": "n_7", "role": "client", "placeId": 1234567890, "sessionId": "s_01J9Z4K2", "playerIndex": 1, "playerName": "Player1", "orphan": false, "lastSeenMs": 40 }
  ],
  "sessions": [ { "sessionId": "s_01J9Z4K2", "mode": "play", "players": 1, "state": "ready" } ],
  "activeRun": null
}
```

Session `state` ∈ `launching | ready | resetting | ending | ended`. A node is dropped after 60 s without a poll.

## Error object

```json
{ "code": "RESOLVE_FAILED", "message": "selector @p1.backpack.Gun matched nothing", "stepId": "steps.4", "details": { "selector": "@p1.backpack.Gun" } }
```

| code | Meaning |
|---|---|
| `BAD_REQUEST` | malformed body, wrong `protocolVersion` (HTTP 400); unknown route or unknown `commandId` on `/v1/result` (HTTP 404) |
| `UNKNOWN_NODE` | nodeId not attached (HTTP 410) |
| `UNKNOWN_COMMAND` | command `type` not supported by this node/role |
| `UNKNOWN_ACTION` | step `name` not in the node's catalog |
| `BAD_PARAMS` | params fail the catalog schema or coercion |
| `RESOLVE_FAILED` | selector / actor did not resolve |
| `TIMEOUT` | wait or action exceeded `timeoutMs` (node) or +2 s (daemon); run-level `timeout` exceeded |
| `CANCELLED` | cancelled by `cancel` or re-attach |
| `ACTION_ERROR` | action threw; also set by the daemon when `failOnError` fails a step on an error log |
| `ASSERTION_FAILED` | `expect` condition false |
| `LUA_ERROR` | `lua` / `eval` code threw or failed to compile |
| `SESSION_ERROR` | launch / end / add_players failed; set by the daemon when a node drops (expired, re-attached away, `session.ended`) while a command is in flight, or a session never becomes ready |
| `EVAL_DISABLED` | `eval` while the daemon runs without `--allow-eval` (returned by the daemon, not nodes) |
| `INTERNAL` | anything else |

## Shared shapes

```ts
type Actor = { name: string; playerIndex: number };
type InspectNode = { path: string; className: string; name: string; attributes: Record<string, unknown>;
                     tags: string[]; children?: InspectNode[] };
type LogEvent = { level: "info" | "warn" | "error"; message: string; t: number };
```

Roblox values in `result`, `value`, `expected`, `actual`, `attributes`: Vector3 → `[x,y,z]`, CFrame →
`{pos:[…], look:[…]}`, Color3 → `"#rrggbb"`, EnumItem → `"Enum.X.Y"`, Instance → full-name path string,
other userdata → `tostring(v)`.
