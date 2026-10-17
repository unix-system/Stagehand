// Action/condition catalog: static schema/catalog.json merged with live entries reported by nodes.
import type { Context, Role } from "../broker/protocol.js";
import { createAjv, type AjvError, type AjvInstance } from "./ajv.js";
import { readSchemaJson } from "./paths.js";
import { parseSelector, SelectorError } from "./selectors.js";
import { suggestParam } from "./suggest.js";
import { isDurationString, varRefName } from "./values.js";

export type JsonSchema = Record<string, unknown>;

export interface CatalogEntry {
  name: string;
  kind: "action" | "condition";
  contexts: Context[];
  default: Context;
  summary: string;
  actor: "required" | "optional" | "none";
  params: JsonSchema;
  returns?: JsonSchema;
  notes?: string;
  source?: string;
}

export interface CatalogFile {
  version: number;
  ops: string[];
  contexts: Context[];
  entries: CatalogEntry[];
  dynamic?: {
    game?: { shape: CatalogEntry };
    lua?: { shape: Omit<CatalogEntry, "kind"> & { kind: string } };
  };
  [k: string]: unknown;
}

interface LiveCatalog {
  nodeId: string;
  role: Role;
  entries: CatalogEntry[];
}

export const LOG_CONDITIONS = new Set(["log.noErrors", "log.matches"]);

export class Catalog {
  readonly file: CatalogFile;
  private readonly staticEntries = new Map<string, CatalogEntry>();
  private readonly live = new Map<string, LiveCatalog>();
  /** game.* entries seen from server/client nodes in this daemon's lifetime. */
  private readonly gameCache = new Map<string, CatalogEntry>();
  private gameReported = false;
  private readonly ajv: AjvInstance;
  private readonly validators = new Map<string, ReturnType<AjvInstance["compile"]>>();

  constructor(file: CatalogFile) {
    this.file = file;
    for (const e of file.entries) this.staticEntries.set(e.name, e);
    this.ajv = createAjv();
  }

  static load(): Catalog {
    return new Catalog(readSchemaJson<CatalogFile>("catalog.json"));
  }

  get ops(): string[] {
    return this.file.ops;
  }

  /** Record the catalog reported by a node (`catalog` command). */
  setLive(nodeId: string, role: Role, entries: CatalogEntry[]): void {
    const clean = entries.filter((e) => e && typeof e.name === "string");
    this.live.set(nodeId, { nodeId, role, entries: clean });
    if (role !== "edit") {
      this.gameReported = true;
      for (const e of clean) if (e.name.startsWith("game.")) this.gameCache.set(e.name, e);
    }
  }

  removeLive(nodeId: string): void {
    this.live.delete(nodeId);
  }

  /**
   * True while a running game (server/client node) is attached and has reported its catalog: unknown
   * game.* names and bad hook params are errors then. Between sessions the game.* entries seen last time
   * stay available for authoring, but only as provisional (warnings): hooks may have changed since.
   */
  get gameVerified(): boolean {
    for (const l of this.live.values()) if (l.role !== "edit") return true;
    return false;
  }

  /** A game ever reported hooks in this daemon's lifetime (the cache may be non-empty). */
  get gameEverReported(): boolean {
    return this.gameReported;
  }

  /** Whether `name` comes from a node attached right now (vs. the cache of a past session). */
  isLive(name: string): boolean {
    for (const l of this.live.values()) if (l.entries.some((e) => e.name === name)) return true;
    return false;
  }

  get liveNodeCount(): number {
    return this.live.size;
  }

  /** Merged view: static, then cached game.*, then live entries (live wins). */
  entries(): CatalogEntry[] {
    const m = new Map(this.staticEntries);
    for (const [k, e] of this.gameCache) m.set(k, e);
    for (const l of this.live.values()) {
      for (const e of l.entries) {
        const prev = m.get(e.name);
        if (prev && e.name.startsWith("game.") && prev.source === "hook" && !sameContexts(prev, e)) {
          // Registered on both server and client: union the contexts (default server).
          const contexts = [...new Set([...prev.contexts, ...e.contexts])] as Context[];
          m.set(e.name, { ...e, contexts, default: contexts.includes("server") ? "server" : e.default });
        } else m.set(e.name, e);
      }
    }
    return [...m.values()];
  }

  get(name: string): CatalogEntry | undefined {
    return this.entries().find((e) => e.name === name);
  }

  names(): string[] {
    return this.entries().map((e) => e.name);
  }

