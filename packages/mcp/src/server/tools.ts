// MCP tools (docs/architecture.md "MCP surface").
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import YAML from "yaml";
import { z } from "zod";
import type { NodeInfo } from "../broker/nodes.js";
import { StagehandError } from "../broker/protocol.js";
import type { Daemon } from "../daemon.js";
import { normalizeSession } from "../engine/compile.js";
import { describePlan } from "../engine/plan.js";
import { renderMarkdown } from "../engine/reporter.js";
import type { Run } from "../engine/run.js";
import type { RunResult } from "../engine/types.js";
import { validateInput } from "../engine/validate.js";
import { parseDuration } from "../spec/values.js";
import { entryLine, fail, json, SPEC_CHEATSHEET, text } from "./format.js";
import { ProgressSink, type ToolExtra } from "./progress.js";

const specInput = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe("Playtest as YAML/JSON text or as an object");
const duration = z.union([z.string(), z.number()]).describe('Duration: "250ms", "10s", "1.5m" or seconds');
const sessionSchema = z
  .object({
    mode: z.enum(["edit", "run", "play", "multiplayer"]).optional(),
    players: z.number().int().min(0).max(8).optional(),
    reuse: z.boolean().optional(),
    reset: z.enum(["respawn", "hook", "none"]).optional(),
  })
  .describe("Session: mode edit|run (0 players) | play (1) | multiplayer (2..8); omitted mode is inferred from players");

function extraOf(e: unknown): ToolExtra {
  return e as ToolExtra;
}

function runToolResult(result: RunResult): CallToolResult {
  const md = renderMarkdown(result);
  return {
    isError: result.status === "error",
    content: [{ type: "text", text: `${md}\nrunId: ${result.runId}\nreport: ${result.dir}` }],
  };
}

async function awaitRun(run: Run, sink: ProgressSink, extra: ToolExtra): Promise<RunResult> {
  const stop = sink.follow(run);
  const onAbort = () => run.cancel();
  extra.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await run.done;
  } finally {
    stop();
    extra.signal.removeEventListener("abort", onAbort);
  }
}

function nodeHint(d: Daemon): string | undefined {
  if (d.brokerError) return d.brokerError;
  if (!d.registry.findEdit()) return "No Roblox Studio edit node is attached. Open the place in Studio with the Stagehand plugin installed and enabled (plugin port must match the daemon port).";
  return undefined;
}

