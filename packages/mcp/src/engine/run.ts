// Runner: dispatch segments, collect events, cancel on failure, teardown always, run timeout, failOnError.
import type { NodeInfo, NodeRegistry, RegistryEvent } from "../broker/nodes.js";
import {
  DAEMON_TIMEOUT_SLACK_MS,
  type ErrorObject,
  type NodeEvent,
  type RunSegmentParams,
  type RunSegmentResult,
  StagehandError,
  type WireStep,
} from "../broker/protocol.js";
import type { Catalog } from "../spec/catalog.js";
import type { Diagnostic, Step } from "../spec/types.js";
import { formatDuration, isTruthy, substituteVars } from "../spec/values.js";
import type { RunsStore } from "../store/runs.js";
import { evaluateLogCondition } from "./logs.js";
import {
  type DaemonNode,
  type NodeTarget,
  type ParallelNode,
  type Plan,
  type PlanNode,
  type PlanStep,
  type SegmentNode,
  stepsOf,
  targetKey,
} from "./plan.js";
import { pushProgress } from "./progress.js";
import { Reporter } from "./reporter.js";
import type { SessionHandle, SessionManager } from "./sessions.js";
import type { FailureInfo, LogRecord, PartialRunResult, RunEvent, RunResult, RunStatus, StepRecord } from "./types.js";
import { validateInput } from "./validate.js";

type Outcome = "passed" | "failed" | "cancelled";

export interface RunRequest {
  /** Spec as YAML/JSON text or object. */
  input: unknown;
  /** Name used for the run when the spec is invalid. */
  fallbackName?: string;
  extraVars?: Record<string, unknown>;
  /** Overrides the spec's whole-run timeout. */
  timeoutMs?: number;
  /** Require spec.name to equal this (saved tests). */
  expectName?: string;
  /** Shared fragments (playtests/_shared) for `use:` steps. */
  sharedFragments?: Record<string, Step[]>;
}

export interface RunManagerDeps {
  registry: NodeRegistry;
  catalog: Catalog;
  sessions: SessionManager;
  runs: RunsStore;
  /** Wait until the live catalogs of these nodes are known (best effort); `force` re-reads them. */
  awaitCatalogs?: (nodeIds: string[], force?: boolean) => Promise<void>;
  log?: (msg: string) => void;
  /** Delay to collect trailing events/logs before evaluating log conditions or finishing. */
  settleMs?: number;
  /** How long to wait for a cancelled segment's result. */
  cancelGraceMs?: number;
}

