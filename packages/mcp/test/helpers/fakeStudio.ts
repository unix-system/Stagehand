// A simulated Roblox Studio: an edit node that launches fake server/client nodes per session.
import { CommandError, FakeNode } from "./fakeNode.js";

export interface StepCtx {
  role: "edit" | "server" | "client";
  playerIndex: number | null;
  sessionId: string | null;
  vars: Record<string, unknown>;
  studio: FakeStudio;
}

export interface StepOutcome {
  status: "passed" | "failed";
  value?: unknown;
  reason?: string;
  expected?: unknown;
  actual?: unknown;
  code?: string;
  delayMs?: number;
  logs?: Array<{ level: "info" | "warn" | "error"; message: string }>;
}

export type StepImpl = (step: any, ctx: StepCtx) => StepOutcome | Promise<StepOutcome>;

export interface FakeStudioOptions {
  impl: StepImpl;
  gameEntries?: unknown[];
  /** Attach clients in reverse order to exercise server-confirmed renumbering. */
  reverseClientAttach?: boolean;
  /** Server never emits session.ready. */
  noSessionReady?: boolean;
  /** Server fails end_session (forces the edit-node fallback). */
  serverEndFails?: boolean;
  /** Launch fails on the edit node. */
  launchFails?: boolean;
}

function substitute(v: unknown, vars: Record<string, unknown>): unknown {
  if (typeof v === "string" && /^\$[A-Za-z_]\w*$/.test(v)) return v.slice(1) in vars ? vars[v.slice(1)] : v;
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, vars)]));
  return v;
}

export class FakeStudio {
  edit: FakeNode;
  sessionNodes: FakeNode[] = [];
  readonly launches: any[] = [];
  readonly ends: Array<{ role: string; params: any }> = [];
  /** `progress` snapshots received by the edit node. */
  readonly progress: any[] = [];
  /** `progress` snapshots received by client nodes. */
  readonly clientProgress: Array<{ playerIndex: number | null; snapshot: any }> = [];
  readonly segments: Array<{ role: string; playerIndex: number | null; params: any }> = [];
  world: Record<string, any> = {};

  constructor(readonly base: string, readonly opts: FakeStudioOptions) {
    this.edit = new FakeNode(base, {
      role: "edit",
      handlers: {
        launch_session: (p) => {
          if (opts.launchFails) throw new CommandError("SESSION_ERROR", "Studio refused to start");
          this.launches.push(p);
          setTimeout(() => void this.spawnSession(p.sessionId, p.players), 20);
          return { accepted: true };
        },
        end_session: async (p) => {
          this.ends.push({ role: "edit", params: p });
          await this.killSession();
          return { ended: true, via: "RunService.Stop" };
        },
        run_segment: (p, n) => this.runSegment(p, n, "edit", null, null),
        progress: (p) => (this.progress.push(p), {}),
      },
    });
  }

  async start(): Promise<void> {
    await this.edit.attach();
    this.edit.start();
  }

  async stop(): Promise<void> {
    await this.killSession();
    await this.edit.stop();
  }

  private makeNode(role: "server" | "client", sessionId: string, i: number): FakeNode {
    const node: FakeNode = new FakeNode(this.base, {
      role,
      sessionId,
      playerName: role === "client" ? `Player${i}` : null,
      userId: role === "client" ? -i : null,
      handlers: {
        catalog: () => ({ entries: role === "server" ? (this.opts.gameEntries ?? []) : [] }),
        progress: (p) => (this.clientProgress.push({ playerIndex: node.playerIndex, snapshot: p }), {}),
        run_segment: (p, n) => this.runSegment(p, n, role, role === "client" ? n.playerIndex : null, sessionId),
        end_session: async (p) => {
          this.ends.push({ role, params: p });
          if (this.opts.serverEndFails) throw new CommandError("SESSION_ERROR", "EndTest failed");
          setTimeout(() => void this.killSession(), 5);
          return { ended: true, via: "EndTest" };
        },
      },
    });
    return node;
  }

