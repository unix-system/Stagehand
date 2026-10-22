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

/** Default cap on how long run_* tools block; MCP clients tend to background calls past ~2 minutes. */
export const DEFAULT_WAIT_MS = 90_000;
/** Cap on tail_run's long-poll. */
export const MAX_TAIL_WAIT_MS = 60_000;

const waitArg = z
  .union([z.boolean(), duration])
  .describe('How long to wait for the run: true/omitted = 90s, false = return the runId at once, or a duration ("3m"). Past the cap the partial report is returned and the run keeps going (follow it with tail_run / get_run).');

function waitCapMs(wait: boolean | string | number | undefined): number {
  if (wait === false) return 0;
  if (wait === true || wait === undefined) return DEFAULT_WAIT_MS;
  return Math.max(0, parseDuration(wait));
}

function runToolResult(result: RunResult, note?: string): CallToolResult {
  const md = renderMarkdown(result);
  return {
    isError: result.status === "error",
    content: [{ type: "text", text: `${md}${note ? `\n${note}` : ""}\nrunId: ${result.runId}\nreport: ${result.dir}` }],
  };
}

/** The report so far for a run that is still going, plus how to keep following it. */
function partialToolResult(run: Run, note?: string): CallToolResult {
  const p = run.partialResult();
  const md = renderMarkdown(p, { partial: true });
  const hint = `still running after the wait cap: follow it with tail_run (afterSeq ${run.summary().lastSeq}, waitMs "60s" long-polls until the next event) or get_run on the runId below; cancel_run stops it.`;
  return { isError: false, content: [{ type: "text", text: `${md}${note ? `\n${note}` : ""}\n${hint}\nrunId: ${run.id}\nreport: ${run.dir}` }] };
}

/**
 * Wait for a run up to `capMs`, streaming progress. Resolves with the final result, or null when the cap
 * passed first (the run keeps going; the client's abort still cancels it while we were waiting).
 */
async function awaitRun(run: Run, sink: ProgressSink, extra: ToolExtra, capMs: number): Promise<RunResult | null> {
  const stop = sink.follow(run);
  const onAbort = () => run.cancel();
  extra.signal.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | null = null;
  try {
    const capped = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), capMs);
    });
    return await Promise.race([run.done, capped]);
  } finally {
    if (timer) clearTimeout(timer);
    stop();
    extra.signal.removeEventListener("abort", onAbort);
  }
}

async function runOrPartial(run: Run, sink: ProgressSink, extra: ToolExtra, wait: boolean | string | number | undefined, note?: string): Promise<CallToolResult> {
  const cap = waitCapMs(wait);
  if (cap === 0) return json({ ...run.summary(), hint: "poll with tail_run (waitMs long-polls) / get_run" });
  const result = await awaitRun(run, sink, extra, cap);
  return result ? runToolResult(result, note) : partialToolResult(run, note);
}

/** Resolve when the live run emits any event, finishes, or `ms` pass. */
function waitForRunEvent(run: Run, ms: number): Promise<void> {
  if (run.result || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => done(), ms);
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    off = run.on(() => done());
    void run.done.then(() => done());
  });
}

