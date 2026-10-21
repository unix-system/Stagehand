# Broker ↔ node protocol (v1)

The `stagehand-mcp` daemon runs an HTTP **broker**. Each plugin instance is a **node**, with one instance per DataModel.
Nodes attach to the broker, request commands, send results, and report events.

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

Before `Execute*Async`, the edit node stores the session ID in `Stagehand.Session` and the daemon's port in `Stagehand.SessionPort`.
It clears these settings on `end_session`.
A server or client node can attach without a session ID. The broker marks it `orphan` and sends no test steps.

## Several daemons and Studios

Each MCP client runs a separate daemon. Multiple Studio windows can connect to these daemons.

- A daemon selects the first available port in `38491`–`38500`. It reports the port in `stagehand_status` and `health`. It skips ports used by other processes.
- The edit plugin keeps one node per port in the range. Each node retries attachment with backoff. Thus, every daemon can see every open Studio instance.
- Use `--place` or `STAGEHAND_PLACE` to select a place ID or case-insensitive part of a place name. Without a selection, the daemon uses the most recently attached edit node. Status lists all edit nodes.
- The test arguments contain the launching daemon's port. Server and client nodes connect only to that port. They use `Stagehand.SessionPort` if the arguments are unavailable. Another daemon cannot see or stop these nodes. Studio rejects another launch with `SESSION_ERROR` while a test is active. The edit node first allows up to 10 seconds for a stopping test to end.
- A restarted daemon can reuse its previous port. A remaining session then reattaches as an untracked session. Before another launch, the daemon sends `end_session` to its server node. It waits up to 20 seconds for `session.ended`. The edit node's `RunService:Stop()` ends only Run mode. Play and multiplayer use separate DataModels.
- Every edit node in that Studio instance reports `session.ended`. Daemons ignore sessions that they do not own.

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

Attachment with the same `instanceId` replaces the previous node and preserves its `playerIndex`.
Without `instanceId`, matching uses `{role, sessionId, userId}` or `{role:"edit", placeId}`.
The broker cancels the old node's queued commands with `CANCELLED`.
The `instanceId` field distinguishes unpublished places, which all have `placeId` 0.

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

The optional `wait` value limits how long the broker holds a poll request open. Its unit is milliseconds.
The broker limits the value to `[0, pollTimeoutMs]`. The default is `pollTimeoutMs`.
With `wait=0`, a queued command returns `200` immediately. Otherwise, the response is `204`.

**Session nodes use short polling.** Studio limits simultaneous HttpService requests from a game server.
In testing, server and relayed client long polls delayed other requests. Commands reached clients several seconds late.
Server and client nodes therefore use `wait=0`.
They poll immediately after a command, then every 100 ms for three seconds after the last command or result.
When idle, they poll every 750 ms.
The game server also limits HttpService to 500 requests per minute. Three nodes at 10 polls per second exhausted this limit in approximately 20 seconds.
A throttled request can fail like a connection loss. Nodes preserve their IDs through poll failures.
They reattach after 30 seconds of continuous failure or an HTTP `410` response.
Reattachment fails the old node's active commands with `SESSION_ERROR`. Edit nodes continue to use long polling.

`200`:

```json
{ "command": { "id": "c_42", "type": "run_segment", "params": { } } }
```

After `204`, the node polls again. Most command types run one at a time.
The node can run `run_segment`, `cancel`, and `ping` concurrently in separate coroutines while polling continues.

The broker permits one active command per type on each node, except `run_segment`, `cancel`, and `ping`.
For example, a second `eval` remains queued until the first returns or times out.
Multiple segments can run concurrently on one node. Thus, parallel branches can send overlapping input to that node.
Each segment has its own ID, variables, and cancellation flag.
A log event uses the most recently started step that is still active on that node.

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

The `progress` command updates the **Stagehand Progress** widget. The daemon sends snapshots to the newest edit node and each client in the session.
It sends a snapshot when the session becomes ready, when steps change, and when the run ends.
Step changes are combined into at most one update per 150 ms. Failed deliveries do not stop the run.
The edit widget serves the main window in Run mode and multiplayer. In Play, the main window uses the client DataModel.
Each client has its own widget. The snapshot has this format:

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

