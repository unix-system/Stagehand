// `stagehand-mcp --run <name>...`: run saved playtests from the command line (no MCP client).
// Starts the broker, waits for a Studio edit node, runs the tests one after another exactly like the
// `run_test` tool does, prints each report, ends the session and exits non-zero on failure.
import type { NodeInfo, NodeRegistry } from "../broker/nodes.js";
import { StagehandError } from "../broker/protocol.js";
import type { Daemon } from "../daemon.js";
import { renderMarkdown } from "../engine/reporter.js";
import type { RunResult } from "../engine/types.js";
import { describeEvent } from "../server/progress.js";

export interface CliRunOptions {
  names: string[];
  /** How long to wait for a Studio edit node to attach before giving up. */
  waitForStudioMs: number;
  json?: boolean;
  /** Per-run whole-run timeout override. */
  timeoutMs?: number;
  signal?: AbortSignal;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface CliRunRow {
  name: string;
  status: string;
  runId: string | null;
  durationMs: number | null;
  failure: string | null;
  dir: string | null;
}

export type CliExitCode = 0 | 1 | 2;

/** Resolve once an `edit` node is attached to the broker (immediately if one already is). */
export function waitForEditNode(registry: NodeRegistry, timeoutMs: number, signal?: AbortSignal): Promise<NodeInfo> {
  const existing = registry.findEdit();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    let unsub = (): void => {};
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      unsub();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => reject(new StagehandError("CANCELLED", "aborted while waiting for Studio")));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new StagehandError(
              "SESSION_ERROR",
              `no Studio edit node attached within ${Math.round(timeoutMs / 1000)}s; is Studio open with the Stagehand plugin installed, and is its Stagehand.Port setting the broker port?`,
            ),
          ),
        ),
      timeoutMs,
    );
    unsub = registry.on((e) => {
      if (e.kind === "attached" && e.node.role === "edit") finish(() => resolve(e.node));
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "-";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function renderTable(rows: CliRunRow[]): string {
  const lines = ["| Test | Result | Time | Failure |", "|---|---|---|---|"];
  for (const r of rows) {
    const res = r.status === "passed" ? "PASS" : r.status.toUpperCase();
    lines.push(`| ${r.name} | ${res} | ${fmtMs(r.durationMs)} | ${(r.failure ?? "").replace(/\|/g, "\\|")} |`);
  }
  const passed = rows.filter((r) => r.status === "passed").length;
  lines.push("", `${passed}/${rows.length} passed`);
  return lines.join("\n");
}

function rowOf(name: string, r: RunResult): CliRunRow {
  const failure = r.failure ? `${r.failure.step ?? ""} ${r.failure.reason ?? ""}`.trim() : r.errors[0]?.message ?? null;
  return { name, status: r.status, runId: r.runId, durationMs: r.durationMs, failure: failure || null, dir: r.dir };
}

export async function cliRun(d: Daemon, o: CliRunOptions): Promise<CliExitCode> {
  const out = o.out ?? ((s) => process.stdout.write(s + "\n"));
  const err = o.err ?? ((s) => process.stderr.write(s + "\n"));
  if (d.brokerError) {
    err(`stagehand: broker not running: ${d.brokerError}`);
    return 2;
  }
  if (o.names.length === 0) {
    err("stagehand: no tests given");
    return 2;
  }

  // Resolve every test before waiting on Studio so typos fail fast.
  const tests: Array<{ name: string; text: string }> = [];
  for (const name of o.names) {
    let t: { name: string; text: string } | null;
    try {
      t = await d.tests.get(name);
    } catch (e) {
      err(`stagehand: ${(e as Error).message}`);
      return 2;
    }
    if (!t) {
      err(`stagehand: no saved test "${name}" under ${d.root}/playtests`);
      return 2;
    }
    tests.push({ name, text: t.text });
  }

  err(`stagehand: waiting up to ${Math.round(o.waitForStudioMs / 1000)}s for a Studio edit node on http://127.0.0.1:${d.broker.port}/v1 ...`);
  try {
    const node = await waitForEditNode(d.registry, o.waitForStudioMs, o.signal);
    err(`stagehand: edit node ${node.nodeId} attached (place ${node.placeName ?? node.placeId ?? "?"})`);
  } catch (e) {
    err(`stagehand: ${(e as Error).message}`);
    return 2;
  }

  const rows: CliRunRow[] = [];
  const results: RunResult[] = [];
  for (const t of tests) {
    if (o.signal?.aborted) break;
    const run = d.runs.start({ input: t.text, fallbackName: t.name, expectName: t.name, timeoutMs: o.timeoutMs });
    const unsub = run.on((ev) => {
      if (o.json) return;
      const msg = describeEvent(ev);
      if (msg) err(`[${t.name}] ${msg}`);
    });
    const onAbort = (): void => void run.cancel();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const result = await run.done;
    o.signal?.removeEventListener("abort", onAbort);
    unsub();
    results.push(result);
    rows.push(rowOf(t.name, result));
    if (!o.json) out(renderMarkdown(result) + `\nreport: ${result.dir}\n`);
  }

  const passed = rows.filter((r) => r.status === "passed").length;
  if (o.json) out(JSON.stringify({ passed, total: tests.length, rows, results }, null, 2));
  else out(renderTable(rows));

  await d.sessions.end("cli run finished").catch(() => {});
  return rows.length === tests.length && passed === tests.length ? 0 : 1;
}
