// Session manager: ensure a Studio test session for {mode, players}, reuse/reset, idle end, end_session.
import type { NodeInfo, NodeRegistry, RegistryEvent } from "../broker/nodes.js";
import { type RunSegmentResult, type SessionPlayer, StagehandError, type WireStep } from "../broker/protocol.js";
import type { NormalizedSession, SessionMode } from "./plan.js";

/**
 * Human-readable cause for a `session.ended` event the daemon did not ask for: the edit node reports what
 * Execute*Async returned (the EndTest argument, if the game or a tool ended the test) and how long the
 * test lived, so a run that dies mid-way can say more than "ended in Studio".
 */
export function describeSessionEnd(ev: Record<string, unknown>): string {
  const base = typeof ev.reason === "string" && ev.reason ? ev.reason : "ended in Studio";
  const parts: string[] = [];
  if (typeof ev.elapsedMs === "number") parts.push(`after ${Math.round(ev.elapsedMs / 1000)}s`);
  if (typeof ev.result === "string" && ev.result && ev.result !== "nil") parts.push(`Execute*Async returned ${JSON.stringify(ev.result)}`);
  const tail = parts.length ? ` (${parts.join("; ")})` : "";
  const who = ev.ok === false ? "" : ": the test was ended outside this daemon (Stop in Studio, EndTest from the game or another tool, or the test windows were closed)";
  return `${base}${tail}${who}`;
}

const secs = (ms: number): string => `${Number((ms / 1000).toFixed(1))}s`;

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
  /** How long an accepted launch may take to become ready (default 60000; multiplayer gets 1.5x). */
  launchTimeoutMs?: number;
  /**
   * How long an accepted launch may take for the test's server node to attach, i.e. for Studio to actually
   * start the test (default 30000; multiplayer gets 1.5x). Studio usually takes 3-6 s.
   */
  startTimeoutMs?: number;
  idleTimeoutMs?: number;
  endTimeoutMs?: number;
  resetTimeoutMs?: number;
  /** Wait after ending a stray Studio test before launching (default 1000). */
  strayEndSettleMs?: number;
  /** How long to wait for a stray test's session.ended before launching anyway (default 20000). */
  strayEndTimeoutMs?: number;
  /** How long end() waits for Studio to confirm the test ended (session.ended) before returning (default 20000). */
  sessionEndWaitMs?: number;
  log?: (msg: string) => void;
}

export interface EndResult {
  /** The test was ended (EndTest sent, or RunService.Stop for Run mode). */
  ended: boolean;
  via: string | null;
  sessionId: string | null;
  /** Studio confirmed the teardown (session.ended from the edit node) before this returned. */
  studioStopped: boolean;
  hint?: string;
}

