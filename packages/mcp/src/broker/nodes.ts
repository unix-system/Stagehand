// Node registry, per-node command queues and result correlation (docs/protocol.md).
import {
  type AttachRequest,
  type AttachResponse,
  BROKER_VERSION,
  type Command,
  type CommandType,
  EVENT_FLUSH_MS,
  NODE_EXPIRY_MS,
  type NodeEvent,
  POLL_TIMEOUT_MS,
  type ResultRequest,
  type Role,
  type SessionPlayer,
  StagehandError,
} from "./protocol.js";

export interface NodeInfo {
  nodeId: string;
  role: Role;
  placeId: number;
  placeName: string;
  sessionId: string | null;
  playerName: string | null;
  userId: number | null;
  playerIndex: number | null;
  pluginVersion: string;
  transport: "http" | "remote";
  orphan: boolean;
  attachedAt: number;
  lastSeen: number;
  catalogHash: string | null;
}

interface PendingCommand {
  command: Command;
  timeoutMs: number;
  resolve: (v: unknown) => void;
  reject: (e: StagehandError) => void;
  timer: NodeJS.Timeout | null;
  cleanup: () => void;
}

interface Waiter {
  /** Returns false when the poll connection is already gone. */
  deliver: (cmd: Command | null) => boolean;
  timer: NodeJS.Timeout;
}

interface NodeRecord {
  info: NodeInfo;
  queue: PendingCommand[];
  inflight: Map<string, PendingCommand>;
  waiter: Waiter | null;
  lastSeq: number;
}

export type RegistryEvent =
  | { kind: "attached"; node: NodeInfo; replaced: string | null }
  | { kind: "detached"; node: NodeInfo; reason: string }
  | { kind: "event"; node: NodeInfo; event: NodeEvent }
  | { kind: "renumbered"; sessionId: string; players: SessionPlayer[] };

export interface SendOptions {
  /** Daemon-side timeout measured from delivery to the node. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * When true, `signal` only withdraws a command that has not been delivered yet; once delivered the
   * caller is responsible for cancelling it on the node (e.g. with a `cancel` command).
   */
  abortQueuedOnly?: boolean;
}

export interface RegistryOptions {
  pollTimeoutMs?: number;
  expiryMs?: number;
  eventFlushMs?: number;
  /** How often expiry is checked (ms). */
  sweepMs?: number;
}

/** Commands that are not serialized per type (processed while a run_segment is in flight). */
const CONCURRENT_TYPES = new Set<CommandType>(["cancel", "ping"]);

