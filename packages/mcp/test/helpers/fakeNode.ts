// A fake Stagehand plugin node speaking the real HTTP protocol to the broker.
export type Handler = (params: any, node: FakeNode, commandId: string) => unknown | Promise<unknown>;

export interface FakeNodeOptions {
  role: "edit" | "server" | "client";
  placeId?: number;
  placeName?: string;
  sessionId?: string | null;
  playerName?: string | null;
  userId?: number | null;
  protocolVersion?: number;
  instanceId?: string;
  handlers?: Record<string, Handler>;
  /** Do not post results automatically (tests drive /v1/result themselves). */
  manual?: boolean;
}

export class CommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class FakeNode {
  nodeId = "";
  playerIndex: number | null = null;
  seq = 0;
  readonly received: Array<{ id: string; type: string; params: any }> = [];
  readonly handlers: Record<string, Handler>;
  private running = false;
  private ctrl = new AbortController();
  private loop: Promise<void> | null = null;
  readonly cancelled = new Set<string>();
  private commandWaiters: Array<{ pred: (c: { type: string; params: any }) => boolean; resolve: (c: any) => void }> = [];

  constructor(readonly base: string, readonly opts: FakeNodeOptions) {
    this.handlers = {
      ping: () => ({ pong: true, t: 1 }),
      catalog: () => ({ entries: [] }),
      cancel: (p) => {
        this.cancelled.add(p.segmentId);
        return { cancelled: [p.segmentId] };
      },
      ...(opts.handlers ?? {}),
    };
  }

  attachBody(): Record<string, unknown> {
    const o = this.opts;
    return {
      protocolVersion: o.protocolVersion ?? 1,
      role: o.role,
      placeId: o.placeId ?? 1234,
      placeName: o.placeName ?? "Example Place",
      sessionId: o.sessionId ?? null,
      playerName: o.playerName ?? null,
      userId: o.userId ?? null,
      playerIndex: null,
      pluginVersion: "0.1.0",
      transport: "http",
      ...(o.instanceId ? { instanceId: o.instanceId } : {}),
    };
  }

  async post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }

  async attach(): Promise<any> {
    const r = await this.post("/v1/attach", this.attachBody());
    if (r.status !== 200) throw new Error(`attach failed ${r.status} ${JSON.stringify(r.body)}`);
    this.nodeId = r.body.nodeId;
    this.playerIndex = r.body.playerIndex;
    this.seq = 0;
    return r.body;
  }

  async poll(signal?: AbortSignal): Promise<{ status: number; command?: any }> {
    const r = await fetch(`${this.base}/v1/poll?node=${encodeURIComponent(this.nodeId)}`, { signal });
    if (r.status === 204) return { status: 204 };
    const body = (await r.json()) as any;
    return { status: r.status, command: body.command, ...body };
  }

  async events(events: Array<Record<string, unknown>>): Promise<{ status: number; body: any }> {
    const withSeq = events.map((e) => ({ seq: ++this.seq, t: Date.now() % 1e7, ...e }));
    return this.post("/v1/events", { node: this.nodeId, events: withSeq });
  }

  async result(commandId: string, ok: boolean, payload: unknown): Promise<{ status: number; body: any }> {
    return this.post("/v1/result", ok ? { node: this.nodeId, commandId, ok, result: payload } : { node: this.nodeId, commandId, ok, error: payload });
  }

  waitForCommand(pred: (c: { type: string; params: any }) => boolean = () => true, timeoutMs = 3000): Promise<any> {
    const hit = this.received.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for command")), timeoutMs);
      this.commandWaiters.push({ pred, resolve: (c) => (clearTimeout(t), resolve(c)) });
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.ctrl = new AbortController();
    this.loop = (async () => {
      while (this.running) {
        let r: { status: number; command?: any };
        try {
          r = await this.poll(this.ctrl.signal);
        } catch {
          if (!this.running) return;
          await new Promise((res) => setTimeout(res, 20));
          continue;
        }
        if (r.status === 410) {
          if (!this.running) return;
          await this.attach();
          continue;
        }
        if (r.status !== 200 || !r.command) continue;
        const cmd = r.command;
        this.received.push(cmd);
        this.commandWaiters = this.commandWaiters.filter((w) => {
          if (w.pred(cmd)) {
            w.resolve(cmd);
            return false;
          }
          return true;
        });
        if (this.opts.manual) continue;
        void this.dispatch(cmd);
      }
    })();
  }

  private async dispatch(cmd: { id: string; type: string; params: any }): Promise<void> {
    const h = this.handlers[cmd.type];
    try {
      if (!h) throw new CommandError("UNKNOWN_COMMAND", `unsupported ${cmd.type}`);
      const out = await h(cmd.params, this, cmd.id);
      if (out === NO_REPLY) return;
      await this.result(cmd.id, true, out);
    } catch (e) {
      const code = e instanceof CommandError ? e.code : "INTERNAL";
      await this.result(cmd.id, false, { code, message: (e as Error).message }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ctrl.abort();
    await this.loop?.catch(() => {});
  }
}

export const NO_REPLY = Symbol("no-reply");

export async function waitFor(pred: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