  private async spawnSession(sessionId: string, players: number): Promise<void> {
    const server = this.makeNode("server", sessionId, 0);
    await server.attach();
    server.start();
    this.sessionNodes.push(server);
    await server.events([{ type: "node.ready", role: "server", catalogHash: "abc" }]);
    const order = Array.from({ length: players }, (_, k) => k + 1);
    if (this.opts.reverseClientAttach) order.reverse();
    for (const i of order) {
      const c = this.makeNode("client", sessionId, i);
      await c.attach();
      c.start();
      this.sessionNodes.push(c);
      await c.events([{ type: "node.ready", role: "client", catalogHash: "abc" }]);
    }
    if (!this.opts.noSessionReady) {
      await server.events([
        {
          type: "session.ready",
          sessionId,
          players: Array.from({ length: players }, (_, k) => ({ name: `Player${k + 1}`, userId: -(k + 1) })),
        },
      ]);
    }
  }

  async killSession(): Promise<void> {
    const nodes = this.sessionNodes;
    this.sessionNodes = [];
    await Promise.all(nodes.map((n) => n.stop()));
  }

  server(): FakeNode | undefined {
    return this.sessionNodes.find((n) => n.opts.role === "server");
  }

  client(playerIndex: number): FakeNode | undefined {
    return this.sessionNodes.find((n) => n.opts.role === "client" && n.playerIndex === playerIndex);
  }

  /** Emit a log event from the server node. */
  async serverLog(level: "info" | "warn" | "error", message: string, stepId: string | null = null): Promise<void> {
    const s = this.server();
    if (s) await s.events([{ type: "log", level, message, node: s.nodeId, stepId }]);
  }

  private async runSegment(p: any, node: FakeNode, role: StepCtx["role"], _pi: number | null, sessionId: string | null) {
    const playerIndex = role === "client" ? node.playerIndex : null;
    this.segments.push({ role, playerIndex, params: p });
    const vars: Record<string, unknown> = { ...(p.vars ?? {}) };
    await node.events([{ type: "segment.started", runId: p.runId, segmentId: p.segmentId }]);
    const results: any[] = [];
    let aborted = false;
    let cancelled = false;
    let failed = false;
    for (const raw of p.steps) {
      const base = { runId: p.runId, segmentId: p.segmentId, stepId: raw.id };
      if (aborted || cancelled) {
        results.push({ id: raw.id, status: "skipped", durationMs: 0 });
        await node.events([{ type: "step.skipped", ...base, reason: "aborted" }]);
        continue;
      }
      const step = { ...raw, params: substitute(raw.params, vars) };
      await node.events([{ type: "step.started", ...base }]);
      const t0 = Date.now();
      const out = await this.opts.impl(step, { role, playerIndex, sessionId, vars, studio: this });
      if (out.delayMs) {
        const end = Date.now() + out.delayMs;
        while (Date.now() < end) {
          if (node.cancelled.has(p.segmentId) || node.cancelled.has("all")) {
            cancelled = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      for (const l of out.logs ?? []) await node.events([{ type: "log", level: l.level, message: l.message, node: node.nodeId, stepId: raw.id }]);
      const durationMs = Date.now() - t0;
      if (cancelled) {
        results.push({ id: raw.id, status: "cancelled", durationMs });
        // Like the plugin: a cancelled step is reported as step.failed with code CANCELLED.
        await node.events([
          {
            type: "step.failed",
            ...base,
            durationMs,
            reason: "cancelled",
            expected: null,
            actual: null,
            error: { code: "CANCELLED", message: "cancelled" },
          },
        ]);
        continue;
      }
      if (out.status === "passed") {
        const r: any = { id: raw.id, status: "passed", durationMs };
        if (out.value !== undefined) r.value = out.value;
        if (raw.save && out.value !== undefined) vars[raw.save] = out.value;
        results.push(r);
        await node.events([{ type: "step.passed", ...base, durationMs, ...(out.value !== undefined ? { value: out.value } : {}) }]);
      } else {
        failed = true;
        results.push({ id: raw.id, status: "failed", durationMs });
        await node.events([
          {
            type: "step.failed",
            ...base,
            durationMs,
            reason: out.reason ?? "failed",
            expected: out.expected ?? null,
            actual: out.actual ?? null,
            error: { code: out.code ?? "ASSERTION_FAILED", message: out.reason ?? "failed" },
          },
        ]);
        if (!raw.soft) aborted = true;
      }
    }
    const status = cancelled ? "cancelled" : failed ? "failed" : "passed";
    await node.events([{ type: "segment.finished", runId: p.runId, segmentId: p.segmentId, status }]);
    return { segmentId: p.segmentId, status, steps: results, vars };
  }
}