  /** Pseudo-entry for the lua verb / `wait: lua` / `expect: lua`. */
  luaEntry(kind: "action" | "condition"): CatalogEntry {
    return {
      name: "lua",
      kind,
      contexts: ["edit", "server", "client"],
      default: "server",
      summary: "Run Luau with actor, player, character, vars in scope",
      actor: "optional",
      params: {
        type: "object",
        properties: { code: { type: "string" }, returns: { enum: ["any", "boolean"] } },
        required: ["code"],
        additionalProperties: false,
      },
    };
  }

  /** Placeholder for a game.* hook before any game node reported its catalog. */
  provisionalGameEntry(name: string, kind: "action" | "condition"): CatalogEntry {
    return {
      name,
      kind,
      contexts: ["server", "client"],
      default: "server",
      summary: "(game hook, not yet reported by a running game)",
      actor: "optional",
      params: { type: "object", additionalProperties: true },
      source: "hook",
    };
  }

  /**
   * Validate step params against an entry's params schema.
   * Unresolved "$var" values are accepted (resolved at runtime); durations accept numbers (seconds).
   */
  validateParams(entry: CatalogEntry, params: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const schema = entry.params ?? {};
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    const required = (schema.required as string[] | undefined) ?? [];
    const closed = schema.additionalProperties === false;
    for (const key of required) {
      if (!(key in params)) errors.push(`missing required param "${key}"${describeParam(props[key])}`);
    }
    for (const [key, value] of Object.entries(params)) {
      const ps = props[key];
      if (!ps) {
        if (closed) errors.push(`unknown param "${key}" for ${entry.name}${suggestParam(key, Object.keys(props))}`);
        continue;
      }
      if (varRefName(value)) continue;
      if (ps.format === "duration" && (typeof value === "number" ? value >= 0 : isDurationString(value))) continue;
      const cacheKey = `${entry.name}\u0000${key}\u0000${JSON.stringify(ps)}`;
      let validate = this.validators.get(cacheKey);
      if (!validate) {
        validate = this.ajv.compile(ps);
        this.validators.set(cacheKey, validate);
      }
      if (!validate(value)) {
        errors.push(`param "${key}": ${formatParamErrors(validate.errors ?? [], value, ps)}`);
      }
    }
    return errors;
  }
}

function sameContexts(a: CatalogEntry, b: CatalogEntry): boolean {
  return a.contexts.length === b.contexts.length && a.contexts.every((c) => b.contexts.includes(c));
}

function describeParam(ps: JsonSchema | undefined): string {
  if (!ps) return "";
  const t = paramTypeText(ps);
  return t ? ` (${t})` : "";
}

/** Short human type description for a param schema. */
export function paramTypeText(ps: JsonSchema): string {
  if (Array.isArray(ps.enum)) return (ps.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  if (Array.isArray(ps.oneOf)) return (ps.oneOf as JsonSchema[]).map(paramTypeText).join(" | ");
  if (ps.format === "selector") return "selector";
  if (ps.format === "duration") return "duration";
  if (ps.type === "array" && ps.minItems === 3 && ps.maxItems === 3) return "Vector3 [x,y,z]";
  if (ps.type === "array") return "array";
  if (ps.type === "object" && ps.properties && typeof ps.properties === "object" && "pos" in ps.properties)
    return "CFrame {pos, look}";
  if (typeof ps.type === "string") return ps.type;
  return "any";
}

function formatParamErrors(errs: AjvError[], value: unknown, ps: JsonSchema): string {
  if (ps.format === "selector" && typeof value === "string") {
    try {
      parseSelector(value);
    } catch (e) {
      if (e instanceof SelectorError) return `bad selector: ${e.message}`;
    }
  }
  for (const e of errs) {
    if (e.keyword === "format" && e.params.format === "selector" && typeof value === "string") {
      try {
        parseSelector(value);
      } catch (se) {
        return `bad selector: ${(se as Error).message}`;
      }
    }
  }
  const t = paramTypeText(ps);
  const enumErr = errs.find((e) => e.keyword === "enum");
  if (enumErr) return `must be one of ${t}, got ${JSON.stringify(value)}`;
  const top = errs.filter((e) => e.keyword !== "oneOf" && e.keyword !== "anyOf");
  const msgs = [...new Set(top.map((e) => `${e.instancePath ? e.instancePath + " " : ""}${e.message ?? "invalid"}`))];
  return `expected ${t}, got ${JSON.stringify(value)}${msgs.length && !Array.isArray(ps.oneOf) ? ` (${msgs.join("; ")})` : ""}`;
}
