// MCP progress notifications + logging messages for run_* tools (only when a progressToken is supplied).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Run } from "../engine/run.js";
import type { RunEvent } from "../engine/types.js";

export interface ToolExtra {
  _meta?: { progressToken?: string | number; [k: string]: unknown };
  signal: AbortSignal;
  sendNotification: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>;
}

/** Monotonic progress emitter. */
export class ProgressSink {
  private last = -1;
  constructor(
    private readonly server: McpServer,
    private readonly extra: ToolExtra,
  ) {}

  get enabled(): boolean {
    return this.extra._meta?.progressToken !== undefined;
  }

  report(progress: number, total: number | undefined, message: string): void {
    const token = this.extra._meta?.progressToken;
    if (token === undefined) return;
    let p = progress;
    if (p <= this.last) p = this.last + 0.001;
    this.last = p;
    const params: Record<string, unknown> = { progressToken: token, progress: +p.toFixed(3), message };
    if (total !== undefined) params.total = Math.max(total, p);
    this.extra.sendNotification({ method: "notifications/progress", params } as never).catch(() => {});
  }

  log(level: "debug" | "info" | "warning" | "error", data: unknown): void {
    if (!this.enabled) return;
    this.server.sendLoggingMessage({ level, logger: "stagehand", data }).catch(() => {});
  }

  /** Stream a run's events. `base`/`scale` map step progress into a suite-wide range. */
  follow(run: Run, opts: { base?: number; total?: number; prefix?: string } = {}): () => void {
    if (!this.enabled) return () => {};
    const prefix = opts.prefix ? `${opts.prefix} ` : "";
    return run.on((ev: RunEvent) => {
      const msg = describeEvent(ev);
      if (!msg) return;
      const frac = run.totalSteps ? run.finishedSteps / run.totalSteps : 0;
      const progress = opts.total !== undefined ? (opts.base ?? 0) + frac : run.finishedSteps;
      const total = opts.total ?? run.totalSteps;
      this.report(progress, total, prefix + msg);
      const level = ev.type === "log" ? (ev.level === "error" ? "error" : ev.level === "warn" ? "warning" : "info") : ev.type === "step.failed" ? "error" : "info";
      if (ev.type !== "step.started") this.log(level, prefix + msg);
    });
  }
}

export function describeEvent(ev: RunEvent): string | null {
  const id = typeof ev.stepId === "string" ? ev.stepId : "";
  const d = typeof ev.display === "string" ? ev.display : "";
  const ms = typeof ev.durationMs === "number" ? ` (${ev.durationMs}ms)` : "";
  switch (ev.type) {
    case "run.started":
      return `run ${String(ev.runId)} started`;
    case "session":
      return String(ev.message);
    case "session.ready":
      return `session ${String(ev.sessionId ?? "edit")} ready${ev.reused ? " (reused)" : ""}`;
    case "phase.started":
      return `${String(ev.phase)}:`;
    case "step.started":
      return `${id} ... ${d}`;
    case "step.passed":
      return `${id} PASS ${d}${ms}`;
    case "step.failed":
      return `${id} FAIL ${d}: ${String(ev.reason ?? "")}`;
    case "step.skipped":
      return `${id} skip ${d} (${String(ev.reason ?? "")})`;
    case "step.cancelled":
      return `${id} cancelled ${d}`;
    case "log":
      return `[${String(ev.role)}] ${String(ev.level)}: ${String(ev.message)}`;
    case "run.finished":
      return `run finished: ${String(ev.status).toUpperCase()}`;
    case "validation.failed":
      return "validation failed";
    default:
      return null;
  }
}
