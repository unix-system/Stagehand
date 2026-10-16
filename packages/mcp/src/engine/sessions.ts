// Session manager: ensure a Studio test session for {mode, players}, reuse/reset, idle end, end_session.
import type { NodeRegistry, RegistryEvent } from "../broker/nodes.js";
import { type RunSegmentResult, type SessionPlayer, StagehandError, type WireStep } from "../broker/protocol.js";
import type { NormalizedSession, SessionMode } from "./plan.js";

export type SessionState = "launching" | "ready" | "resetting" | "ending" | "ended";

export interface SessionRecord {
  sessionId: string;
  mode: Exclude<SessionMode, "edit">;
  players: number;
  state: SessionState;
  placeId: number | null;
  createdAt: number;
  readyAt: number | null;
  sessionPlayers: SessionPlayer[];
  /** Test names whose setup already ran in this session (setup runs once per reused session). */
  setupDone: Set<string>;
  adopted: boolean;
  endReason: string | null;
}

export interface SessionHandle {
  sessionId: string | null;
  mode: SessionMode;
  players: number;
  placeId: number | null;
  reused: boolean;
  record: SessionRecord | null;
}

export interface SessionManagerOptions {
  port: number;
  launchTimeoutMs?: number;
  idleTimeoutMs?: number;
  endTimeoutMs?: number;
  resetTimeoutMs?: number;
  /** Wait after ending a stray Studio test before launching (default 1000). */
  strayEndSettleMs?: number;
  log?: (msg: string) => void;
}