export class NodeRegistry {
  readonly pollTimeoutMs: number;
  readonly expiryMs: number;
  readonly eventFlushMs: number;
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly listeners = new Set<(e: RegistryEvent) => void>();
  private readonly sessionPlayers = new Map<string, SessionPlayer[]>();
  private readonly endedSessions = new Set<string>();
  private nodeCounter = 0;
  private commandCounter = 0;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(opts: RegistryOptions = {}) {
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    this.expiryMs = opts.expiryMs ?? NODE_EXPIRY_MS;
    this.eventFlushMs = opts.eventFlushMs ?? EVENT_FLUSH_MS;
    const sweepMs = opts.sweepMs ?? Math.min(5_000, Math.max(50, Math.floor(this.expiryMs / 4)));
    this.sweeper = setInterval(() => this.sweep(), sweepMs);
    this.sweeper.unref();
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const id of [...this.nodes.keys()]) this.detach(id, "broker shutting down");
  }

  on(listener: (e: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: RegistryEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        process.stderr.write(`[stagehand] listener error: ${String(err)}\n`);
      }
    }
  }

  // ---- queries -------------------------------------------------------------

  list(): NodeInfo[] {
    return [...this.nodes.values()].map((r) => ({ ...r.info }));
  }

  get(nodeId: string): NodeInfo | undefined {
    const r = this.nodes.get(nodeId);
    return r ? { ...r.info } : undefined;
  }

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  findEdit(placeId?: number | null): NodeInfo | undefined {
    const edits = this.list().filter((n) => n.role === "edit");
    if (placeId != null) {
      const m = edits.find((n) => n.placeId === placeId);
      if (m) return m;
    }
    return edits.sort((a, b) => b.lastSeen - a.lastSeen)[0];
  }

  findServer(sessionId: string): NodeInfo | undefined {
    return this.list().find((n) => n.role === "server" && n.sessionId === sessionId && !n.orphan);
  }

  findClient(sessionId: string, playerIndex: number): NodeInfo | undefined {
    return this.list().find(
      (n) => n.role === "client" && n.sessionId === sessionId && n.playerIndex === playerIndex && !n.orphan,
    );
  }

  clients(sessionId: string): NodeInfo[] {
    return this.list()
      .filter((n) => n.role === "client" && n.sessionId === sessionId && !n.orphan)
      .sort((a, b) => (a.playerIndex ?? 99) - (b.playerIndex ?? 99));
  }

  sessionNodes(sessionId: string): NodeInfo[] {
    return this.list().filter((n) => n.sessionId === sessionId);
  }

  getSessionPlayers(sessionId: string): SessionPlayer[] | undefined {
    return this.sessionPlayers.get(sessionId);
  }

  /** Mark a session ended: its nodes become orphans and are no longer dispatched to. */
  markSessionEnded(sessionId: string): void {
    this.endedSessions.add(sessionId);
    this.sessionPlayers.delete(sessionId);
    for (const r of this.nodes.values()) {
      if (r.info.sessionId === sessionId) r.info.orphan = true;
    }
  }

  /** Drop every node of a session (e.g. after end_session). */
  dropSession(sessionId: string, reason: string): void {
    for (const r of [...this.nodes.values()]) {
      if (r.info.sessionId === sessionId) this.detach(r.info.nodeId, reason);
    }
  }

  // ---- attach --------------------------------------------------------------

  attach(req: AttachRequest): AttachResponse {
    const now = Date.now();
    // Re-attach key: {role, sessionId, userId} or {role:"edit", placeId}.
    const prev = [...this.nodes.values()].find((r) => {
      const i = r.info;
      if (i.role !== req.role) return false;
      if (req.role === "edit") return i.placeId === req.placeId;
      return i.sessionId === req.sessionId && i.userId === req.userId;
    });
    let playerIndex: number | null = null;
    let replaced: string | null = null;
    if (prev) {
      playerIndex = prev.info.playerIndex;
      replaced = prev.info.nodeId;
      this.detach(prev.info.nodeId, "replaced by re-attach", "CANCELLED");
    }
    // A node that reports a session the daemon already ended (e.g. a stale re-attach after 410)
    // is a plain orphan: it keeps no session id, so it is never counted among that session's nodes.
    const sessionEnded = req.sessionId != null && this.endedSessions.has(req.sessionId);
    const orphan = req.role !== "edit" && (req.sessionId == null || sessionEnded);
    if (req.role === "client" && !orphan && req.sessionId) {
      const players = this.sessionPlayers.get(req.sessionId);
      const fromReady = players ? matchPlayer(players, req.userId, req.playerName) : -1;
      if (fromReady >= 0) playerIndex = fromReady + 1;
      else if (playerIndex == null) playerIndex = this.nextFreeIndex(req.sessionId);
    }
    const nodeId = `n_${++this.nodeCounter}`;
    const info: NodeInfo = {
      nodeId,
      role: req.role,
      placeId: req.placeId,
      placeName: req.placeName,
      sessionId: req.role === "edit" || sessionEnded ? null : req.sessionId,
      playerName: req.playerName,
      userId: req.userId,
      playerIndex: req.role === "client" ? playerIndex : null,
      pluginVersion: req.pluginVersion,
      transport: req.transport,
      orphan,
      attachedAt: now,
      lastSeen: now,
      catalogHash: null,
    };
    this.nodes.set(nodeId, { info, queue: [], inflight: new Map(), waiter: null, lastSeq: 0 });
    this.emit({ kind: "attached", node: { ...info }, replaced });
    return {
      nodeId,
      playerIndex: info.playerIndex,
      pollTimeoutMs: this.pollTimeoutMs,
      eventFlushMs: this.eventFlushMs,
      brokerVersion: BROKER_VERSION,
    };
  }

  private nextFreeIndex(sessionId: string): number {
    const used = new Set(
      [...this.nodes.values()]
        .filter((r) => r.info.role === "client" && r.info.sessionId === sessionId)
        .map((r) => r.info.playerIndex),
    );
    let i = 1;
    while (used.has(i)) i++;
    return i;
  }

  private detach(nodeId: string, reason: string, code = "SESSION_ERROR"): void {
    const r = this.nodes.get(nodeId);
    if (!r) return;
    this.nodes.delete(nodeId);
    if (r.waiter) {
      clearTimeout(r.waiter.timer);
      r.waiter.deliver(null);
      r.waiter = null;
    }
    const err = new StagehandError(code, `node ${nodeId} (${r.info.role}) ${reason}`);
    for (const p of [...r.queue, ...r.inflight.values()]) {
      p.cleanup();
      p.reject(err);
    }
    r.queue = [];
    r.inflight.clear();
    this.emit({ kind: "detached", node: { ...r.info }, reason });
  }

  private sweep(): void {
    const now = Date.now();
    for (const r of [...this.nodes.values()]) {
      if (r.waiter) continue; // currently long-polling = alive
      if (now - r.info.lastSeen > this.expiryMs) this.detach(r.info.nodeId, "expired (no poll)");
    }
  }

  private touch(nodeId: string): NodeRecord {
    const r = this.nodes.get(nodeId);
    if (!r) throw new StagehandError("UNKNOWN_NODE", `unknown node ${nodeId}; re-attach`);
    r.info.lastSeen = Date.now();
    return r;
  }

  // ---- poll ----------------------------------------------------------------

  /**
   * Register a long-poll. `deliver` is called exactly once with a command or null (timeout).
   * Throws UNKNOWN_NODE for an unknown node. Returns a cancel function for a closed connection.
   */
  poll(nodeId: string, deliver: (cmd: Command | null) => boolean): () => void {
    const r = this.touch(nodeId);
    if (r.waiter) {
      // A newer poll supersedes the old one.
      clearTimeout(r.waiter.timer);
      r.waiter.deliver(null);
      r.waiter = null;
    }
    const waiter: Waiter = {
      deliver,
      timer: setTimeout(() => {
        if (r.waiter === waiter) r.waiter = null;
        r.info.lastSeen = Date.now();
        deliver(null);
      }, this.pollTimeoutMs),
    };
    r.waiter = waiter;
    this.pump(r);
    return () => {
      if (r.waiter === waiter) {
        clearTimeout(waiter.timer);
        r.waiter = null;
        r.info.lastSeen = Date.now();
      }
    };
  }

  private pump(r: NodeRecord): void {
    if (!r.waiter) return;
    const busy = new Set<CommandType>([...r.inflight.values()].map((p) => p.command.type));
    const idx = r.queue.findIndex((p) => CONCURRENT_TYPES.has(p.command.type) || !busy.has(p.command.type));
    if (idx < 0) return;
    const p = r.queue[idx]!;
    const waiter = r.waiter;
    clearTimeout(waiter.timer);
    r.waiter = null;
    if (!waiter.deliver(p.command)) return; // connection gone; keep command queued
    r.queue.splice(idx, 1);
    r.inflight.set(p.command.id, p);
    if (p.timeoutMs > 0 && Number.isFinite(p.timeoutMs)) {
      p.timer = setTimeout(() => {
        if (!r.inflight.delete(p.command.id)) return;
        p.cleanup();
        p.reject(
          new StagehandError(
            "TIMEOUT",
            `${p.command.type} ${p.command.id} on ${r.info.nodeId} got no result within ${p.timeoutMs}ms`,
          ),
        );
        this.pump(r);
      }, p.timeoutMs);
    }
  }

  // ---- send / result -------------------------------------------------------

  send(nodeId: string, type: CommandType, params: unknown, opts: SendOptions = {}): Promise<unknown> {
    const r = this.nodes.get(nodeId);
    if (!r) return Promise.reject(new StagehandError("UNKNOWN_NODE", `node ${nodeId} is not attached`));
    if (opts.signal?.aborted) return Promise.reject(new StagehandError("CANCELLED", `${type} aborted`));
    const id = `c_${++this.commandCounter}`;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        const qi = r.queue.indexOf(p);
        if (qi < 0 && opts.abortQueuedOnly) return;
        if (qi >= 0) r.queue.splice(qi, 1);
        r.inflight.delete(id);
        p.cleanup();
        reject(new StagehandError("CANCELLED", `${type} ${id} aborted by daemon`));
        this.pump(r);
      };
      const p: PendingCommand = {
        command: { id, type, params },
        timeoutMs: opts.timeoutMs ?? 0,
        resolve,
        reject,
        timer: null,
        cleanup: () => {
          if (p.timer) clearTimeout(p.timer);
          p.timer = null;
          opts.signal?.removeEventListener("abort", onAbort);
        },
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      r.queue.push(p);
      this.pump(r);
    });
  }

  result(req: ResultRequest): void {
    const r = this.touch(req.node);
    const p = r.inflight.get(req.commandId);
    if (!p) throw new StagehandError("BAD_REQUEST", `unknown commandId ${req.commandId}`, { httpStatus: 404 });
    r.inflight.delete(req.commandId);
    p.cleanup();
    if (req.ok) p.resolve(req.result ?? null);
    else
      p.reject(
        StagehandError.from(req.error ?? { code: "INTERNAL", message: `${p.command.type} failed without error` }),
      );
    this.pump(r);
  }

  // ---- events --------------------------------------------------------------

  events(nodeId: string, events: NodeEvent[]): number {
    const r = this.touch(nodeId);
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    for (const ev of sorted) {
      if (ev.seq <= r.lastSeq) continue;
      r.lastSeq = ev.seq;
      if (ev.type === "node.ready" && typeof ev.catalogHash === "string") r.info.catalogHash = ev.catalogHash;
      if (ev.type === "session.ready") this.onSessionReady(r, ev);
      this.emit({ kind: "event", node: { ...r.info }, event: ev });
    }
    return r.lastSeq;
  }

  private onSessionReady(r: NodeRecord, ev: NodeEvent): void {
    const sessionId = (typeof ev.sessionId === "string" ? ev.sessionId : null) ?? r.info.sessionId;
    if (!sessionId || r.info.role !== "server" || r.info.orphan) return;
    const players: SessionPlayer[] = Array.isArray(ev.players)
      ? (ev.players as unknown[]).flatMap((p) => {
          if (!p || typeof p !== "object") return [];
          const o = p as Record<string, unknown>;
          return [{ name: String(o.name ?? ""), userId: Number(o.userId ?? 0) }];
        })
      : [];
    this.sessionPlayers.set(sessionId, players);
    this.renumber(sessionId, players);
    this.emit({ kind: "renumbered", sessionId, players });
  }

  /** Server-confirmed renumbering: playerIndex = i  <=>  players[i-1] (match by userId, then name). */
  private renumber(sessionId: string, players: SessionPlayer[]): void {
    const clients = [...this.nodes.values()].filter(
      (x) => x.info.role === "client" && x.info.sessionId === sessionId,
    );
    const taken = new Set<number>();
    const unmatched: NodeRecord[] = [];
    for (const c of clients) {
      const i = matchPlayer(players, c.info.userId, c.info.playerName, taken);
      if (i >= 0) {
        c.info.playerIndex = i + 1;
        taken.add(i);
      } else unmatched.push(c);
    }
    let next = players.length;
    for (const c of unmatched) c.info.playerIndex = ++next;
  }
}

function matchPlayer(
  players: SessionPlayer[],
  userId: number | null,
  name: string | null,
  taken: Set<number> = new Set(),
): number {
  if (userId != null) {
    const i = players.findIndex((p, k) => !taken.has(k) && p.userId === userId);
    if (i >= 0) return i;
  }
  if (name != null) {
    const i = players.findIndex((p, k) => !taken.has(k) && p.name === name);
    if (i >= 0) return i;
  }
  return -1;
}