/** What the shared Studio Launcher reports (launcher_status command). */
export interface LauncherStatus {
  current: { sessionId: string; mode: string; players: number; port: number; startedAt?: number } | null;
  last: { sessionId: string; ok: boolean; result?: string; endedAt?: number; elapsedMs?: number } | null;
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
  readonly startTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly endTimeoutMs: number;
  readonly resetTimeoutMs: number;
  readonly strayEndSettleMs: number;
  readonly strayEndTimeoutMs: number;
  readonly sessionEndWaitMs: number;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly opts: SessionManagerOptions,
  ) {
    this.launchTimeoutMs = opts.launchTimeoutMs ?? 60_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? Math.min(30_000, this.launchTimeoutMs);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    this.endTimeoutMs = opts.endTimeoutMs ?? 10_000;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.strayEndSettleMs = opts.strayEndSettleMs ?? 1_000;
    this.strayEndTimeoutMs = opts.strayEndTimeoutMs ?? 20_000;
    this.sessionEndWaitMs = opts.sessionEndWaitMs ?? 20_000;
    this.unsub = registry.on((e) => this.onRegistry(e));
  }

  /** The daemon's own broker port (names the owner of a Studio test in Launcher messages). */
  get port(): number {
    return this.opts.port;
  }

  /** Record the port the broker actually bound (it may differ from the requested one, e.g. 0 or a range). */
  setPort(port: number): void {
    this.opts.port = port;
  }

  /** Session ids this daemon launched and has since ended. */
  endedIds(): Set<string> {
    return new Set(this.ended.map((s) => s.sessionId));
  }

  /** Ask the edit node what the shared Launcher is running (null when no edit node / old plugin). */
  async launcherStatus(): Promise<LauncherStatus | null> {
    const edit = this.registry.findEdit();
    if (!edit) return null;
    try {
      const r = (await this.registry.send(edit.nodeId, "launcher_status", {}, { timeoutMs: 3_000 })) as LauncherStatus | null;
      return r && typeof r === "object" ? { current: r.current ?? null, last: r.last ?? null } : null;
    } catch {
      return null;
    }
  }

  /**
   * A test Studio is still running that this daemon launched (its port, or a session id we ended), but
   * that we no longer track: left behind by a failed launch, a detached server node or an edit-node
   * fallback that could not stop it.
   */
  async strayOwnTest(): Promise<LauncherStatus["current"] | null> {
    const st = await this.launcherStatus();
    const cur = st?.current;
    if (!cur) return null;
    if (this.session && this.session.sessionId === cur.sessionId && this.session.state !== "ended") return null;
    return cur.port === this.opts.port || this.endedIds().has(cur.sessionId) ? cur : null;
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
        const why = describeSessionEnd(e.event);
        this.log(`session ${s.sessionId} ended by the edit node: ${why}`);
        this.markEnded(s, why);
        // Rejects in-flight commands (run_segment) on the session's nodes with SESSION_ERROR.
        this.registry.dropSession(s.sessionId, `session ended (${why})`);
      }
    } else if (e.kind === "detached" && s && s.state === "ready") {
      if (e.node.role === "server" && e.node.sessionId === s.sessionId && !e.reason.startsWith("replaced by re-attach")) {
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
    let accepted = false;
    try {
      await this.endStrayTests(edit, o.signal);
      const params = { sessionId, mode, players: cfg.players };
      try {
        await this.registry.send(edit.nodeId, "launch_session", params, { timeoutMs: 25_000, signal: o.signal });
      } catch (e) {
        // Studio still tearing down a test of OURS (just stopped, or left behind): wait for the edit node
        // to report it ended, then try once more. Another daemon's test is refused as before.
        const m = /running test session (s_\w+) for the daemon on port (\d+)/.exec((e as Error).message ?? "");
        const ours = m && (Number(m[2]) === this.opts.port || this.endedIds().has(m[1]!));
        if (!ours || o.signal?.aborted) throw e;
        o.onProgress?.(`Studio is still ending our previous test ${m[1]}; waiting for it`);
        await this.waitSessionEnded(new Set([m[1]!]), this.sessionEndWaitMs).done;
        await this.registry.send(edit.nodeId, "launch_session", params, { timeoutMs: 25_000, signal: o.signal });
      }
      accepted = true;
      await this.waitReady(s, o, true);
    } catch (e) {
      const err = StagehandError.from(e);
      // Only tear down what Studio actually started. A refused launch (Studio busy with another
      // daemon's test) must not reach the edit node's end_session, which would stop that test in
      // Run mode and clear the Stagehand.Session settings the other daemon wrote. An accepted launch
      // is abandoned on the edit node, so a test Studio never started cannot block the next launch.
      if (accepted) await this.end(`launch failed: ${err.message}`, undefined, true).catch(() => {});
      else this.markEnded(s, `launch refused: ${err.message}`);
      throw err.code === "CANCELLED" ? err : new StagehandError("SESSION_ERROR", `session launch failed: ${err.message}`, err.toObject());
    }
    return { sessionId, mode, players: s.players, placeId: s.placeId, reused: false, record: s };
  }

  /**
   * A test left running in Studio (plugin reload, manual Play, crashed run) makes Execute*Async fail
   * with "a previous one is still in progress". Any server node of this place attached now belongs to
   * such a test: end it first.
   */
  private async endStrayTests(edit: NodeInfo, signal?: AbortSignal): Promise<void> {
    const strays = this.registry.list().filter((n) => n.role === "server" && n.placeId === edit.placeId);
    if (strays.length === 0) return;
    this.log(`ending ${strays.length} stray test(s) before launch: ${strays.map((n) => n.nodeId).join(", ")}`);
    const ids = new Set(strays.map((n) => n.sessionId).filter((s): s is string => typeof s === "string"));
    // EndTest from the test's own server node is the only thing that ends a Play/multiplayer test:
    // RunService:Stop() on the edit DataModel is a no-op for them (verified live). Studio takes several
    // seconds to tear the test down, so wait for the edit node's session.ended (bounded) before launching.
    const ended = this.waitSessionEnded(ids, this.strayEndTimeoutMs);
    await Promise.all(
      strays.map((n) =>
        this.registry
          .send(n.nodeId, "end_session", { sessionId: n.sessionId }, { timeoutMs: this.endTimeoutMs, signal })
          .catch((e) => this.log(`end_session on stray ${n.nodeId} failed: ${(e as Error).message}`)),
      ),
    );
    for (const n of strays) this.registry.drop(n.nodeId, "stray test ended before launch");
    await ended.done;
    await new Promise((r) => setTimeout(r, this.strayEndSettleMs));
  }

  /**
   * Wait for the edit node to report session.ended for one of `ids`. `done` resolves true when the event
   * arrived, false on timeout (or an empty set); `cancel()` stops waiting early (resolves false).
   */
  private waitSessionEnded(ids: Set<string>, timeoutMs: number): { done: Promise<boolean>; cancel: () => void } {
    if (ids.size === 0) return { done: Promise.resolve(false), cancel: () => {} };
    let finish: (seen: boolean) => void = () => {};
    const done = new Promise<boolean>((resolve) => {
      let off = () => {};
      const timer = setTimeout(() => finish(false), timeoutMs);
      finish = (seen) => {
        clearTimeout(timer);
        off();
        resolve(seen);
      };
      off = this.registry.on((e) => {
        if (e.kind === "event" && e.event.type === "session.ended" && ids.has(String(e.event.sessionId))) finish(true);
      });
    });
    return { done, cancel: () => finish(false) };
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

  /**
   * Wait for `s` to become ready, bounded by launchTimeoutMs. `fresh` (a launch this call just made) also
   * bounds the time until the server node attaches by startTimeoutMs: when Studio never starts the test
   * (paused in the background, a modal dialog, still tearing down the previous test) the launch fails
   * fast instead of waiting out the whole budget. Multiplayer gets 1.5x both.
   */
  private waitReady(s: SessionRecord, o: EnsureOptions, fresh = false): Promise<void> {
    const scale = s.mode === "multiplayer" ? 1.5 : 1;
    const readyMs = Math.round(this.launchTimeoutMs * scale);
    const startMs = Math.round(this.startTimeoutMs * scale);
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        for (const t of timers) clearTimeout(t);
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
      const started = () => this.registry.findServer(s.sessionId) != null;
      timers.push(
        setTimeout(() => {
          finish(
            new StagehandError(
              "SESSION_ERROR",
              `session ${s.sessionId} not ready after ${secs(readyMs)}: ${this.readyProblems(s).join("; ")}`,
            ),
          );
        }, readyMs),
      );
      if (fresh && startMs < readyMs) {
        const nudgeMs = Math.min(10_000, Math.round(startMs / 3));
        timers.push(
          setTimeout(() => {
            if (!started()) o.onProgress?.(`still waiting for Studio to start test ${s.sessionId} (is Studio paused in the background or showing a dialog?)`);
          }, nudgeMs),
          setTimeout(() => {
            if (started()) return;
            finish(
              new StagehandError(
                "SESSION_ERROR",
                `Studio did not start test session ${s.sessionId} within ${secs(startMs)} (no server node attached). ` +
                  "Studio may be paused in the background, showing a dialog, or still tearing down the previous test: bring Studio to the front and run again",
              ),
            );
          }, startMs),
        );
      }
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

  /**
   * End the current session: `end_session` on the server node (EndTest), the edit node as fallback
   * (RunService:Stop(), Run mode only). Waits (bounded by sessionEndWaitMs) for the edit node's
   * `session.ended` so that a launch right after this does not race Studio's teardown. `abandon` (a launch
   * that never became ready) also tells the edit node to forget the test, so that a test Studio never
   * started does not make the shared Launcher refuse every later launch.
   */
  async end(reason = "requested", result?: "passed" | "failed", abandon = false): Promise<EndResult> {
    this.clearIdle();
    const s = this.session;
    if (!s || s.state === "ended") return { ended: false, via: null, sessionId: null, studioStopped: false };
    s.state = "ending";
    // Subscribe before sending: a Run-mode test can end before the command result comes back.
    const confirm = this.waitSessionEnded(new Set([s.sessionId]), this.sessionEndWaitMs);
    let via: string | null = null;
    let hint: string | undefined;
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
          const editParams = abandon ? { ...params, abandon: true } : params;
          const r = (await this.registry.send(edit.nodeId, "end_session", editParams, { timeoutMs: this.endTimeoutMs })) as {
            ended?: boolean;
            via?: string;
            reason?: string;
          };
          via = r?.via ?? "RunService.Stop";
          if (r?.ended === false) {
            hint = r.reason ?? `the edit node cannot end a ${s.mode} test; stop it in Studio`;
            via = null;
          }
        } catch (e) {
          this.log(`end_session via edit failed: ${(e as Error).message}`);
        }
      }
    }
    let studioStopped = false;
    // An abandoned launch without a server node may never have started in Studio, so session.ended may
    // never come: do not hold the failing run for sessionEndWaitMs.
    if (via && !(abandon && !server)) studioStopped = await confirm.done;
    else confirm.cancel();
    if (!via && !hint) hint = `no node could end session ${s.sessionId} (server node gone, edit fallback failed); stop the test in Studio`;
    this.markEnded(s, reason);
    this.registry.dropSession(s.sessionId, "session ended");
    if (via && !studioStopped && !(abandon && !server)) this.log(`session ${s.sessionId}: Studio did not confirm the end within ${this.sessionEndWaitMs}ms`);
    return { ended: via !== null, via, sessionId: s.sessionId, studioStopped, ...(hint ? { hint } : {}) };
  }

  /**
   * Stop whatever test Studio is running even if this daemon did not launch it (another daemon's
   * session that re-attached here, or one started by hand). Ends our own session first, then sends
   * `end_session` (EndTest) to every other server node of the place; the edit node's RunService:Stop()
   * is the last resort and only works for Run mode. A test whose nodes talk to another live daemon
   * cannot be reached from here: stop it from that daemon or in Studio.
   */
  async stopStudio(reason = "stop_session force"): Promise<EndResult & { strays: number }> {
    const own = await this.end(reason);
    const edit = this.registry.findEdit();
    if (!edit) throw new StagehandError("SESSION_ERROR", "no Studio edit node attached");
    const strays = this.registry.list().filter((n) => n.role === "server" && n.placeId === edit.placeId);
    if (strays.length > 0) {
      await this.endStrayTests(edit);
      return { ended: true, via: "EndTest", sessionId: own.sessionId, studioStopped: true, strays: strays.length };
    }
    const r = (await this.registry.send(edit.nodeId, "end_session", {}, { timeoutMs: this.endTimeoutMs })) as { ended?: boolean; via?: string; reason?: string };
    const refused = r?.ended === false;
    return {
      ended: own.ended || (!refused && r != null),
      via: r?.via ?? "RunService.Stop",
      sessionId: own.sessionId,
      studioStopped: own.studioStopped,
      strays: 0,
      ...(refused ? { hint: r.reason } : {}),
    };
  }

  /**
   * stop_session without force: end our tracked session, or, when Studio still runs a test this daemon
   * launched but lost track of, end that one (via its server node when attached).
   */
  async stopOwn(reason = "stop_session"): Promise<EndResult & { strays?: number }> {
    const own = await this.end(reason);
    if (own.ended) return own;
    const stray = await this.strayOwnTest();
    if (!stray) return own;
    const edit = this.registry.findEdit();
    const servers = edit ? this.registry.list().filter((n) => n.role === "server" && n.placeId === edit.placeId) : [];
    if (edit && servers.length > 0) {
      await this.endStrayTests(edit);
      return { ended: true, via: "EndTest", sessionId: stray.sessionId, studioStopped: true, strays: servers.length };
    }
    return {
      ended: false,
      via: null,
      sessionId: stray.sessionId,
      studioStopped: false,
      hint: `Studio is still running our ${stray.mode} session ${stray.sessionId}, but no server node for it is attached, so it cannot be ended from here: press Stop in Studio (or wait for it to end), then start a new session`,
    };
  }
}
