// HTTP broker (node:http, no framework) implementing docs/protocol.md endpoints.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { type NodeRegistry } from "./nodes.js";
import {
  attachRequestSchema,
  BROKER_VERSION,
  eventsRequestSchema,
  type NodeEvent,
  PROTOCOL_VERSION,
  resultRequestSchema,
  StagehandError,
} from "./protocol.js";

const MAX_BODY = 8 * 1024 * 1024;

export interface HealthExtras {
  sessions: unknown[];
  activeRun: unknown;
}

export interface BrokerServerOptions {
  registry: NodeRegistry;
  host?: string;
  port: number;
  health?: () => HealthExtras;
  log?: (msg: string) => void;
}

export class BrokerServer {
  private server: http.Server | null = null;
  private readonly startedAt = Date.now();
  readonly registry: NodeRegistry;
  private readonly opts: BrokerServerOptions;
  port: number;

  constructor(opts: BrokerServerOptions) {
    this.opts = opts;
    this.registry = opts.registry;
    this.port = opts.port;
  }

  async listen(): Promise<number> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        const e = StagehandError.from(err);
        sendJson(res, 500, { error: e.toObject() });
      });
    });
    server.keepAliveTimeout = 30_000;
    server.requestTimeout = 0; // long-polls
    server.headersTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  health(): Record<string, unknown> {
    const now = Date.now();
    const extras = this.opts.health?.() ?? { sessions: [], activeRun: null };
    return {
      ok: true,
      version: BROKER_VERSION,
      port: this.port,
      uptimeMs: now - this.startedAt,
      nodes: this.registry.list().map((n) => ({
        nodeId: n.nodeId,
        role: n.role,
        placeId: n.placeId,
        sessionId: n.sessionId,
        playerIndex: n.playerIndex,
        playerName: n.playerName,
        orphan: n.orphan,
        lastSeenMs: now - n.lastSeen,
      })),
      sessions: extras.sessions,
      activeRun: extras.activeRun,
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method ?? "GET"} ${url.pathname.replace(/\/+$/, "")}`;
    try {
      switch (route) {
        case "GET /v1/health":
          return sendJson(res, 200, this.health());
        case "POST /v1/attach": {
          const body = await readJson(req);
          const parsed = attachRequestSchema.safeParse(body);
          if (!parsed.success) throw badRequest(`invalid attach body: ${parsed.error.message}`);
          if (parsed.data.protocolVersion !== PROTOCOL_VERSION)
            throw badRequest(`protocolVersion ${parsed.data.protocolVersion} not supported (broker speaks ${PROTOCOL_VERSION})`);
          const out = this.registry.attach(parsed.data);
          this.opts.log?.(`attach ${out.nodeId} role=${parsed.data.role} session=${parsed.data.sessionId ?? "-"}`);
          return sendJson(res, 200, out);
        }
        case "GET /v1/poll": {
          const nodeId = url.searchParams.get("node");
          if (!nodeId) throw badRequest("missing ?node=");
          let done = false;
          const cancel = this.registry.poll(nodeId, (cmd) => {
            if (done) return false;
            if (res.destroyed || req.socket.destroyed) return false;
            done = true;
            if (cmd) sendJson(res, 200, { command: cmd });
            else {
              res.writeHead(204);
              res.end();
            }
            return true;
          });
          res.on("close", () => {
            if (!done) {
              done = true;
              cancel();
            }
          });
          return;
        }
        case "POST /v1/result": {
          const body = await readJson(req);
          const parsed = resultRequestSchema.safeParse(body);
          if (!parsed.success) throw badRequest(`invalid result body: ${parsed.error.message}`);
          this.registry.result(parsed.data);
          return sendJson(res, 200, { ok: true });
        }
        case "POST /v1/events": {
          const body = await readJson(req);
          const parsed = eventsRequestSchema.safeParse(body);
          if (!parsed.success) throw badRequest(`invalid events body: ${parsed.error.message}`);
          const ack = this.registry.events(parsed.data.node, parsed.data.events as NodeEvent[]);
          return sendJson(res, 200, { ack });
        }
        default:
          return sendJson(res, 404, { error: { code: "BAD_REQUEST", message: `no route ${route}` } });
      }
    } catch (err) {
      const e = StagehandError.from(err);
      const status =
        e.code === "UNKNOWN_NODE"
          ? 410
          : (e.details as { httpStatus?: number } | undefined)?.httpStatus ??
            (e.code === "BAD_REQUEST" ? 400 : 500);
      const obj = e.toObject();
      if ((obj.details as { httpStatus?: number } | undefined)?.httpStatus) delete obj.details;
      return sendJson(res, status, { error: obj });
    }
  }
}

function badRequest(message: string): StagehandError {
  return new StagehandError("BAD_REQUEST", message);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY) throw badRequest("body too large");
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw badRequest("empty body");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("body is not valid JSON");
  }
}