function nodeHint(d: Daemon): string | undefined {
  if (d.brokerError) return d.brokerError;
  const edits = d.registry.edits();
  if (edits.length === 0) return "No Roblox Studio edit node is attached. Open the place in Studio with the Stagehand plugin installed and enabled (the plugin scans ports 45491-45500; set Stagehand.Port if the daemon runs elsewhere).";
  if (edits.length > 1) {
    const chosen = edits.find((e) => e.selected);
    return `${edits.length} Studios are attached; driving "${chosen?.placeName ?? "?"}" (${chosen?.placeId ?? "?"})${d.place ? ` as selected by --place ${d.place}` : " (most recent; start the daemon with --place <id|name> to pin one)"}.`;
  }
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
      const launcher = await d.sessions.launcherStatus();
      const studioTest = launcher?.current ?? null;
      const ours = studioTest ? studioTest.port === d.sessions.port || d.sessions.endedIds().has(studioTest.sessionId) : false;
      const tracked = !!(studioTest && cur && cur.sessionId === studioTest.sessionId && cur.state !== "ended");
      let hint = nodeHint(d) ?? null;
      if (studioTest && ours && !tracked) hint ??= `Studio is still running our ${studioTest.mode} session ${studioTest.sessionId} that this daemon lost track of; stop_session ends it (or Stop in Studio).`;
      else if (studioTest && !ours) hint ??= `Studio is running test session ${studioTest.sessionId} for the daemon on port ${studioTest.port}; this daemon cannot launch until it ends.`;
      return json({
        broker: { port: d.broker.port, listening: !d.brokerError, error: d.brokerError },
        root: d.root,
        allowEval: d.allowEval,
        place: d.place,
        studios: d.registry.edits().map((e) => ({ nodeId: e.nodeId, placeId: e.placeId, placeName: e.placeName, selected: e.selected })),
        nodes: d.broker.health().nodes,
        session: cur
          ? { sessionId: cur.sessionId, mode: cur.mode, players: cur.players, state: cur.state, sessionPlayers: cur.sessionPlayers }
          : null,
        /** What Studio's Launcher is running right now (any daemon), and whether it is ours / tracked. */
        studioTest: studioTest ? { ...studioTest, ours, tracked } : null,
        activeRun: d.runs.active()?.summary() ?? null,
        catalog: { entries: d.catalog.entries().length, liveNodes: d.catalog.liveNodeCount, gameHooks: live, gameHooksVerified: d.catalog.gameVerified },
        hint,
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
      const lines = entries.map((e) => entryLine(e) + (e.name.startsWith("game.") && !d.catalog.isLive(e.name) ? " (cached from a previous session; not verified against the running game)" : ""));
      const lua = 'lua [action|condition] (edit|server*|client) as? {code: string}: `lua: "<code>"` action (save-able return) or `wait: lua` / `expect: lua` with code: (truthy = true). Defaults to server (edit in edit mode).';
      if (!a.kind && !a.namespace) lines.push(lua);
      const footer = d.catalog.gameVerified
        ? ""
        : d.catalog.gameEverReported
          ? "\n\n(no game is running: game.* entries above are cached from the last session and are re-checked when a session starts)"
          : "\n\n(game.* hooks unknown until a session is running)";
      return text(`${SPEC_CHEATSHEET}\n\n${lines.join("\n")}${footer}`);
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
        const v = validateInput(input, d.catalog, { expectName: a.name, sharedFragments: await d.tests.fragmentMap() });
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
        'Run unsaved steps in Studio right away (launches or reuses a test session) and return a pass/fail report with expected/actual for failures. steps is a YAML/JSON list of steps (or a whole playtest document; the other arguments are merged over it), e.g. "- { do: player.setTeam, as: p1, team: Blue }\\n- { expect: player.onTeam, as: p1, team: Blue }". Set session.players (0 = Run mode, 1 = Play, 2-8 = multiplayer); with no mode/players the live session is reused as it is. Streams step progress when the client sends a progressToken; waits up to 90s by default, then returns the partial report.',
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
        wait: waitArg.optional(),
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
        // A whole document is the base; explicit arguments are merged over it (session keys individually).
        const spec: Record<string, unknown> = doc ?? { name: a.name ?? "adhoc", steps };
        if (a.session) spec.session = { ...((doc?.session as Record<string, unknown> | undefined) ?? {}), ...a.session };
        if (a.vars) spec.vars = { ...((doc?.vars as Record<string, unknown> | undefined) ?? {}), ...a.vars };
        if (a.actors) spec.actors = { ...((doc?.actors as Record<string, unknown> | undefined) ?? {}), ...a.actors };
        if (a.setup) spec.setup = a.setup;
        if (a.teardown) spec.teardown = a.teardown;
        if (a.timeout !== undefined) spec.timeout = a.timeout;
        if (a.failOnError !== undefined) spec.failOnError = a.failOnError;
        // No mode/players given: run on the session that is live instead of defaulting to Run mode (which
        // would both reject `as: p1` and replace the live Play session).
        let note: string | undefined;
        const sess = spec.session as Record<string, unknown> | undefined;
        const live = d.sessions.current();
        if (sess?.mode === undefined && sess?.players === undefined && live?.state === "ready") {
          spec.session = { ...(sess ?? {}), mode: live.mode, players: live.players, reuse: true, reset: sess?.reset ?? "none" };
          note = `session: inherited from the live ${live.mode} session (${live.players} player(s), reset: ${String(sess?.reset ?? "none")}); pass session.players to choose another`;
        }
        const run = d.runs.start({ input: spec, fallbackName: a.name ?? "adhoc", sharedFragments: await d.tests.fragmentMap() });
        return await runOrPartial(run, new ProgressSink(server, extra), extra, a.wait, note);
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
        "Run a saved playtest from playtests/<name>.playtest.yaml in Studio and return the report (status, failing step with reason/expected/actual, logs around the failure, per-step table). Reports are stored under .stagehand/runs/. Waits up to 90s by default (wait: a duration to change that), then returns the partial report with the runId to follow via tail_run/get_run; wait: false returns the runId at once.",
      inputSchema: {
        name: z.string().describe("Saved test name"),
        wait: waitArg.optional(),
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
          sharedFragments: await d.tests.fragmentMap(),
        });
        return await runOrPartial(run, new ProgressSink(server, extra), extra, a.wait);
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
        "Run several saved playtests sequentially, selected by tag and/or names (no selector = all tests). Returns a pass/fail table with each runId and the first failure reason; use get_run for details. Blocks up to `timeout` (default 90s): past it the table so far is returned, the in-flight test keeps running (follow its runId with tail_run) and the remaining tests are not started.",
      inputSchema: {
        tag: z.string().optional().describe("Run tests having this tag"),
        names: z.array(z.string()).optional().describe("Run these tests (in order)"),
        stopOnFailure: z.boolean().optional().describe("Stop after the first failing test (default false)"),
        timeout: duration.optional().describe("How long this call may block (default 90s)"),
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
        const deadline = Date.now() + (a.timeout !== undefined ? parseDuration(a.timeout) : DEFAULT_WAIT_MS);
        const sharedFragments = await d.tests.fragmentMap();
        const sink = new ProgressSink(server, extra);
        const rows: Array<Record<string, unknown>> = [];
        let cancelled = false;
        let inFlight: Run | null = null;
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
          const run = d.runs.start({ input: st.text, fallbackName: t.name, expectName: t.name, sharedFragments });
          const stop = sink.follow(run, { base: i, total: selected.length, prefix: `[${t.name}]` });
          const abort = () => run.cancel();
          extra.signal.addEventListener("abort", abort, { once: true });
          const r = await awaitRun(run, sink, extra, Math.max(0, deadline - Date.now()));
          extra.signal.removeEventListener("abort", abort);
          stop();
          if (!r) {
            inFlight = run;
            rows.push({ name: t.name, status: "running", runId: run.id, failure: null });
            break;
          }
          rows.push({ name: t.name, status: r.status, runId: r.runId, durationMs: r.durationMs, failure: r.failure ? `${r.failure.step ?? ""} ${r.failure.reason}`.trim() : null });
          if (a.stopOnFailure && r.status !== "passed") break;
        }
        extra.signal.removeEventListener("abort", onAbort);
        const passed = rows.filter((r) => r.status === "passed").length;
        const finished = rows.filter((r) => r.status !== "running").length;
        const lines = [`Suite: ${passed}/${finished} passed${rows.length < selected.length ? ` (${selected.length - rows.length} not run)` : ""}`, "", "| Test | Status | Run | Failure |", "|---|---|---|---|"];
        for (const r of rows) lines.push(`| ${String(r.name)} | ${String(r.status).toUpperCase()} | ${String(r.runId ?? "")} | ${String(r.failure ?? r.reason ?? "")} |`);
        if (inFlight) lines.push("", `Wait cap reached: ${inFlight.name} is still running (follow its run ${inFlight.id} with tail_run waitMs "60s"); the remaining tests were not started. Re-run the suite with names: [...] for them.`);
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
        const p = live.partialResult();
        return a.format === "json" ? json(p) : text(`${renderMarkdown(p, { partial: true })}\nrunId: ${p.runId}\nreport: ${p.dir}`);
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
        "Return a run's events after a sequence number (step.started/passed/failed/skipped, log, session, run.finished). Poll with afterSeq = the returned lastSeq to follow a run started with wait: false. With waitMs the call long-polls: it returns as soon as a new event arrives, when the run finishes, or after waitMs (max 60s).",
      inputSchema: {
        runId: z.string().describe('Run id or "latest"'),
        afterSeq: z.number().int().min(0).optional().describe("Only events with seq > afterSeq (default 0)"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max events (default 200)"),
        waitMs: duration.optional().describe('Long-poll: wait up to this long for new events (e.g. "30s"; max 60s). Default 0 = return at once.'),
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
        const waitMs = a.waitMs !== undefined ? Math.min(MAX_TAIL_WAIT_MS, Math.max(0, parseDuration(a.waitMs))) : 0;
        if (waitMs > 0 && !live.result && !live.events.some((e) => e.seq > after)) await waitForRunEvent(live, waitMs);
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
      description: "List saved playtests in playtests/ with description and tags, plus the shared step fragments in playtests/_shared/ that `use: <name>` steps can reference.",
      inputSchema: { tag: z.string().optional().describe("Only tests with this tag") },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const list = (await d.tests.list()).filter((t) => !a.tag || t.tags.includes(a.tag));
      const fragments = await d.tests.fragments();
      return json({
        dir: d.tests.dir,
        tests: list.map((t) => ({ name: t.name, description: t.description, tags: t.tags, ...(t.parseError ? { parseError: t.parseError } : {}) })),
        fragments: fragments.map((f) => ({ name: f.name, description: f.description, steps: f.steps.length, ...(f.parseError ? { parseError: f.parseError } : {}) })),
      });
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
        const v = validateInput(a.spec, d.catalog, { expectName: a.name, sharedFragments: await d.tests.fragmentMap() });
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
        "Start (or reuse) a Studio test session so later runs and inspect calls are fast: players 0 = Run mode, 1 = Play, 2-8 = multiplayer (Studio simulated players). Waits until the server and all clients are attached and characters are loaded (or 2.5s after the players joined when no character spawns, for games that spawn characters from a menu; use wait: character.loaded in tests then). Fails if Studio has not started the test within 30s or it is not ready within 60s (1.5x for multiplayer).",
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
      description:
        "End the current Studio test session (EndTest on the server; RunService:Stop via the edit node as fallback, which only works for Run mode) and wait for Studio to confirm the teardown, so a start_session right after it does not race. Also ends a test this daemon launched but lost track of (failed launch, detached server node) when its server node is attached. Refused while a run is active; cancel_run first. With force: true also ends a test launched by another (restarted) daemon or by hand whose server node is attached here; a test driven by another live daemon must be stopped from that daemon or in Studio.",
      inputSchema: {
        force: z.boolean().optional().describe("Stop whatever test Studio is running, even one launched by another daemon or by hand"),
      },
    },
    async (a) => {
      if (d.runs.active()) return fail(new StagehandError("SESSION_ERROR", "a run is active; cancel_run first"));
      try {
        if (a.force) return json(await d.sessions.stopStudio());
        const r = await d.sessions.stopOwn("stop_session");
        if (!r.ended && !r.hint) return json({ ...r, hint: "no session of this daemon is running and Studio reports no test of ours; pass force: true to stop a test launched elsewhere" });
        return json(r);
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
        "Run arbitrary Luau on a node and return its value and captured logs. `actor`, `player`, `character` and `vars` are in scope. Disabled unless the daemon was started with --allow-eval (returns EVAL_DISABLED). Defaults to the session's server, else the edit DataModel. For one-off debugging outside a Stagehand session, prefer a Studio MCP (roblox-assistant, Roblox Studio MCP).",
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