const TERMINAL = new Set(["passed", "failed", "skipped", "cancelled"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RunManager {
  private lock: Promise<unknown> = Promise.resolve();
  private readonly recent = new Map<string, Run>();
  private current: Run | null = null;

  constructor(readonly deps: RunManagerDeps) {}

  /** Validate and queue a run. Invalid specs produce a finished run with status "error". */
  start(req: RunRequest): Run {
    const live = this.deps.sessions.current();
    const liveSession = live && live.state === "ready" ? { mode: live.mode, players: live.players } : null;
    const v = validateInput(req.input, this.deps.catalog, { extraVars: req.extraVars, expectName: req.expectName, liveSession, sharedFragments: req.sharedFragments });
    const name = v.spec?.name ?? req.fallbackName ?? "invalid";
    const { runId, dir } = this.deps.runs.allocate(name);
    const run = new Run(runId, name, dir, this.deps, req, v.plan, v.errors, v.warnings);
    this.recent.set(runId, run);
    if (this.recent.size > 50) this.recent.delete(this.recent.keys().next().value as string);
    if (!v.plan) {
      void run.finishInvalid();
      return run;
    }
    pushProgress(run, this.deps.registry);
    const exec = this.lock.then(async () => {
      this.current = run;
      try {
        await run.execute();
      } finally {
        this.current = null;
      }
    });
    this.lock = exec.catch(() => {});
    return run;
  }

  get(runId: string): Run | undefined {
    if (runId === "latest") return [...this.recent.values()].pop();
    return this.recent.get(runId);
  }

  active(): Run | null {
    return this.current;
  }

  queued(): Run[] {
    return [...this.recent.values()].filter((r) => r.status === "queued");
  }

  /** Serialize non-run work (start/stop session) with runs. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn);
    this.lock = p.catch(() => {});
    return p;
  }
}

export class Run {
  status: RunStatus = "queued";
  readonly events: RunEvent[] = [];
  result: RunResult | null = null;
  readonly done: Promise<RunResult>;
  private resolveDone!: (r: RunResult) => void;
  private readonly listeners = new Set<(ev: RunEvent, run: Run) => void>();
  private readonly reporter: Reporter;
  private readonly t0 = Date.now();
  private startedAt = new Date();
  private seq = 0;

  private plan: Plan | null;
  private handle: SessionHandle | null = null;
  private vars: Record<string, unknown> = {};
  private readonly records = new Map<string, StepRecord>();
  private readonly emittedTerminal = new Set<string>();
  private readonly logs: LogRecord[] = [];
  private readonly failureOrder: string[] = [];
  private readonly softFailures: string[] = [];
  private readonly detailWaiters = new Map<string, Array<() => void>>();
  /** Segments the daemon sent `cancel` for (abort/parallel failure/run cancel), not for a TIMEOUT. */
  private readonly daemonCancelled = new Set<string>();
  private lastStarted: string | null = null;
  private readonly runCtrl = new AbortController();
  private abortKind: "failed" | "timeout" | "cancelled" | null = null;
  private failed = false;
  private infraError: StagehandError | null = null;
  private phaseActive = false;
  private dispatched = false;
  private readonly timeoutOverrideMs: number | undefined;

  private isCancelled(): boolean {
    return this.abortKind === "cancelled";
  }

  constructor(
    readonly id: string,
    readonly name: string,
    readonly dir: string,
    private readonly deps: RunManagerDeps,
    private readonly req: RunRequest,
    plan: Plan | null,
    private readonly errors: Diagnostic[],
    private readonly warnings: Diagnostic[],
  ) {
    this.plan = plan;
    this.timeoutOverrideMs = req.timeoutMs;
    this.reporter = new Reporter(dir);
    this.done = new Promise((r) => (this.resolveDone = r));
    if (plan) this.initRecords(plan);
  }

  private initRecords(plan: Plan): void {
    this.records.clear();
    for (const s of plan.allSteps) {
      this.records.set(s.id, {
        id: s.id,
        phase: s.phase,
        display: s.display,
        verb: s.verb,
        name: s.name,
        label: s.label,
        actor: s.actor,
        target: s.daemon ? "daemon" : targetKey(s.target),
        nodeId: null,
        soft: s.soft,
        timeoutMs: s.timeoutMs,
        withinMs: s.withinMs,
        status: "pending",
        durationMs: null,
        startedAt: null,
      });
    }
  }

  // ---- public ---------------------------------------------------------------

  on(listener: (ev: RunEvent, run: Run) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(): boolean {
    if (this.status !== "running" && this.status !== "queued") return false;
    this.abortRun("cancelled");
    return true;
  }

  get totalSteps(): number {
    return this.records.size;
  }

  get finishedSteps(): number {
    let n = 0;
    for (const r of this.records.values()) if (TERMINAL.has(r.status)) n++;
    return n;
  }

  stepRecords(): StepRecord[] {
    return [...this.records.values()];
  }

  summary(): Record<string, unknown> {
    return {
      runId: this.id,
      name: this.name,
      status: this.status,
      steps: { total: this.totalSteps, finished: this.finishedSteps },
      dir: this.dir,
      lastSeq: this.seq,
    };
  }

  // ---- events ---------------------------------------------------------------

  private emit(type: string, fields: Record<string, unknown> = {}): RunEvent {
    const ev: RunEvent = { seq: ++this.seq, type, t: Date.now() - this.t0, ...fields };
    this.events.push(ev);
    this.reporter.event(ev);
    for (const l of [...this.listeners]) {
      try {
        l(ev, this);
      } catch {
        /* ignore */
      }
    }
    return ev;
  }

  private stepEvent(rec: StepRecord, type: string, extra: Record<string, unknown> = {}): void {
    if (type !== "step.started") this.emittedTerminal.add(rec.id);
    this.emit(type, {
      runId: this.id,
      stepId: rec.id,
      display: rec.display,
      phase: rec.phase,
      node: rec.nodeId,
      target: rec.target,
      ...extra,
    });
  }

  private onRegistry = (e: RegistryEvent): void => {
    if (e.kind !== "event") return;
    const ev = e.event;
    const node = e.node;
    if (ev.type === "log") {
      if (!this.handle) return;
      const inSession =
        (this.handle.sessionId !== null && node.sessionId === this.handle.sessionId) ||
        (this.handle.mode === "edit" && node.role === "edit");
      if (inSession) this.onLog(node, ev);
      return;
    }
    if (ev.runId !== this.id) return;
    if (ev.type.startsWith("segment.")) {
      this.emit(ev.type, { runId: this.id, segmentId: ev.segmentId, node: node.nodeId, status: ev.status });
      return;
    }
    if (!ev.type.startsWith("step.") || typeof ev.stepId !== "string") return;
    const rec = this.records.get(ev.stepId);
    if (!rec) return;
    rec.nodeId ??= node.nodeId;
    switch (ev.type) {
      case "step.started":
        if (rec.status === "pending") rec.status = "running";
        rec.startedAt = Date.now();
        this.lastStarted = rec.id;
        this.stepEvent(rec, "step.started");
        return;
      case "step.passed":
        if (typeof ev.durationMs === "number") rec.durationMs = ev.durationMs;
        if ("value" in ev) rec.value = ev.value;
        if (rec.status !== "failed") rec.status = "passed";
        this.stepEvent(rec, rec.status === "failed" ? "step.failed" : "step.passed", {
          durationMs: rec.durationMs,
          value: rec.value,
          ...(rec.status === "failed" ? { reason: rec.reason, error: rec.error } : {}),
        });
        return;
      case "step.failed":
        if (typeof ev.durationMs === "number") rec.durationMs = ev.durationMs;
        if (
          (ev.error as ErrorObject | undefined)?.code === "CANCELLED" &&
          typeof ev.segmentId === "string" &&
          this.daemonCancelled.has(ev.segmentId)
        ) {
          // A daemon-initiated cancel: the node reports it as step.failed{CANCELLED}. Record it as cancelled,
          // unless the daemon already failed the step itself (run timeout), whose reason/error must stay.
          if (rec.status === "failed") return;
          if (!TERMINAL.has(rec.status)) rec.status = "cancelled";
          rec.skipReason = "cancelled";
          this.stepEvent(rec, "step.cancelled", { durationMs: rec.durationMs, reason: "cancelled" });
          return;
        }
        // The event may trail the segment result (client events are relayed through the server): only fill
        // fields the result did not carry, and never emit a second terminal event for the step.
        if (typeof ev.reason === "string") rec.reason ??= ev.reason;
        if (ev.expected != null) rec.expected ??= ev.expected;
        if (ev.actual != null) rec.actual ??= ev.actual;
        if (ev.error && typeof ev.error === "object") rec.error ??= ev.error as ErrorObject;
        this.setFailed(rec);
        this.deriveHint(rec);
        if (!this.emittedTerminal.has(rec.id)) {
          this.stepEvent(rec, "step.failed", {
            durationMs: rec.durationMs,
            reason: rec.reason,
            expected: rec.expected,
            actual: rec.actual,
            error: rec.error,
            hint: rec.hint,
          });
        }
        this.wakeDetails(rec.id);
        return;
      case "step.skipped":
        if (!TERMINAL.has(rec.status)) {
          rec.status = "skipped";
          rec.skipReason = typeof ev.reason === "string" ? ev.reason : "aborted";
        }
        this.stepEvent(rec, "step.skipped", { reason: rec.skipReason });
        return;
    }
  };

  private onLog(node: NodeInfo, ev: NodeEvent): void {
    const level = ev.level === "error" || ev.level === "warn" ? ev.level : "info";
    const stepId = typeof ev.stepId === "string" && this.records.has(ev.stepId) ? ev.stepId : null;
    const log: LogRecord = {
      t: Date.now() - this.t0,
      level,
      message: String(ev.message ?? ""),
      nodeId: node.nodeId,
      role: node.role === "client" ? `client#${node.playerIndex ?? "?"}` : node.role,
      stepId,
    };
    this.logs.push(log);
    this.emit("log", { level, message: log.message, node: node.nodeId, role: log.role, stepId });
    if (level !== "error" || !this.plan?.failOnError || !this.phaseActive) return;
    const target = stepId ?? this.activeStepId();
    const rec = target ? this.records.get(target) : undefined;
    if (!rec) {
      this.failed = true;
      this.infraError ??= new StagehandError("ACTION_ERROR", `error logged outside any step (failOnError): ${log.message}`);
      this.abortRun("failed");
      return;
    }
    if (rec.status === "failed") return;
    rec.reason = `error logged during step (failOnError): ${log.message}`;
    rec.error = { code: "ACTION_ERROR", message: log.message, stepId: rec.id, details: { node: node.nodeId, role: log.role } };
    rec.actual = { log: { level, message: log.message, node: log.role } };
    rec.expected = { errors: 0 };
    this.setFailed(rec);
    this.stepEvent(rec, "step.failed", { reason: rec.reason, error: rec.error, actual: rec.actual, expected: rec.expected });
    if (!rec.soft) this.abortRun("failed");
  }

  private activeStepId(): string | null {
    let best: StepRecord | null = null;
    for (const r of this.records.values()) {
      if (r.status === "running" && (!best || (r.startedAt ?? 0) >= (best.startedAt ?? 0))) best = r;
    }
    return best?.id ?? this.lastStarted;
  }

  private setFailed(rec: StepRecord): void {
    const was = rec.status;
    rec.status = "failed";
    if (was === "failed") return;
    if (rec.soft) {
      if (!this.softFailures.includes(rec.id)) this.softFailures.push(rec.id);
    } else {
      this.failed = true;
      if (!this.failureOrder.includes(rec.id)) this.failureOrder.push(rec.id);
    }
  }

  private wakeDetails(id: string): void {
    const ws = this.detailWaiters.get(id);
    this.detailWaiters.delete(id);
    for (const w of ws ?? []) w();
  }

  private waitDetails(id: string, ms: number): Promise<void> {
    const rec = this.records.get(id);
    if (!rec || rec.reason !== undefined) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const list = this.detailWaiters.get(id) ?? [];
      list.push(() => {
        clearTimeout(t);
        resolve();
      });
      this.detailWaiters.set(id, list);
    });
  }

  private abortRun(kind: "failed" | "timeout" | "cancelled"): void {
    if (this.abortKind) return;
    this.abortKind = kind;
    if (kind === "timeout") {
      const ms = this.timeoutOverrideMs ?? this.plan?.timeoutMs ?? 0;
      let any = false;
      for (const r of this.records.values()) {
        if (r.status !== "running") continue;
        any = true;
        r.reason = `run timeout of ${formatDuration(ms)} exceeded`;
        r.error = { code: "TIMEOUT", message: r.reason, stepId: r.id };
        r.status = "failed";
        if (!this.failureOrder.includes(r.id)) this.failureOrder.push(r.id);
        this.stepEvent(r, "step.failed", { reason: r.reason, error: r.error });
      }
      this.failed = true;
      if (!any) this.infraError ??= new StagehandError("TIMEOUT", `run timeout of ${formatDuration(ms)} exceeded`);
    }
    this.runCtrl.abort();
  }

  // ---- execution ------------------------------------------------------------

  async finishInvalid(): Promise<void> {
    this.reporter.open();
    this.emit("run.started", { runId: this.id, name: this.name });
    this.emit("validation.failed", { errors: this.errors });
    await this.finish("error");
  }

  async execute(): Promise<void> {
    const plan = this.plan!;
    this.status = "running";
    this.startedAt = new Date();
    this.reporter.open();
    this.emit("run.started", { runId: this.id, name: this.name, steps: this.totalSteps, session: plan.session });
    const unsub = this.deps.registry.on(this.onRegistry);
    let runTimer: NodeJS.Timeout | null = null;
    try {
      if (this.isCancelled()) return await this.finish("cancelled");
      try {
        this.handle = await this.deps.sessions.ensure(plan.session, {
          signal: this.runCtrl.signal,
          onProgress: (message) => this.emit("session", { message }),
        });
      } catch (e) {
        const err = StagehandError.from(e);
        if (this.isCancelled()) return await this.finish("cancelled");
        this.infraError = err;
        return await this.finish("error");
      }
      this.emit("session.ready", {
        sessionId: this.handle.sessionId,
        mode: this.handle.mode,
        players: this.handle.players,
        reused: this.handle.reused,
      });

      // Re-check against the live catalog (game.* hooks, routing) now that the game is running. Hooks may
      // register after the node attached, so the catalogs are re-read rather than taken from the attach.
      const nodeIds = this.sessionNodeIds();
      await this.deps.awaitCatalogs?.(nodeIds, true).catch(() => {});
      const re = validateInput(this.req.input, this.deps.catalog, {
        extraVars: this.req.extraVars,
        expectName: this.req.expectName,
        sharedFragments: this.req.sharedFragments,
      });
      if (!re.ok || !re.plan) {
        this.errors.push(...re.errors);
        this.infraError = new StagehandError("UNKNOWN_ACTION", re.errors.map((d) => `${d.path}: ${d.message}`).join("; "));
        return await this.finish("error");
      }
      this.plan = { ...re.plan, vars: plan.vars, timeoutMs: plan.timeoutMs };
      this.initRecords(this.plan);
      this.vars = { ...this.plan.vars };

      const budget = this.timeoutOverrideMs ?? this.plan.timeoutMs;
      runTimer = setTimeout(() => this.abortRun("timeout"), budget);
      this.phaseActive = true;

      let ok = true;
      const p = this.plan;
      if (p.setup.length) {
        const rec = this.handle.record;
        if (this.handle.reused && rec?.setupDone.has(p.name)) {
          this.skipNodes(p.setup, "setup already ran in this reused session");
        } else {
          this.emit("phase.started", { phase: "setup" });
          ok = (await this.runList(p.setup, this.runCtrl.signal)) === "passed";
          if (ok && rec && p.session.reuse) rec.setupDone.add(p.name);
        }
      }
      if (ok) {
        this.emit("phase.started", { phase: "steps" });
        await this.runList(p.steps, this.runCtrl.signal);
      } else this.skipNodes(p.steps, "aborted");
      if (runTimer) clearTimeout(runTimer);
      runTimer = null;

      // Teardown always runs (own budget, best effort: continues past failures).
      if (p.teardown.length) {
        this.emit("phase.started", { phase: "teardown" });
        const td = new AbortController();
        const tdBudget = stepsOf(p.teardown).reduce((a, s) => a + stepBudget(s), 0) + 5_000;
        const tdTimer = setTimeout(() => td.abort(), tdBudget);
        await this.runList(p.teardown, td.signal, true);
        clearTimeout(tdTimer);
      }
      if (this.dispatched) await sleep(this.deps.settleMs ?? 150);
      this.phaseActive = false;
      const status: RunStatus =
        this.abortKind === "cancelled" ? "cancelled" : this.failed || this.abortKind === "timeout" ? "failed" : "passed";
      return await this.finish(status as "passed" | "failed" | "cancelled");
    } catch (e) {
      this.infraError = StagehandError.from(e);
      return await this.finish("error");
    } finally {
      if (runTimer) clearTimeout(runTimer);
      unsub();
    }
  }

  private sessionNodeIds(): string[] {
    const h = this.handle;
    if (!h) return [];
    if (h.sessionId) return this.deps.registry.sessionNodes(h.sessionId).map((n) => n.nodeId);
    const e = this.deps.registry.findEdit(h.placeId);
    return e ? [e.nodeId] : [];
  }

  private resolveNode(t: NodeTarget): NodeInfo | undefined {
    const h = this.handle;
    if (!h) return undefined;
    if (t.role === "edit") return this.deps.registry.findEdit(h.placeId);
    if (!h.sessionId) return undefined;
    if (t.role === "server") return this.deps.registry.findServer(h.sessionId);
    return this.deps.registry.findClient(h.sessionId, t.playerIndex);
  }

  private async runList(nodes: PlanNode[], signal: AbortSignal, continueOnFailure = false): Promise<Outcome> {
    let worst: Outcome = "passed";
    for (let i = 0; i < nodes.length; i++) {
      if (signal.aborted && !continueOnFailure) {
        this.skipNodes(nodes.slice(i), "aborted");
        return "cancelled";
      }
      if (signal.aborted) {
        this.skipNodes(nodes.slice(i), "aborted");
        return worst === "passed" ? "cancelled" : worst;
      }
      const o = await this.runNode(nodes[i]!, signal);
      if (o === "failed") worst = "failed";
      else if (o === "cancelled" && worst === "passed") worst = "cancelled";
      if (o !== "passed" && !continueOnFailure) {
        this.skipNodes(nodes.slice(i + 1), "aborted");
        return o;
      }
    }
    return worst;
  }

  private runNode(n: PlanNode, signal: AbortSignal): Promise<Outcome> {
    switch (n.kind) {
      case "segment":
        return this.runSegment(n, signal);
      case "daemon":
        return this.runDaemonStep(n, signal);
      case "parallel":
        return this.runParallel(n, signal);
      case "group":
        if (n.ifVar && !isTruthy(this.vars[n.ifVar])) {
          this.skipNodes(n.children, "if");
          return Promise.resolve("passed");
        }
        return this.runList(n.children, signal);
    }
  }

  private skipNodes(nodes: PlanNode[], reason: string): void {
    for (const s of stepsOf(nodes)) this.skipStep(s.id, reason);
  }

  private skipStep(id: string, reason: string): void {
    const rec = this.records.get(id);
    if (!rec || TERMINAL.has(rec.status)) return;
    rec.status = rec.status === "running" ? "cancelled" : "skipped";
    rec.skipReason = reason;
    this.stepEvent(rec, rec.status === "cancelled" ? "step.cancelled" : "step.skipped", { reason, origin: "daemon" });
  }

  private failStep(id: string, err: ErrorObject): void {
    const rec = this.records.get(id);
    if (!rec || rec.status === "failed") return;
    rec.reason = err.message;
    rec.error = { ...err, stepId: id };
    this.setFailed(rec);
    this.stepEvent(rec, "step.failed", { reason: rec.reason, error: rec.error, origin: "daemon" });
  }

  private toWire(s: PlanStep): WireStep {
    return {
      id: s.id,
      verb: s.verb,
      name: s.name,
      params: substituteVars(s.params, this.vars) as Record<string, unknown>,
      timeoutMs: s.timeoutMs,
      withinMs: s.withinMs,
      soft: s.soft,
      actor: s.actor,
      label: s.label,
      save: s.save,
    };
  }

  private async runSegment(seg: SegmentNode, signal: AbortSignal): Promise<Outcome> {
    if (seg.ifVar && !isTruthy(this.vars[seg.ifVar])) {
      for (const s of seg.steps) this.skipStep(s.id, "if");
      return "passed";
    }
    if (signal.aborted) {
      for (const s of seg.steps) this.skipStep(s.id, "aborted");
      return "cancelled";
    }
    const node = this.resolveNode(seg.target);
    const first = seg.steps[0]!;
    if (!node) {
      this.failStep(first.id, {
        code: "RESOLVE_FAILED",
        message: `no ${targetKey(seg.target)} node attached for ${this.handle?.sessionId ? `session ${this.handle.sessionId}` : "this run"}`,
      });
      for (const s of seg.steps.slice(1)) this.skipStep(s.id, "aborted");
      return first.soft ? "passed" : "failed";
    }
    for (const s of seg.steps) {
      const r = this.records.get(s.id);
      if (r) r.nodeId = node.nodeId;
    }
    const params: RunSegmentParams = {
      runId: this.id,
      segmentId: seg.id,
      vars: { ...this.vars },
      actors: { ...(this.plan?.actors ?? {}) },
      steps: seg.steps.map((s) => this.toWire(s)),
    };
    const budget = seg.steps.reduce((a, s) => a + stepBudget(s), 0) + DAEMON_TIMEOUT_SLACK_MS;
    this.dispatched = true;
    this.emit("segment.dispatched", { segmentId: seg.id, node: node.nodeId, target: targetKey(seg.target), steps: seg.steps.map((s) => s.id) });
    const sendP = this.deps.registry.send(node.nodeId, "run_segment", params, {
      timeoutMs: budget,
      signal,
      abortQueuedOnly: true,
    });
    let graceTimer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    const graceP = new Promise<never>((_, reject) => {
      onAbort = () => {
        this.daemonCancelled.add(seg.id);
        this.deps.registry.send(node.nodeId, "cancel", { segmentId: seg.id }, { timeoutMs: 5_000 }).catch(() => {});
        graceTimer = setTimeout(
          () => reject(new StagehandError("CANCELLED", `segment ${seg.id} cancelled (no result after cancel)`)),
          this.deps.cancelGraceMs ?? 3_000,
        );
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    graceP.catch(() => {});
    let res: RunSegmentResult | null = null;
    let err: StagehandError | null = null;
    try {
      res = (await Promise.race([sendP, graceP])) as RunSegmentResult;
    } catch (e) {
      err = StagehandError.from(e);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      sendP.catch(() => {});
    }
    if (res && Array.isArray(res.steps)) {
      this.applyResult(seg, res);
    } else if (err && (err.code === "CANCELLED" || signal.aborted)) {
      for (const s of seg.steps) this.skipStep(s.id, "aborted");
    } else {
      const e = err ?? new StagehandError("INTERNAL", "run_segment returned no result");
      if (e.code === "TIMEOUT") this.deps.registry.send(node.nodeId, "cancel", { segmentId: seg.id }, { timeoutMs: 5_000 }).catch(() => {});
      const victim = seg.steps.find((s) => !TERMINAL.has(this.records.get(s.id)?.status ?? "passed")) ?? first;
      this.failStep(victim.id, e.toObject());
      for (const s of seg.steps) if (s !== victim) this.skipStep(s.id, "aborted");
    }
    // Give the node's step.failed event (reason/expected/actual) a moment to arrive when the result did
    // not carry them (plugins older than the result-entry fields).
    await Promise.all(
      seg.steps.filter((s) => this.records.get(s.id)?.status === "failed").map((s) => this.waitDetails(s.id, 300)),
    );
    for (const s of seg.steps) {
      const rec = this.records.get(s.id);
      if (rec?.status === "failed" && !this.emittedTerminal.has(rec.id)) {
        rec.reason ??= rec.error?.message || "step failed (the node sent no reason)";
        this.stepEvent(rec, "step.failed", { durationMs: rec.durationMs, reason: rec.reason, error: rec.error, origin: "result" });
      }
    }
    const failedHard = seg.steps.some((s) => {
      const r = this.records.get(s.id);
      return r?.status === "failed" && !r.soft;
    });
    if (failedHard) return "failed";
    if (signal.aborted || res?.status === "cancelled" || err) return "cancelled";
    return "passed";
  }

  private applyResult(seg: SegmentNode, res: RunSegmentResult): void {
    for (const r of res.steps) {
      const rec = this.records.get(r.id);
      if (!rec) continue;
      if (typeof r.durationMs === "number") rec.durationMs = r.durationMs;
      if (r.value !== undefined) rec.value = r.value;
      const step = seg.steps.find((s) => s.id === r.id);
      if (step?.save && r.value !== undefined) this.vars[step.save] = r.value;
      if (rec.status === "failed") continue;
      if (r.status === "failed") {
        // Failure details ride on the result (protocol.md "Result"); the step.failed event, which may
        // arrive later, only fills what is still missing. No placeholder reason: waitDetails() below
        // keeps waiting for the event while the reason is unknown (older plugins).
        if (typeof r.reason === "string") rec.reason ??= r.reason;
        if (r.expected != null) rec.expected ??= r.expected;
        if (r.actual != null) rec.actual ??= r.actual;
        if (r.error && typeof r.error === "object") rec.error ??= r.error;
        this.setFailed(rec);
        this.deriveHint(rec);
      } else if (r.status === "passed" || r.status === "skipped" || r.status === "cancelled") {
        rec.status = r.status;
        if (r.status === "skipped") rec.skipReason ??= "aborted";
        if (r.status === "cancelled") rec.skipReason ??= "cancelled";
      }
    }
    if (res.vars && typeof res.vars === "object") Object.assign(this.vars, res.vars);
    for (const s of seg.steps) {
      const rec = this.records.get(s.id)!;
      if (!TERMINAL.has(rec.status)) {
        rec.status = "skipped";
        rec.skipReason = "aborted";
      }
      if (!this.emittedTerminal.has(rec.id)) {
        if (rec.status === "failed" && rec.reason === undefined) continue; // wait for the step.failed event
        this.stepEvent(rec, `step.${rec.status}`, {
          durationMs: rec.durationMs,
          value: rec.value,
          reason: rec.reason ?? rec.skipReason,
          ...(rec.status === "failed" ? { expected: rec.expected, actual: rec.actual, error: rec.error, hint: rec.hint } : {}),
          origin: "result",
        });
      }
    }
  }

  /** A one-line suggestion for the author, from the shape of the failure (F10/F11 in the plan). */
  private deriveHint(rec: StepRecord): void {
    if (rec.hint || rec.soft) return;
    const actual = rec.actual as { set?: unknown } | undefined;
    if (
      (rec.name === "player.attribute" || rec.name === "instance.attribute") &&
      rec.target === "server" &&
      actual &&
      typeof actual === "object" &&
      actual.set === false
    ) {
      rec.hint = "the attribute is not set on the server; if the game sets it on the client, add `on: client` to this step";
      return;
    }
    if (rec.verb === "expect" && rec.withinMs == null && rec.error?.code === "ASSERTION_FAILED") {
      rec.hint = "expect asserts instantly; if the state is set asynchronously (deferred handlers, replication) add `within: 2s` to poll, or use wait:";
    }
  }

  private async runDaemonStep(n: DaemonNode, signal: AbortSignal): Promise<Outcome> {
    const s = n.step;
    const rec = this.records.get(s.id)!;
    if (n.ifVar && !isTruthy(this.vars[n.ifVar])) {
      this.skipStep(s.id, "if");
      return "passed";
    }
    if (signal.aborted) {
      this.skipStep(s.id, "aborted");
      return "cancelled";
    }
    rec.status = "running";
    rec.startedAt = Date.now();
    this.lastStarted = rec.id;
    this.stepEvent(rec, "step.started", { origin: "daemon" });
    await sleep(this.deps.settleMs ?? 150);
    const params = substituteVars(s.params, this.vars) as Record<string, unknown>;
    const windowMs = s.verb === "wait" ? s.timeoutMs : (s.withinMs ?? 0);
    const deadline = Date.now() + windowMs;
    let r = evaluateLogCondition(s.name!, params, this.logs);
    while (!r.ok && Date.now() < deadline && !signal.aborted) {
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      r = evaluateLogCondition(s.name!, params, this.logs);
    }
    rec.durationMs = Date.now() - rec.startedAt;
    if ((rec.status as string) === "failed") return rec.soft ? "passed" : "failed";
    if (r.ok) {
      rec.status = "passed";
      this.stepEvent(rec, "step.passed", { durationMs: rec.durationMs, origin: "daemon" });
      return "passed";
    }
    if (signal.aborted) {
      this.skipStep(s.id, "aborted");
      return "cancelled";
    }
    rec.reason = s.verb === "wait" ? `${s.name} not true within ${formatDuration(windowMs)}: ${r.reason}` : `${s.name}: ${r.reason}`;
    rec.expected = r.expected;
    rec.actual = r.actual;
    rec.error = { code: s.verb === "wait" ? "TIMEOUT" : "ASSERTION_FAILED", message: rec.reason, stepId: s.id };
    this.setFailed(rec);
    this.stepEvent(rec, "step.failed", {
      durationMs: rec.durationMs,
      reason: rec.reason,
      expected: rec.expected,
      actual: rec.actual,
      error: rec.error,
      origin: "daemon",
    });
    return rec.soft ? "passed" : "failed";
  }

  private async runParallel(n: ParallelNode, signal: AbortSignal): Promise<Outcome> {
    if (n.ifVar && !isTruthy(this.vars[n.ifVar])) {
      for (const b of n.branches) this.skipNodes(b, "if");
      return "passed";
    }
    if (signal.aborted) {
      for (const b of n.branches) this.skipNodes(b, "aborted");
      return "cancelled";
    }
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.emit("parallel.started", { stepId: n.stepId, branches: n.branches.length });
    const outcomes = await Promise.all(
      n.branches.map(async (b) => {
        const o = await this.runList(b, ctrl.signal);
        if (o === "failed") ctrl.abort();
        return o;
      }),
    );
    signal.removeEventListener("abort", onAbort);
    this.emit("parallel.finished", { stepId: n.stepId, outcomes });
    if (outcomes.includes("failed")) return n.soft ? "passed" : "failed";
    if (outcomes.includes("cancelled")) return "cancelled";
    return "passed";
  }

  // ---- finish ---------------------------------------------------------------

  private buildFailure(status: RunStatus): FailureInfo | null {
    const firstId = this.failureOrder[0];
    if (firstId) {
      const rec = this.records.get(firstId)!;
      const from = (rec.startedAt ?? this.t0) - this.t0 - 2_000;
      const to = (rec.startedAt ?? this.t0) - this.t0 + (rec.durationMs ?? 0) + 1_000;
      const logsAround = this.logs.filter((l) => l.stepId === rec.id || (l.t >= from && l.t <= to)).slice(-30);
      return {
        step: rec.id,
        display: rec.display,
        phase: rec.phase,
        reason: rec.reason ?? (rec.error?.message || "step failed (the node sent no reason)"),
        expected: rec.expected,
        actual: rec.actual,
        error: rec.error,
        hint: rec.hint,
        node: rec.nodeId,
        logsAround,
      };
    }
    if (this.infraError || status === "error") {
      const e = this.infraError ?? new StagehandError("BAD_REQUEST", this.errors.map((d) => `${d.path}: ${d.message}`).join("; ") || "invalid spec");
      return { step: null, display: null, phase: null, reason: e.message, error: e.toObject(), node: null, logsAround: this.logs.slice(-20) };
    }
    if (status === "cancelled") return { step: null, display: null, phase: null, reason: "run cancelled", node: null, logsAround: [] };
    return null;
  }

  /** What the report would say right now: terminal steps with reasons/values, pending ones as pending. */
  partialResult(): PartialRunResult {
    if (this.result) return this.result;
    const steps = [...this.records.values()];
    const counts = { passed: 0, failed: 0, skipped: 0, cancelled: 0, pending: 0 };
    for (const s of steps) counts[(s.status === "running" ? "pending" : s.status) as keyof typeof counts]++;
    const logCounts = { info: 0, warn: 0, error: 0 };
    for (const l of this.logs) logCounts[l.level]++;
    return {
      runId: this.id,
      name: this.name,
      status: this.status,
      startedAt: this.startedAt.toISOString(),
      finishedAt: null,
      durationMs: Date.now() - this.startedAt.getTime(),
      dir: this.dir,
      session: this.sessionInfo(),
      counts,
      failure: this.failureOrder.length ? this.buildFailure("failed") : null,
      softFailures: [...this.softFailures],
      steps,
      vars: this.vars,
      errors: this.errors,
      warnings: this.warnings,
      logCounts,
    };
  }

  private sessionInfo(): RunResult["session"] {
    return this.handle
      ? { sessionId: this.handle.sessionId, mode: this.handle.mode, players: this.handle.players, reused: this.handle.reused }
      : this.plan
        ? { sessionId: null, mode: this.plan.session.mode, players: this.plan.session.players, reused: false }
        : null;
  }

  private async finish(status: Exclude<RunStatus, "queued" | "running">): Promise<void> {
    this.phaseActive = false;
    if (this.handle && this.plan) {
      try {
        await this.deps.sessions.release(this.handle, this.plan.session.reuse, status === "passed" ? "passed" : "failed");
      } catch (e) {
        this.deps.log?.(`session release failed: ${(e as Error).message}`);
      }
    }
    const finishedAt = new Date();
    const steps = [...this.records.values()];
    const counts = { passed: 0, failed: 0, skipped: 0, cancelled: 0, pending: 0 };
    for (const s of steps) {
      if (s.status === "running") s.status = "cancelled";
      counts[s.status as keyof typeof counts]++;
    }
    const logCounts = { info: 0, warn: 0, error: 0 };
    for (const l of this.logs) logCounts[l.level]++;
    const result: RunResult = {
      runId: this.id,
      name: this.name,
      status,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      dir: this.dir,
      session: this.sessionInfo(),
      counts,
      failure: status === "passed" ? null : this.buildFailure(status),
      softFailures: [...this.softFailures],
      steps,
      vars: this.vars,
      errors: this.errors,
      warnings: this.warnings,
      logCounts,
    };
    this.status = status;
    this.result = result;
    this.emit("run.finished", { runId: this.id, status, counts, failure: result.failure ? { step: result.failure.step, reason: result.failure.reason } : null });
    try {
      await this.reporter.finish(result);
    } catch (e) {
      this.deps.log?.(`failed to write report: ${(e as Error).message}`);
    }
    this.resolveDone(result);
  }
}

function stepBudget(s: PlanStep): number {
  return Math.max(s.timeoutMs, s.withinMs ?? 0);
}
