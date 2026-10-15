// Wires broker, catalog, sessions, runner and stores together.
import path from "node:path";
import { BrokerServer } from "./broker/http.js";
import { NodeRegistry, type RegistryOptions } from "./broker/nodes.js";
import { DEFAULT_PORT } from "./broker/protocol.js";
import { RunManager } from "./engine/run.js";
import { SessionManager, type SessionManagerOptions } from "./engine/sessions.js";
import { Catalog, type CatalogEntry } from "./spec/catalog.js";
import { RunsStore } from "./store/runs.js";
import { TestsStore } from "./store/tests.js";

export interface DaemonOptions {
  root: string;
  port?: number;
  host?: string;
  allowEval?: boolean;
  registry?: RegistryOptions;
  sessions?: Omit<SessionManagerOptions, "port" | "log">;
  settleMs?: number;
  cancelGraceMs?: number;
  catalogTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class Daemon {
  readonly root: string;
  readonly registry: NodeRegistry;
  readonly broker: BrokerServer;
  readonly catalog: Catalog;
  readonly sessions: SessionManager;
  readonly runs: RunManager;
  readonly tests: TestsStore;
  readonly runsStore: RunsStore;
  readonly allowEval: boolean;
  brokerError: string | null = null;
  private readonly catalogFetches = new Map<string, Promise<void>>();
  private readonly log: (msg: string) => void;
  private readonly catalogTimeoutMs: number;

  constructor(opts: DaemonOptions) {
    this.root = path.resolve(opts.root);
    this.log = opts.log ?? ((m) => process.stderr.write(`[stagehand] ${m}\n`));
    this.allowEval = opts.allowEval ?? false;
    this.catalogTimeoutMs = opts.catalogTimeoutMs ?? 5_000;
    this.registry = new NodeRegistry(opts.registry);
    this.catalog = Catalog.load();
    const port = opts.port ?? DEFAULT_PORT;
    this.sessions = new SessionManager(this.registry, { ...opts.sessions, port, log: this.log });
    this.tests = new TestsStore(this.root);
    this.runsStore = new RunsStore(this.root);
    this.runs = new RunManager({
      registry: this.registry,
      catalog: this.catalog,
      sessions: this.sessions,
      runs: this.runsStore,
      awaitCatalogs: (ids) => this.awaitCatalogs(ids),
      log: this.log,
      settleMs: opts.settleMs,
      cancelGraceMs: opts.cancelGraceMs,
    });
    this.broker = new BrokerServer({
      registry: this.registry,
      port,
      host: opts.host,
      log: (m) => this.log(m),
      health: () => ({ sessions: this.sessions.list(), activeRun: this.runs.active()?.summary() ?? null }),
    });
    this.registry.on((e) => {
      if (e.kind === "event" && e.event.type === "node.ready") this.fetchCatalog(e.node.nodeId, true);
      if (e.kind === "detached") {
        this.catalog.removeLive(e.node.nodeId);
        this.catalogFetches.delete(e.node.nodeId);
      }
    });
  }

  async start(): Promise<number> {
    try {
      const port = await this.broker.listen();
      this.log(`broker listening on http://127.0.0.1:${port}/v1 (root ${this.root})`);
      return port;
    } catch (e) {
      this.brokerError = (e as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `port ${this.broker.port} is already in use (another stagehand-mcp running?); set --port or STAGEHAND_PORT`
        : (e as Error).message;
      this.log(`broker failed to start: ${this.brokerError}`);
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.sessions.close();
    this.registry.close();
    await this.broker.close();
  }

  private fetchCatalog(nodeId: string, force = false): Promise<void> {
    const existing = this.catalogFetches.get(nodeId);
    if (existing && !force) return existing;
    const node = this.registry.get(nodeId);
    if (!node) return Promise.resolve();
    const p = this.registry
      .send(nodeId, "catalog", {}, { timeoutMs: 10_000 })
      .then((r) => {
        const entries = (r as { entries?: CatalogEntry[] } | null)?.entries;
        if (Array.isArray(entries)) this.catalog.setLive(nodeId, node.role, entries);
      })
      .catch((e) => this.log(`catalog from ${nodeId} failed: ${(e as Error).message}`));
    this.catalogFetches.set(nodeId, p);
    return p;
  }

  async awaitCatalogs(nodeIds: string[]): Promise<void> {
    const all = Promise.all(nodeIds.map((id) => this.fetchCatalog(id)));
    await Promise.race([all, new Promise((r) => setTimeout(r, this.catalogTimeoutMs).unref())]);
  }
}