Run `status` values are `running`, `passed`, `failed`, `cancelled`, and `error`.
Step values are `pending`, `running`, `passed`, `failed`, `skipped`, and `cancelled`.
The `target` is `server`, `client#N`, `edit`, or `daemon`.
The widget groups client results by target. A client marks its own steps and groups consecutive steps on other targets.
The `elapsedMs` field gives elapsed time at the snapshot. The widget continues timing locally, without clock synchronization.
The `timeoutMs` field gives the time limit. The `durationMs` field gives the final duration.
Older fields retain their meanings. Plugins ignore unknown fields.

For `launch_session`, the edit node stores `Stagehand.Session` and `Stagehand.SessionPort`.
It starts the selected method in a new thread: `ExecuteRunModeAsync(args)`, `ExecutePlayModeAsync(args)`, or `ExecuteMultiplayerTestAsync(players, args)`.
The arguments contain `stagehand = { sessionId, port, mode, players }`.
The server reads the expected player count from `GetTestArgs().stagehand` before it reports `session.ready`.
Run mode expects no players. Without test arguments, the server reports readiness after 1.5 seconds without new players.
Run mode uses the edit DataModel, so its plugin also hosts the server node.
When `Execute*Async` returns, the edit node clears its settings unless a newer launch owns them.
It then reports `session.ended`.

An accepted launch has two time limits. The server node must attach within 30 seconds. The `session.ready` event must arrive within 60 seconds.
Multiplayer limits are 1.5 times longer. Studio normally starts a test in 3–6 seconds.
Background pauses, dialogs, or an unfinished previous session can delay launch.
Either timeout causes `SESSION_ERROR`. The daemon sends `end_session` to the server, or to the edit node with `abandon: true`.

The server reports `session.ready` after the expected players join and their characters load.
It also permits a grace period when characters are unavailable.
The period is eight seconds if a character exists but is still loading.
It is 2.5 seconds if no player has a character, for example when a menu controls character creation.

The protocol has no `clear_logs` command. Each node keeps logs by `runId` for node-level `log.*` conditions and `eval`.
The log period starts with the first segment of a new run. A `respawn` or `hook` reset does not clear it.
The daemon's combined log collection for `scope: all` also applies to one run.

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
| `timeoutMs` | integer | time limit for a wait or action |
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

The daemon evaluates some steps without sending them to a node. It reports the same `step.*` events to MCP:

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

Both the command result and `step.failed` event contain failure details.
The result is the ordered response to the command. Events use a separate channel and can arrive later.
Client nodes send events through the server.
The daemon records the first response and fills missing fields from the second.
The result's `vars` contains the complete variable map after the segment. The daemon merges these values.

### Cancel

On `cancel`, the node sets the segment's cancellation flag. The active step stops at its next yield.
The node reports `step.failed` with `error.code: "CANCELLED"`. Its result status and remaining step statuses are `cancelled`.
If the daemon requested cancellation, it records the step as `cancelled`.
This includes run cancellation, another parallel branch's failure, and run timeout.
A step already marked as failed keeps its failure. An unrequested `CANCELLED`, such as a reattachment cancellation, counts as a failure.

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

Every event includes `seq`, `type`, and `t`. Sequence numbers increase per node and start at 1 after attachment.
The time `t` is `os.clock()*1000` on the node, in milliseconds.
The response acknowledges the sequence number, for example `{ "ack": 103 }`. The node can remove acknowledged events.

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

The `catalogHash` is a lowercase SHA-1 hexadecimal value for the node's catalog entries, including live game hooks.
Entries are sorted by name. Each line contains `name .. compactJson(params)`, and lines are joined with `"\n"`.
The daemon stores this value per node and compares hashes only for equality.
After `node.ready`, it always requests the full catalog.

If `session.ended` identifies the current session, the daemon marks that session `ended`, unless it is already ending.
It clears the current session and removes its server and client nodes.
Removal rejects their active commands. An active `run_segment` fails its step with `SESSION_ERROR`.
The next run starts a new session.

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
