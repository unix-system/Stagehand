# Broker ↔ node protocol (v1)

The `stagehand-mcp` daemon runs an HTTP **broker**. Each plugin instance (one per DataModel) is a **node** that
attaches, long-polls for commands, posts results and streams events.

| Item | Value |
|---|---|
| Base URL | `http://127.0.0.1:<port>/v1` |
| Port | `38491` default; env `STAGEHAND_PORT` (daemon); plugin setting `Stagehand.Port` (node) |
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
| `GET /v1/poll?node=<nodeId>` | node → broker | `200 {command}` or `204` after 25 s | `410` unknown node → re-attach |
| `POST /v1/result` | node → broker | `200 {ok:true}` | `404` unknown commandId, `410` |
| `POST /v1/events` | node → broker | `200 {ack:<lastSeq>}` | `410` |
| `GET /v1/health` | anyone | `200` health | — |

All non-2xx bodies are `{ "error": ErrorObject }`.

## Node roles and sessionId

| Role | Detected by | `sessionId` source |
|---|---|---|
| `edit` | `RunService:IsEdit()` | always `null` |
| `server` | `RunService:IsServer()` and not edit | 1. `StudioTestService:GetTestArgs().stagehand.sessionId`  2. `plugin:GetSetting("Stagehand.Session")`  3. `null` |
| `client` | `RunService:IsClient()` and not edit | same as server |

The edit node writes `Stagehand.Session` = sessionId **before** calling `Execute*Async` and clears it on
`end_session`. A server/client node that finds no sessionId still attaches; the broker marks it `orphan`
and never dispatches steps to it.

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
  "transport": "http"
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
| `transport` | `"http" \| "remote"` | `remote` = injected client relayed through the server node |

Response:

```json
{ "nodeId": "n_7", "playerIndex": 1, "pollTimeoutMs": 25000, "eventFlushMs": 50, "brokerVersion": "0.1.0" }
```

Re-attaching with the same `{role, sessionId, userId}` (or `{role:"edit", placeId}`) replaces the old node,
keeps its `playerIndex`, and drops the old node's queued commands with `CANCELLED`.

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
```

`200`:

```json
{ "command": { "id": "c_42", "type": "run_segment", "params": { } } }
```

`204` (no body) → poll again immediately. The node handles one command at a time per type except `cancel`
and `ping`, which must be processed while a `run_segment` is in flight (the node runs segments in a
separate coroutine and keeps polling).

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
| `end_session` | server (edit fallback) | `{ "sessionId": string, "result"?: "passed" \| "failed" }` | `{ "ended": true, "via": "EndTest" \| "RunService.Stop" }` |
| `add_players` | server | `{ "count": 1..7 }` | `{ "requested": 1 }` |
| `ping` | any | `{}` | `{ "pong": true, "t": 1234.5 }` |

`launch_session` on the edit node: write the `Stagehand.Session` setting, then call (in a new thread)
`ExecuteRunModeAsync(args)` for `run`, `ExecutePlayModeAsync(args)` for `play`,
`ExecuteMultiplayerTestAsync(players, args)` for `multiplayer`, with
`args = { stagehand = { sessionId = …, port = … } }`.

### run_segment

```json
{
  "runId": "r_20261015T150102_blue-team-gun-hostile",
  "segmentId": "seg_2",
  "vars": { "spawn": [120, 5, -40] },
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
| `id` | string | stable path in the spec: `setup.N`, `steps.N`, `teardown.N`, nested `steps.4.parallel.1.0`, `steps.2.each.p2.1` |
| `verb` | `"do" \| "wait" \| "expect" \| "lua"` | `parallel`/`each` are compiled away by the daemon |
| `name` | string \| null | catalog name (`lua` for `wait: lua`/`expect: lua`); null for a `lua` verb |
| `params` | object | `$var` already substituted where known at compile time; values still in JSON form (node coerces per catalog param type) |
| `timeoutMs` | integer | wait budget / action budget |
| `withinMs` | integer \| null | `expect` only: poll until true for this long; null = instant check |
| `soft` | boolean | failure is recorded but the segment continues |
| `actor` | `{name, playerIndex}` \| null | |
| `label` | string \| null | display only |
| `save` | string \| null | store the action's / lua's return value in `vars[save]` |

Node rules: execute steps in order; vars referenced as `$name` that were left unresolved are substituted from
`params.vars` + values saved earlier in this segment; on a non-soft failure stop and mark remaining steps
`skipped` (reason `aborted`).

Result:

```json
{
  "segmentId": "seg_2",
  "status": "failed",
  "steps": [
    { "id": "steps.3", "status": "passed", "durationMs": 12 },
    { "id": "steps.5", "status": "failed", "durationMs": 2003 },
    { "id": "steps.6", "status": "skipped", "durationMs": 0 }
  ],
  "vars": { "spawn": [120, 5, -40] }
}
```

`status` ∈ `passed | failed | cancelled`; step `status` ∈ `passed | failed | skipped | cancelled`; a step with
`save` has `"value"`. `vars` is the full var map after the segment (the daemon merges it).

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
| `node.ready` | node, after attach + catalog built | `role`, `catalogHash` (sha1 hex of sorted entry names+params) |
| `session.ready` | server node, after required players joined and characters loaded (or players=0) | `sessionId`, `players: [{name, userId}]` in `Players:GetPlayers()` order |
| `segment.started` | node | `runId`, `segmentId` |
| `segment.finished` | node | `runId`, `segmentId`, `status` |
| `step.started` | node | `runId`, `segmentId`, `stepId` |
| `step.passed` | node | `…stepId`, `durationMs`, `value?` |
| `step.failed` | node | `…stepId`, `durationMs`, `reason` (string), `expected` (any), `actual` (any), `error` (ErrorObject) |
| `step.skipped` | node or daemon | `…stepId`, `reason: "if" \| "aborted"` |
| `log` | node (`LogService.MessageOut`) | `level: "info" \| "warn" \| "error"`, `message`, `node` (nodeId), `stepId \| null` |
| `run.started` / `run.finished` | daemon only (never on the wire; forwarded to MCP) | `runId`, `status?` |

`MessageOutput` → level: `MessageOutput`/`MessageInfo` → `info`, `MessageWarning` → `warn`, `MessageError` → `error`.
With `failOnError: true` the daemon fails the active step on any `log` with `level:"error"` from any node in the session.

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
| `BAD_REQUEST` | malformed body, wrong `protocolVersion` |
| `UNKNOWN_NODE` | nodeId not attached (HTTP 410) |
| `UNKNOWN_COMMAND` | command `type` not supported by this node/role |
| `UNKNOWN_ACTION` | step `name` not in the node's catalog |
| `BAD_PARAMS` | params fail the catalog schema or coercion |
| `RESOLVE_FAILED` | selector / actor did not resolve |
| `TIMEOUT` | wait or action exceeded `timeoutMs` (node) or +2 s (daemon) |
| `CANCELLED` | cancelled by `cancel` or re-attach |
| `ACTION_ERROR` | action threw |
| `ASSERTION_FAILED` | `expect` condition false |
| `LUA_ERROR` | `lua` / `eval` code threw or failed to compile |
| `SESSION_ERROR` | launch / end / add_players failed |
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
