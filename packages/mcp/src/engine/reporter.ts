// Reporter: NDJSON event file, result JSON and Markdown summary under .stagehand/runs/<ts>-<name>/.
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { formatDuration } from "../spec/values.js";
import type { RunEvent, RunResult, StepRecord } from "./types.js";

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

export function renderMarkdown(r: RunResult): string {
  const lines: string[] = [];
  lines.push(`# ${r.name}: ${r.status.toUpperCase()}`);
  lines.push("");
  lines.push(`- Run: \`${r.runId}\``);
  lines.push(`- Started: ${r.startedAt} (${formatDuration(r.durationMs)})`);
  if (r.session)
    lines.push(`- Session: ${r.session.mode}, ${r.session.players} player(s)${r.session.sessionId ? `, \`${r.session.sessionId}\`` : ""}${r.session.reused ? " (reused)" : ""}`);
  lines.push(
    `- Steps: ${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.skipped} skipped${r.counts.cancelled ? `, ${r.counts.cancelled} cancelled` : ""}`,
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
    if (f.expected !== undefined) lines.push("", "Expected:", json(f.expected));
    if (f.actual !== undefined) lines.push("", "Actual:", json(f.actual));
    if (f.logsAround.length) {
      lines.push("", "Logs around the failure:", "", "```");
      for (const l of f.logsAround) lines.push(`[${l.level}] ${l.role}${l.stepId ? ` ${l.stepId}` : ""}: ${l.message}`);
      lines.push("```");
    }
  }
  if (r.steps.length) {
    lines.push("", "## Steps", "", "| Step | Description | Node | Status | Time |", "|---|---|---|---|---|");
    for (const s of r.steps) lines.push(stepRow(s));
  }
  if (r.softFailures.length) lines.push("", `Soft failures: ${r.softFailures.map((s) => `\`${s}\``).join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

function stepRow(s: StepRecord): string {
  const status = STATUS_MARK[s.status] ?? s.status;
  const extra = s.status === "failed" && s.reason ? `: ${s.reason}` : s.skipReason ? ` (${s.skipReason})` : "";
  return `| \`${s.id}\` | ${cell(s.display)}${s.soft ? " (soft)" : ""} | ${s.target} | ${status}${cell(extra)} | ${s.durationMs != null ? formatDuration(s.durationMs) : ""} |`;
}
