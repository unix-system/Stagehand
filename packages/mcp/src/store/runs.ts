// Runs store: .stagehand/runs/<timestamp>-<name>/{events.ndjson,result.json,summary.md}.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface RunListItem {
  runId: string;
  name: string;
  status: string;
  startedAt: string | null;
  durationMs: number | null;
  dir: string;
}

export class RunsStore {
  readonly dir: string;
  constructor(root: string) {
    this.dir = path.join(root, ".stagehand", "runs");
  }

  /** Allocate a fresh run id + directory path (not created). */
  allocate(name: string, now = new Date()): { runId: string; dir: string } {
    const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
    let runId = `r_${ts}_${name}`;
    let dir = path.join(this.dir, `${ts}-${name}`);
    for (let i = 2; existsSync(dir) || this.taken.has(runId); i++) {
      runId = `r_${ts}_${name}-${i}`;
      dir = path.join(this.dir, `${ts}-${name}-${i}`);
    }
    this.taken.add(runId);
    return { runId, dir };
  }
  private readonly taken = new Set<string>();

  private async dirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    } catch {
      return [];
    }
  }

  async list(limit = 20, name?: string): Promise<RunListItem[]> {
    const out: RunListItem[] = [];
    for (const d of await this.dirs()) {
      if (out.length >= limit) break;
      const r = await this.readResult(path.join(this.dir, d));
      if (!r) continue;
      if (name && r.name !== name) continue;
      out.push({
        runId: String(r.runId),
        name: String(r.name),
        status: String(r.status),
        startedAt: (r.startedAt as string) ?? null,
        durationMs: (r.durationMs as number) ?? null,
        dir: path.join(this.dir, d),
      });
    }
    return out;
  }

  private async readResult(dir: string): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await readFile(path.join(dir, "result.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async get(runId: string): Promise<Record<string, unknown> | null> {
    if (runId === "latest") return this.latest();
    const m = /^r_(\d{8}T\d{6})_(.+)$/.exec(runId);
    if (m) {
      const r = await this.readResult(path.join(this.dir, `${m[1]}-${m[2]}`));
      if (r && r.runId === runId) return r;
    }
    for (const d of await this.dirs()) {
      const r = await this.readResult(path.join(this.dir, d));
      if (r?.runId === runId) return r;
    }
    return null;
  }

  async latest(): Promise<Record<string, unknown> | null> {
    for (const d of await this.dirs()) {
      const r = await this.readResult(path.join(this.dir, d));
      if (r) return r;
    }
    return null;
  }

  async events(runId: string): Promise<Record<string, unknown>[] | null> {
    const r = await this.get(runId);
    if (!r || typeof r.dir !== "string") return null;
    try {
      const text = await readFile(path.join(r.dir, "events.ndjson"), "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return null;
    }
  }
}