export interface EnsureOptions {
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export class SessionManager {
  private session: SessionRecord | null = null;
  private readonly ended: SessionRecord[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly unsub: () => void;
  private resetCounter = 0;
  readonly launchTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly endTimeoutMs: number;
  readonly resetTimeoutMs: number;
  readonly strayEndSettleMs: number;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly opts: SessionManagerOptions,
  ) {
    this.launchTimeoutMs = opts.launchTimeoutMs ?? 120_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    this.endTimeoutMs = opts.endTimeoutMs ?? 10_000;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.strayEndSettleMs = opts.strayEndSettleMs ?? 1_000;
    this.unsub = registry.on((e) => this.onRegistry(e));
  }

  close(): void {
    this.unsub();
    this.clearIdle();
  }

  current(): SessionRecord | null {
    return this.session;
  }

  /** Health / status view. */
  list(): Array<{ sessionId: string; mode: string; players: number; state: SessionState }> {
    const all = [...this.ended.slice(-5), ...(this.session ? [this.session] : [])];
    return all.map((s) => ({ sessionId: s.sessionId, mode: s.mode, players: s.players, state: s.state }));
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  private onRegistry(e: RegistryEvent): void {
    const s = this.session;
    if (e.kind === "renumbered") {
      if (s && s.sessionId === e.sessionId) {
        s.sessionPlayers = e.players;
      } else if (!s || s.state === "ended") {
        // Adopt a session launched before this daemon started (e.g. daemon restart).
        const players = e.players.length;
        const server = this.registry.findServer(e.sessionId);
        this.session = {
          sessionId: e.sessionId,
          mode: players === 0 ? "run" : players === 1 ? "play" : "multiplayer",
          players,
          state: "ready",
          placeId: server?.placeId ?? null,
          createdAt: Date.now(),
          readyAt: Date.now(),
          sessionPlayers: e.players,
          setupDone: new Set(),
          adopted: true,
          endReason: null,
        };
        this.log(`adopted running session ${e.sessionId} (${players} players)`);
        this.scheduleIdle();
      }
    } else if (e.kind === "event" && e.event.type === "session.ended") {
      // The edit node saw Execute*Async return (test stopped in Studio, EndTest, crash).
      const sid = typeof e.event.sessionId === "string" ? e.event.sessionId : null;
      if (s && sid === s.sessionId && s.state !== "ending" && s.state !== "ended") {
        this.clearIdle();
        const why = typeof e.event.reason === "string" && e.event.reason ? e.event.reason : "ended in Studio";
        this.log(`session ${s.sessionId} ended by the edit node: ${why}`);
        this.markEnded(s, why);
        // Rejects in-flight commands (run_segment) on the session's nodes with SESSION_ERROR.
        this.registry.dropSession(s.sessionId, `session ended (${why})`);
      }
    } else if (e.kind === "detached" && s && s.state === "ready") {
      if (e.node.role === "server" && e.node.sessionId === s.sessionId && e.reason !== "replaced by re-attach") {
        this.markEnded(s, `server node ${e.reason}`);
      }
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.session && this.session.state === "ready") {
        this.log(`ending idle session ${this.session.sessionId}`);
        void this.end("idle timeout").catch(() => {});
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private markEnded(s: SessionRecord, reason: string): void {
    s.state = "ended";
    s.endReason = reason;
    this.registry.markSessionEnded(s.sessionId);
    if (this.session === s) this.session = null;
    this.ended.push(s);
    if (this.ended.length > 20) this.ended.shift();
  }

  private isLive(s: SessionRecord): boolean {
    if (!this.registry.findServer(s.sessionId)) return false;
    for (let i = 1; i <= s.players; i++) if (!this.registry.findClient(s.sessionId, i)) return false;
    return true;
  }

  /** Ensure a session matching `cfg`; applies the reset policy when an existing session is reused. */
  async ensure(cfg: NormalizedSession, o: EnsureOptions = {}): Promise<SessionHandle> {
    this.clearIdle();
    if (cfg.mode === "edit") {
      const edit = this.registry.findEdit();
      if (!edit)
        throw new StagehandError("SESSION_ERROR", "no Studio edit node attached: open the place in Roblox Studio with the Stagehand plugin enabled");
      return { sessionId: null, mode: "edit", players: 0, placeId: edit.placeId, reused: false, record: null };
    }
    let s = this.session;
    if (s && s.state === "launching" && s.mode === cfg.mode && s.players === cfg.players) {
      await this.waitReady(s, o);
      s = this.session;
    }
    if (s && s.state === "ready" && cfg.reuse && s.mode === cfg.mode && s.players === cfg.players && this.isLive(s)) {
      o.onProgress?.(`reusing session ${s.sessionId} (reset: ${cfg.reset})`);
      try {
        await this.reset(s, cfg.reset, o.signal);
        return { sessionId: s.sessionId, mode: s.mode, players: s.players, placeId: s.placeId, reused: true, record: s };
      } catch (e) {
        if (o.signal?.aborted) throw e;
        o.onProgress?.(`reset failed (${(e as Error).message}); relaunching`);
      }
    }
    if (this.session && this.session.state !== "ended") await this.end("replaced by a session with a different config");
    return this.launch(cfg, o);
  }

  private async launch(cfg: NormalizedSession, o: EnsureOptions): Promise<SessionHandle> {
    const mode = cfg.mode as Exclude<SessionMode, "edit">;
    const edit = this.registry.findEdit();
    if (!edit)
      throw new StagehandError("SESSION_ERROR", "no Studio edit node attached: open the place in Roblox Studio with the Stagehand plugin enabled");
    const sessionId = `s_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const s: SessionRecord = {
      sessionId,
      mode,
      players: cfg.players,
      state: "launching",
      placeId: edit.placeId,
      createdAt: Date.now(),
      readyAt: null,
      sessionPlayers: [],
      setupDone: new Set(),
      adopted: false,
      endReason: null,
    };
    this.session = s;
    o.onProgress?.(`launching ${mode} session ${sessionId} with ${cfg.players} player(s)`);
    try {
      await this.endStrayTests(edit.placeId, o.signal);
      await this.registry.send(
        edit.nodeId,
        "launch_session",
        { sessionId, mode, players: cfg.players },
        { timeoutMs: 15_000, signal: o.signal },
      );
      await this.waitReady(s, o);
    } catch (e) {
      const err = StagehandError.from(e);
      await this.end(`launch failed: ${err.message}`).catch(() => {});
      throw err.code === "CANCELLED" ? err : new StagehandError("SESSION_ERROR", `session launch failed: ${err.message}`, err.toObject());
    }
    return { sessionId, mode, players: s.players, placeId: s.placeId, reused: false, record: s };
  }

  /**
   * A test left running in Studio (plugin reload, manual Play, crashed run) makes Execute*Async fail
   * with "a previous one is still in progress". Any server node of this place attached now belongs to
   * such a test: end it first.
   */
  private async endStrayTests(placeId: number, signal?: AbortSignal): Promise<void> {
    const strays = this.registry.list().filter((n) => n.role === "server" && n.placeId === placeId);
    if (strays.length === 0) return;
    this.log(`ending ${strays.length} stray test(s) before launch: ${strays.map((n) => n.nodeId).join(", ")}`);
    await Promise.all(
      strays.map(async (n) => {
        await this.registry
          .send(n.nodeId, "end_session", { sessionId: n.sessionId }, { timeoutMs: this.endTimeoutMs, signal })
          .catch(() => {});
        this.registry.drop(n.nodeId, "stray test ended before launch");
      }),
    );
    // ponytail: fixed settle delay for Studio's teardown; poll StudioTestService state if 1s proves flaky
    await new Promise((r) => setTimeout(r, this.strayEndSettleMs));
  }

  private readyProblems(s: SessionRecord): string[] {
    const problems: string[] = [];
    if (!this.registry.findServer(s.sessionId)) problems.push("server node not attached");
    const clients = this.registry.clients(s.sessionId);
    if (clients.length < s.players) problems.push(`${clients.length}/${s.players} client nodes attached`);
    if (!this.registry.getSessionPlayers(s.sessionId)) problems.push("no session.ready from the server yet");
    for (let i = 1; i <= s.players && problems.length === 0; i++)
      if (!this.registry.findClient(s.sessionId, i)) problems.push(`no client node for p${i}`);
    return problems;
  }

  private waitReady(s: SessionRecord, o: EnsureOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        o.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };
      const check = () => {
        if (s.state === "ended") return finish(new StagehandError("SESSION_ERROR", `session ${s.sessionId} ended: ${s.endReason ?? "unknown"}`));
        if (this.readyProblems(s).length === 0) {
          s.state = "ready";
          s.readyAt = Date.now();
          s.sessionPlayers = this.registry.getSessionPlayers(s.sessionId) ?? [];
          o.onProgress?.(`session ${s.sessionId} ready`);
          finish();
        }
      };
      const onAbort = () => finish(new StagehandError("CANCELLED", "cancelled while waiting for the session"));
      const timer = setTimeout(() => {
        finish(
          new StagehandError(
            "SESSION_ERROR",
            `session ${s.sessionId} not ready after ${Math.round(this.launchTimeoutMs / 1000)}s: ${this.readyProblems(s).join("; ")}`,
          ),
        );
      }, this.launchTimeoutMs);
      const unsub = this.registry.on(() => check());
      o.signal?.addEventListener("abort", onAbort, { once: true });
      if (o.signal?.aborted) return onAbort();
      check();
    });
  }

  /** Apply a reset policy to a reused session. */
  async reset(s: SessionRecord, policy: NormalizedSession["reset"], signal?: AbortSignal): Promise<void> {
    if (policy === "none") return;
    if (policy === "respawn" && s.players === 0) return;
    const server = this.registry.findServer(s.sessionId);
    if (!server) throw new StagehandError("SESSION_ERROR", "server node missing");
    s.state = "resetting";
    const n = ++this.resetCounter;
    const base = { params: {}, timeoutMs: 15_000, withinMs: null, soft: false, label: null, save: null };
    const steps: WireStep[] = [];
    const actors: Record<string, number> = {};
    for (let i = 1; i <= s.players; i++) actors[`p${i}`] = i;
    if (policy === "respawn") {
      for (let i = 1; i <= s.players; i++) {
        const actor = { name: `p${i}`, playerIndex: i };
        steps.push({ ...base, id: `reset.${n}.respawn.p${i}`, verb: "do", name: "player.respawn", actor });
        steps.push({ ...base, id: `reset.${n}.loaded.p${i}`, verb: "wait", name: "character.loaded", actor });
      }
    } else {
      steps.push({ ...base, id: `reset.${n}.hook`, verb: "do", name: "game.reset", actor: null });
    }
    try {
      const res = (await this.registry.send(
        server.nodeId,
        "run_segment",
        { runId: `reset_${s.sessionId}_${n}`, segmentId: `reset_${n}`, vars: {}, actors, steps },
        { timeoutMs: this.resetTimeoutMs, signal: signal },
      )) as RunSegmentResult;
      if (res?.status !== "passed") throw new StagehandError("SESSION_ERROR", `reset (${policy}) ${res?.status ?? "failed"}`);
    } finally {
      if (s.state === "resetting") s.state = "ready";
    }
  }

  /** Called by the runner after a run: end now (reuse=false) or arm the idle timer. */
  async release(handle: SessionHandle, reuse: boolean, result?: "passed" | "failed"): Promise<void> {
    if (!handle.record || handle.record !== this.session) return;
    if (!reuse) await this.end("reuse: false", result);
    else this.scheduleIdle();
  }

  /** End the current session (server end_session, edit-node fallback). */
  async end(reason = "requested", result?: "passed" | "failed"): Promise<{ ended: boolean; via: string | null; sessionId: string | null }> {
    this.clearIdle();
    const s = this.session;
    if (!s || s.state === "ended") return { ended: false, via: null, sessionId: null };
    s.state = "ending";
    let via: string | null = null;
    const params: Record<string, unknown> = { sessionId: s.sessionId };
    if (result) params.result = result;
    const server = this.registry.findServer(s.sessionId);
    if (server) {
      try {
        const r = (await this.registry.send(server.nodeId, "end_session", params, { timeoutMs: this.endTimeoutMs })) as { via?: string };
        via = r?.via ?? "EndTest";
      } catch (e) {
        this.log(`end_session via server failed: ${(e as Error).message}`);
      }
    }
    if (!via) {
      const edit = this.registry.findEdit(s.placeId);
      if (edit) {
        try {
          const r = (await this.registry.send(edit.nodeId, "end_session", params, { timeoutMs: this.endTimeoutMs })) as { via?: string };
          via = r?.via ?? "RunService.Stop";
        } catch (e) {
          this.log(`end_session via edit failed: ${(e as Error).message}`);
        }
      }
    }
    this.markEnded(s, reason);
    this.registry.dropSession(s.sessionId, "session ended");
    return { ended: true, via, sessionId: s.sessionId };
  }
}