export function registerTools(server: McpServer, d: Daemon): void {
  // ---- status / discovery -------------------------------------------------
  server.registerTool(
    "stagehand_status",
    {
      title: "Stagehand status",
      description:
        "Show daemon health: broker port, attached Studio nodes (edit/server/client with sessionId and playerIndex), the current test session, the active run and catalog state. Call this first to check that Roblox Studio with the Stagehand plugin is connected.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const cur = d.sessions.current();
      const live = d.catalog.entries().filter((e) => e.name.startsWith("game.")).map((e) => e.name);
      return json({
        broker: { port: d.broker.port, listening: !d.brokerError, error: d.brokerError },
        root: d.root,
        allowEval: d.allowEval,
        nodes: d.broker.health().nodes,
        session: cur
          ? { sessionId: cur.sessionId, mode: cur.mode, players: cur.players, state: cur.state, sessionPlayers: cur.sessionPlayers }
          : null,
        activeRun: d.runs.active()?.summary() ?? null,
        catalog: { entries: d.catalog.entries().length, liveNodes: d.catalog.liveNodeCount, gameHooks: live, gameHooksVerified: d.catalog.gameVerified },
        hint: nodeHint(d) ?? null,
      });
    },
  );

  server.registerTool(
    "list_actions",
    {
      title: "List actions and conditions",
      description:
        "List the catalog of playtest actions (use with do:) and conditions (use with wait:/expect:), including live game.* hooks from the running game. Each line: name [kind] (contexts, * = default) needs-as? {params; ? = optional}: summary. Pass `name` for one entry's full JSON schema. Includes a step-syntax cheat sheet.",
      inputSchema: {
        kind: z.enum(["action", "condition"]).optional().describe("Filter by kind"),
        namespace: z.string().optional().describe('Filter by namespace prefix, e.g. "character" or "game"'),
        context: z.enum(["edit", "server", "client"]).optional().describe("Only entries runnable in this context"),
        name: z.string().optional().describe("Return the full JSON entry for this exact name"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      if (a.name) {
        const e = d.catalog.get(a.name);
        return e ? json(e) : fail(new StagehandError("UNKNOWN_ACTION", `no catalog entry "${a.name}"`));
      }
      const entries = d.catalog
        .entries()
        .filter((e) => !a.kind || e.kind === a.kind)
        .filter((e) => !a.namespace || e.name.startsWith(`${a.namespace.replace(/\.$/, "")}.`))
        .filter((e) => !a.context || e.contexts.includes(a.context));
      const lines = entries.map(entryLine);
      const lua = 'lua [action|condition] (edit|server*|client) as? {code: string}: `lua: "<code>"` action (save-able return) or `wait: lua` / `expect: lua` with code: (truthy = true). Defaults to server (edit in edit mode).';
      if (!a.kind && !a.namespace) lines.push(lua);
      return text(`${SPEC_CHEATSHEET}\n\n${lines.join("\n")}${d.catalog.gameVerified ? "" : "\n\n(game.* hooks unknown until a session is running)"}`);
    },
  );

  server.registerTool(
    "inspect",
    {
      title: "Inspect the game tree",
      description:
        "Inspect instances in the live DataModel to discover paths for selectors: remotes, teams, tools, GUI elements, tagged parts, attributes. Give exactly one of path (e.g. \"ReplicatedStorage.Remotes\", \"@p1.gui\"), tag, or className. Runs on the server of the current session if one is running, else on the edit DataModel; use on: client with as: p1 to see a player's GUI.",
      inputSchema: {
        path: z.string().optional().describe("Instance path or selector to start from (default: game)"),
        tag: z.string().optional().describe("CollectionService tag to list"),
        className: z.string().optional().describe("List instances of this class (IsA)"),
        depth: z.number().int().min(0).max(10).optional().describe("Child depth to include (default 1)"),
        limit: z.number().int().min(1).max(2000).optional().describe("Max nodes (default 200)"),
        on: z.enum(["edit", "server", "client"]).optional().describe("Which DataModel to inspect"),
        as: z.string().optional().describe("Client to use with on: client (p1..p8; default p1)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const given = [a.path, a.tag, a.className].filter((x) => x !== undefined).length;
      if (given > 1) return fail(new StagehandError("BAD_PARAMS", "give exactly one of path, tag, className"));
      try {
        const node = pickNode(d, a.on, a.as);
        const params: Record<string, unknown> = { depth: a.depth ?? 1, limit: a.limit ?? 200 };
        if (a.tag !== undefined) params.tag = a.tag;
        else if (a.className !== undefined) params.className = a.className;
        else params.path = a.path ?? "game";
        const r = await d.registry.send(node.nodeId, "inspect", params, { timeoutMs: 15_000 });
        return json({ node: { nodeId: node.nodeId, role: node.role }, ...(r as object) });
      } catch (e) {
        return fail(e, nodeHint(d));
      }
    },
  );

  // ---- validation / running -----------------------------------------------
  server.registerTool(
    "validate_test",
    {
      title: "Validate a playtest",
      description:
        "Validate a playtest (YAML/JSON text, object, or a saved test by name) against the schema and the action catalog without running it. Returns errors with paths and line numbers, warnings, and the compiled plan (which node each step runs on, merged segments). Use before run_steps/save_test.",
      inputSchema: {
        spec: specInput.optional(),
        name: z.string().optional().describe("Name of a saved test in playtests/ (instead of spec)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        let input: unknown = a.spec;
        if (input === undefined) {
          if (!a.name) return fail(new StagehandError("BAD_PARAMS", "give spec or name"));
          const t = await d.tests.get(a.name);
          if (!t) return fail(new StagehandError("BAD_PARAMS", `no saved test "${a.name}"`));
          input = t.text;
        }
        const v = validateInput(input, d.catalog, { expectName: a.name });
        return json({
          valid: v.ok,
          errors: v.errors,
          warnings: v.warnings,
          session: v.plan?.session ?? null,
          plan: v.plan ? describePlan(v.plan) : null,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "run_steps",
    {
      title: "Run ad-hoc steps",
      description:
        'Run unsaved steps in Studio right away (launches or reuses a test session) and return a pass/fail report with expected/actual for failures. steps is a YAML/JSON list of steps (or a whole playtest document), e.g. "- { do: player.setTeam, as: p1, team: Blue }\\n- { expect: player.onTeam, as: p1, team: Blue }". Set session.players (0 = Run mode, 1 = Play, 2-8 = multiplayer). Streams step progress when the client sends a progressToken.',
      inputSchema: {
        steps: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).describe("Steps as YAML/JSON text or array"),
        session: sessionSchema.optional(),
        vars: z.record(z.string(), z.unknown()).optional().describe("Vars referenced as $name"),
        actors: z.record(z.string(), z.object({ player: z.number().int().min(1).max(8) })).optional().describe("Actor aliases, e.g. {blue: {player: 1}}"),
        setup: z.array(z.record(z.string(), z.unknown())).optional(),
        teardown: z.array(z.record(z.string(), z.unknown())).optional(),
        timeout: duration.optional().describe("Whole-run budget (default 60s)"),
        failOnError: z.boolean().optional().describe("Fail the active step on any error-level Output (default true)"),
        name: z.string().optional().describe("Run name for the report (default adhoc)"),
        wait: z.boolean().optional().describe("Wait for completion (default true); false returns the runId immediately"),
      },
    },
    async (a, extraRaw) => {
      const extra = extraOf(extraRaw);
      try {
        let steps: unknown = a.steps;
        let doc: Record<string, unknown> | null = null;
        if (typeof steps === "string") {
          const parsed = YAML.parse(steps) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "steps" in parsed) doc = parsed as Record<string, unknown>;
          else steps = Array.isArray(parsed) ? parsed : [parsed];
        }
        const spec: Record<string, unknown> = doc ?? { name: a.name ?? "adhoc", steps };
        if (!doc) {
          if (a.session) spec.session = a.session;
          if (a.vars) spec.vars = a.vars;
          if (a.actors) spec.actors = a.actors;
          if (a.setup) spec.setup = a.setup;
          if (a.teardown) spec.teardown = a.teardown;
          if (a.timeout !== undefined) spec.timeout = a.timeout;
          if (a.failOnError !== undefined) spec.failOnError = a.failOnError;
        }
        const run = d.runs.start({ input: spec, fallbackName: a.name ?? "adhoc" });
        if (a.wait === false) return json({ ...run.summary(), hint: "poll with tail_run / get_run" });
        return runToolResult(await awaitRun(run, new ProgressSink(server, extra), extra));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "run_test",
    {
      title: "Run a saved playtest",
      description:
        "Run a saved playtest from playtests/<name>.playtest.yaml in Studio and return the report (status, failing step with reason/expected/actual, logs around the failure, per-step table). Reports are stored under .stagehand/runs/. With wait: false returns a runId to follow with tail_run/get_run.",
      inputSchema: {
        name: z.string().describe("Saved test name"),
        wait: z.boolean().optional().describe("Wait for completion (default true)"),
        timeout: duration.optional().describe("Override the test's whole-run timeout"),
        vars: z.record(z.string(), z.unknown()).optional().describe("Override/add vars"),
      },
    },
    async (a, extraRaw) => {
      const extra = extraOf(extraRaw);
      try {
        const t = await d.tests.get(a.name);
        if (!t) return fail(new StagehandError("BAD_PARAMS", `no saved test "${a.name}" (see list_tests)`));
        const run = d.runs.start({
          input: t.text,
          fallbackName: a.name,
          expectName: a.name,
          extraVars: a.vars,
          timeoutMs: a.timeout !== undefined ? parseDuration(a.timeout) : undefined,
        });
        if (a.wait === false) return json({ ...run.summary(), hint: "poll with tail_run / get_run" });
        return runToolResult(await awaitRun(run, new ProgressSink(server, extra), extra));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "run_suite",
    {
      title: "Run a suite of playtests",
      description:
        "Run several saved playtests sequentially, selected by tag and/or names (no selector = all tests). Returns a pass/fail table with each runId and the first failure reason; use get_run for details.",
      inputSchema: {
        tag: z.string().optional().describe("Run tests having this tag"),
        names: z.array(z.string()).optional().describe("Run these tests (in order)"),
        stopOnFailure: z.boolean().optional().describe("Stop after the first failing test (default false)"),
      },
    },
    async (a, extraRaw) => {
      const extra = extraOf(extraRaw);
      try {
        const all = await d.tests.list();
        let selected = all;
        if (a.names?.length) selected = a.names.map((n) => all.find((t) => t.name === n) ?? { name: n, file: "", description: null, tags: [], parseError: "not found" });
        if (a.tag) selected = selected.filter((t) => t.tags.includes(a.tag!));
        if (!selected.length) return fail(new StagehandError("BAD_PARAMS", "no tests matched"));
        const sink = new ProgressSink(server, extra);
        const rows: Array<Record<string, unknown>> = [];
        let cancelled = false;
        const onAbort = () => (cancelled = true);
        extra.signal.addEventListener("abort", onAbort, { once: true });
        for (let i = 0; i < selected.length; i++) {
          const t = selected[i]!;
          if (cancelled) break;
          const st = await d.tests.get(t.name).catch(() => null);
          if (!st) {
            rows.push({ name: t.name, status: "error", reason: "test not found" });
            continue;
          }
          const run = d.runs.start({ input: st.text, fallbackName: t.name, expectName: t.name });
          const stop = sink.follow(run, { base: i, total: selected.length, prefix: `[${t.name}]` });
          const abort = () => run.cancel();
          extra.signal.addEventListener("abort", abort, { once: true });
          const r = await run.done;
          extra.signal.removeEventListener("abort", abort);
          stop();
          rows.push({ name: t.name, status: r.status, runId: r.runId, durationMs: r.durationMs, failure: r.failure ? `${r.failure.step ?? ""} ${r.failure.reason}`.trim() : null });
          if (a.stopOnFailure && r.status !== "passed") break;
        }
        extra.signal.removeEventListener("abort", onAbort);
        const passed = rows.filter((r) => r.status === "passed").length;
        const lines = [`Suite: ${passed}/${rows.length} passed${rows.length < selected.length ? ` (${selected.length - rows.length} not run)` : ""}`, "", "| Test | Status | Run | Failure |", "|---|---|---|---|"];
        for (const r of rows) lines.push(`| ${String(r.name)} | ${String(r.status).toUpperCase()} | ${String(r.runId ?? "")} | ${String(r.failure ?? r.reason ?? "")} |`);
        return { isError: false, content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Get a run report",
      description:
        'Get the result of a run by runId (or "latest"): status, failure (step, reason, expected, actual, node, logs around), per-step statuses and final vars. Works for in-progress runs (partial) and past runs stored in .stagehand/runs/.',
      inputSchema: {
        runId: z.string().describe('Run id from run_* tools, or "latest"'),
        format: z.enum(["markdown", "json"]).optional().describe("markdown (default) or full json"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const live = d.runs.get(a.runId);
      if (live && !live.result) {
        return json({ ...live.summary(), steps: live.stepRecords().map((s) => ({ id: s.id, status: s.status, display: s.display })) });
      }
      const r = (live?.result ?? (await d.runsStore.get(a.runId))) as RunResult | null;
      if (!r) return fail(new StagehandError("BAD_PARAMS", `no run "${a.runId}"`));
      return a.format === "json" ? json(r) : text(`${renderMarkdown(r)}\nrunId: ${r.runId}\nreport: ${r.dir}`);
    },
  );

  server.registerTool(
    "tail_run",
    {
      title: "Tail run events",
      description:
        "Return a run's events after a sequence number (step.started/passed/failed/skipped, log, session, run.finished). Poll with afterSeq = the returned lastSeq to follow a run started with wait: false.",
      inputSchema: {
        runId: z.string().describe('Run id or "latest"'),
        afterSeq: z.number().int().min(0).optional().describe("Only events with seq > afterSeq (default 0)"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max events (default 200)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const after = a.afterSeq ?? 0;
      const limit = a.limit ?? 200;
      const live = d.runs.get(a.runId);
      let events: Array<Record<string, unknown>>;
      let status: string;
      let runId = a.runId;
      if (live) {
        events = live.events as Array<Record<string, unknown>>;
        status = live.status;
        runId = live.id;
      } else {
        const r = await d.runsStore.get(a.runId);
        if (!r) return fail(new StagehandError("BAD_PARAMS", `no run "${a.runId}"`));
        runId = String(r.runId);
        events = (await d.runsStore.events(runId)) ?? [];
        status = String(r.status);
      }
      const page = events.filter((e) => Number(e.seq) > after).slice(0, limit);
      const lastSeq = page.length ? Number(page[page.length - 1]!.seq) : after;
      const done = !["queued", "running"].includes(status);
      return json({ runId, status, done, lastSeq, more: events.some((e) => Number(e.seq) > lastSeq), events: page });
    },
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel a run",
      description: "Cancel a queued or running run (default: the active run). In-flight steps are cancelled on the nodes, then teardown runs.",
      inputSchema: { runId: z.string().optional().describe("Run id (default: active run)") },
    },
    async (a) => {
      const run = a.runId ? d.runs.get(a.runId) : d.runs.active();
      if (!run) return fail(new StagehandError("BAD_PARAMS", a.runId ? `no live run "${a.runId}"` : "no active run"));
      const ok = run.cancel();
      return json({ runId: run.id, cancelled: ok, status: run.status });
    },
  );

  // ---- tests store ----------------------------------------------------------
  server.registerTool(
    "list_tests",
    {
      title: "List saved playtests",
      description: "List saved playtests in playtests/ with description and tags.",
      inputSchema: { tag: z.string().optional().describe("Only tests with this tag") },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const list = (await d.tests.list()).filter((t) => !a.tag || t.tags.includes(a.tag));
      return json({ dir: d.tests.dir, tests: list.map((t) => ({ name: t.name, description: t.description, tags: t.tags, ...(t.parseError ? { parseError: t.parseError } : {}) })) });
    },
  );

  server.registerTool(
    "get_test",
    {
      title: "Get a saved playtest",
      description: "Return the YAML source of a saved playtest.",
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        const t = await d.tests.get(a.name);
        return t ? text(`# ${t.file}\n${t.text}`) : fail(new StagehandError("BAD_PARAMS", `no saved test "${a.name}"`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "save_test",
    {
      title: "Save a playtest",
      description:
        "Validate and save a playtest to playtests/<name>.playtest.yaml (YAML text is saved verbatim, keeping comments; objects are serialized). The spec's name must equal `name`. Refuses invalid specs unless force: true. Overwrites an existing test.",
      inputSchema: {
        name: z.string().describe("Test name (lowercase kebab-case)"),
        spec: specInput,
        force: z.boolean().optional().describe("Save even if validation fails"),
      },
    },
    async (a) => {
      try {
        const v = validateInput(a.spec, d.catalog, { expectName: a.name });
        if (!v.ok && !a.force) return { isError: true, content: [{ type: "text", text: JSON.stringify({ saved: false, errors: v.errors, warnings: v.warnings }, null, 2) }] };
        const file = await d.tests.save(a.name, a.spec as string | object);
        return json({ saved: true, file, valid: v.ok, errors: v.errors, warnings: v.warnings });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_test",
    {
      title: "Delete a playtest",
      description: "Delete a saved playtest (playtests/<name>.playtest.yaml). Past run reports are kept.",
      inputSchema: { name: z.string() },
      annotations: { destructiveHint: true },
    },
    async (a) => {
      try {
        return json({ deleted: await d.tests.delete(a.name), name: a.name });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- sessions ---------------------------------------------------------------
  server.registerTool(
    "start_session",
    {
      title: "Start a Studio test session",
      description:
        "Start (or reuse) a Studio test session so later runs and inspect calls are fast: players 0 = Run mode, 1 = Play, 2-8 = multiplayer (Studio simulated players). Waits until the server and all clients are attached and characters are loaded (or 8s after the players joined, for games that spawn characters from a menu; use wait: character.loaded in tests then).",
      inputSchema: {
        mode: z.enum(["run", "play", "multiplayer"]).optional(),
        players: z.number().int().min(0).max(8).optional(),
        reset: z.enum(["respawn", "hook", "none"]).optional().describe("Reset applied if an existing session is reused (default none)"),
      },
    },
    async (a, extraRaw) => {
      const extra = extraOf(extraRaw);
      const errors: never[] = [];
      const cfg = normalizeSession({ mode: a.mode, players: a.players, reuse: true, reset: a.reset ?? "none" }, errors as never);
      if (errors.length) return fail(new StagehandError("BAD_PARAMS", JSON.stringify(errors)));
      const sink = new ProgressSink(server, extra);
      try {
        const h = await d.runs.exclusive(() =>
          d.sessions.ensure(cfg, { signal: extra.signal, onProgress: (m) => sink.report(0, undefined, m) }),
        );
        await d.sessions.release(h, true);
        return json({ sessionId: h.sessionId, mode: h.mode, players: h.players, reused: h.reused, sessionPlayers: h.record?.sessionPlayers ?? [] });
      } catch (e) {
        return fail(e, nodeHint(d));
      }
    },
  );

  server.registerTool(
    "stop_session",
    {
      title: "Stop the Studio test session",
      description: "End the current Studio test session (EndTest on the server, RunService:Stop via the edit node as fallback). Refused while a run is active; cancel_run first.",
      inputSchema: {},
    },
    async () => {
      if (d.runs.active()) return fail(new StagehandError("SESSION_ERROR", "a run is active; cancel_run first"));
      try {
        return json(await d.sessions.end("stop_session"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "eval_lua",
    {
      title: "Evaluate Luau in Studio",
      description:
        "Run arbitrary Luau on a node and return its value and captured logs. `actor`, `player`, `character` and `vars` are in scope. Disabled unless the daemon was started with --allow-eval (returns EVAL_DISABLED). Defaults to the session's server, else the edit DataModel.",
      inputSchema: {
        code: z.string().describe('Luau chunk, e.g. "return #game.Players:GetPlayers()"'),
        on: z.enum(["edit", "server", "client"]).optional(),
        as: z.string().optional().describe("Actor p1..p8 (client to run on, or the player bound on the server)"),
        vars: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (a) => {
      if (!d.allowEval) return fail(new StagehandError("EVAL_DISABLED", "eval_lua is disabled; restart stagehand-mcp with --allow-eval"));
      try {
        const node = pickNode(d, a.on, a.as);
        const idx = a.as ? actorIndex(a.as) : null;
        const env: Record<string, unknown> = {};
        if (idx) env.actor = { name: a.as, playerIndex: idx };
        if (a.vars) env.vars = a.vars;
        const r = await d.registry.send(node.nodeId, "eval", { code: a.code, env }, { timeoutMs: 30_000 });
        return json({ node: { nodeId: node.nodeId, role: node.role }, ...(r as object) });
      } catch (e) {
        return fail(e, nodeHint(d));
      }
    },
  );
}

function actorIndex(as: string): number {
  const m = /^p([1-8])$/.exec(as);
  if (!m) throw new StagehandError("BAD_PARAMS", `as must be p1..p8 here (got "${as}")`);
  return Number(m[1]);
}

/** Pick a node for inspect/eval: explicit context, else session server, else edit. */
function pickNode(d: Daemon, on: "edit" | "server" | "client" | undefined, as: string | undefined): NodeInfo {
  const s = d.sessions.current();
  const live = s && s.state !== "ended" && s.state !== "launching" ? s : null;
  const ctx = on ?? (as && live ? "client" : live ? "server" : "edit");
  let n: NodeInfo | undefined;
  if (ctx === "edit") n = d.registry.findEdit(live?.placeId ?? null);
  else if (!live) throw new StagehandError("SESSION_ERROR", `no running test session for on: ${ctx}; call start_session first`);
  else if (ctx === "server") n = d.registry.findServer(live.sessionId);
  else n = d.registry.findClient(live.sessionId, as ? actorIndex(as) : 1);
  if (!n) throw new StagehandError("RESOLVE_FAILED", `no ${ctx} node attached`);
  return n;
}
