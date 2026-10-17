// Reporter: NDJSON event file, result JSON and Markdown summary under .stagehand/runs/<ts>-<name>/.
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { formatDuration } from "../spec/values.js";
import type { PartialRunResult, RunEvent, RunResult, StepRecord } from "./types.js";

export class Reporter {
  private stream: WriteStream | null = null;
  constructor(readonly dir: string) {}

  open(): void {
    mkdirSync(this.dir, { recursive: true });
    this.stream = createWriteStream(path.join(this.dir, "events.ndjson"), { flags: "a" });
    this.stream.on("error", () => {});
  }

  event(ev: RunEvent): void {
    this.stream?.write(`${JSON.stringify(ev)}\n`);
  }

  async finish(result: RunResult): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const s = this.stream;
    this.stream = null;
    if (s) await new Promise<void>((resolve) => s.end(() => resolve()));
    await writeFile(path.join(this.dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await writeFile(path.join(this.dir, "summary.md"), renderMarkdown(result), "utf8");
  }
}

const STATUS_MARK: Record<string, string> = {
  passed: "PASS",
  failed: "FAIL",
  skipped: "skip",
  cancelled: "cancel",
  pending: "-",
  running: "...",
};

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function json(v: unknown): string {
  return "```json\n" + JSON.stringify(v, null, 2) + "\n```";
}

/** One-line JSON for table cells, truncated so a long lua return does not swallow the report. */
export function compact(v: unknown, max = 120): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  s = s.replace(/\s*\n\s*/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const NOT_RUN = new Set(["pending", "skipped", "cancelled"]);

/**
 * Markdown report. Also used for partial (in-progress) results: `partial` adds the live status line
 * and leaves out the sections that only make sense once the run is over.
 */
export function renderMarkdown(r: RunResult | PartialRunResult, opts: { partial?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`# ${r.name}: ${r.status.toUpperCase()}${opts.partial ? " (in progress)" : ""}`);
  lines.push("");
  lines.push(`- Run: \`${r.runId}\``);
  lines.push(`- Started: ${r.startedAt} (${formatDuration(r.durationMs)}${opts.partial ? " so far" : ""})`);
  if (r.session)
    lines.push(`- Session: ${r.session.mode}, ${r.session.players} player(s)${r.session.sessionId ? `, \`${r.session.sessionId}\`` : ""}${r.session.reused ? " (reused)" : ""}`);
  const ran = r.counts.passed + r.counts.failed;
  lines.push(
    `- Steps: ${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.skipped} skipped${r.counts.cancelled ? `, ${r.counts.cancelled} cancelled` : ""}${opts.partial ? `, ${r.counts.pending} pending` : ""}`,
  );
  lines.push(`- Logs: ${r.logCounts.error} error(s), ${r.logCounts.warn} warning(s)`);
  if (r.errors.length) {
    lines.push("", "## Errors", "");
    for (const e of r.errors) lines.push(`- \`${e.path}\`${e.line ? ` (line ${e.line})` : ""}: ${e.message}`);
  }
  if (r.failure) {
    const f = r.failure;
    lines.push("", "## Failure", "");
    if (f.step) lines.push(`Step \`${f.step}\`: ${f.display ?? ""}${f.node ? ` (node ${f.node})` : ""}`, "");
    lines.push(`**Reason:** ${f.reason}`);
    if (f.hint) lines.push("", `**Hint:** ${f.hint}`);
    // Actions have no expected/actual; the plugin sends null for them, which is not worth a block.
    if (f.expected != null) lines.push("", "Expected:", json(f.expected));
    if (f.actual != null) lines.push("", "Actual:", json(f.actual));
    if (f.logsAround.length) {
      lines.push("", "Logs around the failure:", "", "```");
      for (const l of f.logsAround) lines.push(`[${l.level}] ${l.role}${l.stepId ? ` ${l.stepId}` : ""}: ${l.message}`);
      lines.push("```");
    }
  }
  // A spec that never ran (validation error) has nothing to say per step; otherwise a trailing run of
  // steps that never executed collapses into one line.
  if (r.steps.length && !(r.status === "error" && ran === 0)) {
    lines.push("", "## Steps", "", "| Step | Description | Node | Status | Time |", "|---|---|---|---|---|");
    let tail = r.steps.length;
    while (tail > 0) {
      const st = r.steps[tail - 1]!.status;
      if (!NOT_RUN.has(st) || st === "cancelled") break;
      tail--;
    }
    const shown = tail < r.steps.length - 1 ? r.steps.slice(0, tail) : r.steps;
    for (const s of shown) lines.push(stepRow(s));
    const rest = r.steps.slice(shown.length);
    if (rest.length) {
      const first = rest[0]!;
      lines.push(`| … | ${rest.length} more step(s) not run (${first.skipReason ?? first.status}) | | | |`);
    }
  }
  if (r.softFailures.length) lines.push("", `Soft failures: ${r.softFailures.map((s) => `\`${s}\``).join(", ")}`);
  const vars = Object.entries(r.vars ?? {});
  if (vars.length) {
    lines.push("", "## Vars", "");
    for (const [k, v] of vars) lines.push(`- \`${k}\` = ${cell(compact(v, 400))}`);
  }
  lines.push("");
  return lines.join("\n");
}

function stepRow(s: StepRecord): string {
  const status = STATUS_MARK[s.status] ?? s.status;
  const extra = s.status === "failed" && s.reason ? `: ${s.reason}` : s.skipReason ? ` (${s.skipReason})` : "";
  const value = s.value !== undefined && s.value !== null ? ` → ${compact(s.value)}` : "";
  return `| \`${s.id}\` | ${cell(s.display)}${s.soft ? " (soft)" : ""} | ${s.target} | ${status}${cell(extra)}${cell(value)} | ${s.durationMs != null ? formatDuration(s.durationMs) : ""} |`;
}
