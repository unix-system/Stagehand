// Validation against schema/playtest.schema.json with step-targeted, readable errors.
import type { AjvError, AjvInstance } from "./ajv.js";
import { createAjv } from "./ajv.js";
import { readSchemaJson } from "./paths.js";
import { type Diagnostic, type Step, VERBS } from "./types.js";

type Validator = ReturnType<AjvInstance["compile"]>;

interface Compiled {
  full: Validator;
  top: Validator;
  verbs: Record<string, Validator>;
}

let compiled: Compiled | null = null;

function load(): Compiled {
  if (compiled) return compiled;
  const schema = readSchemaJson<Record<string, unknown>>("playtest.schema.json");
  const ajv = createAjv();
  const full = ajv.compile(schema);
  // Relaxed copy: steps are plain objects, so per-step errors can be produced by walking.
  const relaxed = structuredClone(schema) as Record<string, unknown> & { $defs: Record<string, unknown> };
  relaxed.$id = "stagehand:relaxed";
  relaxed.$defs.step = { type: "object" };
  ajv.addSchema(relaxed);
  const top = ajv.getSchema("stagehand:relaxed") as Validator;
  const verbs: Record<string, Validator> = {};
  for (const v of VERBS) verbs[v] = ajv.getSchema(`stagehand:relaxed#/$defs/${v}Step`) as Validator;
  compiled = { full, top, verbs };
  return compiled;
}

export type PathPart = string | number;

export function formatPath(parts: PathPart[]): string {
  let s = "";
  for (const p of parts) s += typeof p === "number" ? `[${p}]` : s ? `.${p}` : p;
  return s || "(root)";
}

function pointerToParts(ptr: string): PathPart[] {
  if (!ptr) return [];
  return ptr
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** Validate a parsed document. Returns schema diagnostics (errors only); empty = valid. */
export function validateSchema(doc: unknown): Array<Diagnostic & { parts: PathPart[] }> {
  const c = load();
  if (c.full(doc)) return [];
  const out: Array<Diagnostic & { parts: PathPart[] }> = [];
  if (!c.top(doc)) out.push(...convert(c.top.errors ?? [], []));
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    const d = doc as Record<string, unknown>;
    for (const phase of ["setup", "steps", "teardown"]) {
      if (Array.isArray(d[phase])) walkList(d[phase] as unknown[], [phase], out, c);
    }
  }
  if (out.length === 0) out.push(...convert(c.full.errors ?? [], []));
  return dedupe(out);
}

function walkList(list: unknown[], base: PathPart[], out: Array<Diagnostic & { parts: PathPart[] }>, c: Compiled) {
  list.forEach((s, i) => walkStep(s, [...base, i], out, c));
}

function walkStep(step: unknown, parts: PathPart[], out: Array<Diagnostic & { parts: PathPart[] }>, c: Compiled) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    out.push(diag(parts, "a step must be a map with one verb key (do | wait | expect | lua | parallel | each)"));
    return;
  }
  const s = step as Step;
  const verbs = VERBS.filter((v) => v in s);
  if (verbs.length === 0) {
    out.push(
      diag(parts, `step has no verb; use exactly one of do | wait | expect | lua | parallel | each (keys: ${Object.keys(s).join(", ")})`),
    );
    return;
  }
  if (verbs.length > 1) {
    out.push(diag(parts, `step has more than one verb key: ${verbs.join(", ")} (split it into separate steps)`));
    return;
  }
  const verb = verbs[0]!;
  const v = c.verbs[verb]!;
  if (!v(s)) out.push(...convert(v.errors ?? [], parts, verb));
  if (verb === "parallel" && Array.isArray(s.parallel)) {
    (s.parallel as unknown[]).forEach((b, bi) => {
      if (Array.isArray(b)) walkList(b, [...parts, "parallel", bi], out, c);
      else walkStep(b, [...parts, "parallel", bi], out, c);
    });
  }
  if (verb === "each" && s.each && typeof s.each === "object" && Array.isArray((s.each as Step).steps)) {
    walkList((s.each as Step).steps as unknown[], [...parts, "each", "steps"], out, c);
  }
}

function diag(parts: PathPart[], message: string): Diagnostic & { parts: PathPart[] } {
  return { severity: "error", path: formatPath(parts), parts, message };
}

const MODIFIER_HINT: Record<string, string> = {
  lua: "lua steps accept only: lua, as, on, timeout, soft, label, save, if",
  parallel: "parallel steps accept only: parallel, soft, label, if (put `as` on the inner steps)",
  each: "each steps accept only: each, soft, label, if",
};

function convert(errors: AjvError[], base: PathPart[], verb?: string): Array<Diagnostic & { parts: PathPart[] }> {
  // Group by instance path; collapse oneOf noise.
  const byPath = new Map<string, AjvError[]>();
  for (const e of errors) {
    if (e.keyword === "if") continue;
    const k = e.instancePath;
    byPath.set(k, [...(byPath.get(k) ?? []), e]);
  }
  const out: Array<Diagnostic & { parts: PathPart[] }> = [];
  const paths = [...byPath.keys()];
  for (const [ptr, errs] of byPath) {
    const parts = [...base, ...pointerToParts(ptr)];
    // If a deeper path has errors under a oneOf here, prefer the deeper ones unless this is a duration.
    const isDuration = errs.some((e) => e.schemaPath.includes("/duration"));
    if (isDuration) {
      out.push(diag(parts, 'must be a duration like "250ms", "10s", "1.5m" or a number of seconds'));
      continue;
    }
    for (const e of errs) {
      if (e.keyword === "oneOf" || e.keyword === "anyOf") {
        if (paths.some((p) => p !== ptr && p.startsWith(ptr))) continue;
        if (e.schemaPath.includes("/lua/oneOf")) {
          out.push(diag(parts, 'lua must be a code string or { code, returns? }'));
          continue;
        }
        if (e.schemaPath.includes("/actors/oneOf")) {
          out.push(diag(parts, 'each.actors must be "all" or a non-empty list of actor names'));
          continue;
        }
        continue;
      }
      out.push(diag(parts, messageFor(e, verb)));
    }
  }
  return out;
}

function messageFor(e: AjvError, verb?: string): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "additionalProperties":
      return `unknown key "${String(p.additionalProperty)}"${verb && MODIFIER_HINT[verb] ? ` (${MODIFIER_HINT[verb]})` : ""}`;
    case "required":
      return `missing required key "${String(p.missingProperty)}"`;
    case "enum":
      return `must be one of ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(" | ")}`;
    case "const":
      return `must be ${JSON.stringify(p.allowedValue)}`;
    case "pattern":
      if (e.schemaPath.includes("varRef")) return 'must be a var reference like "$ready"';
      if (e.schemaPath.includes("actorName")) return "must be an actor name like p1 or blue";
      if (e.schemaPath.includes("ident")) return "must be an identifier ([A-Za-z_][A-Za-z0-9_]*)";
      if (e.instancePath.endsWith("/name")) return "must be lowercase kebab-case (^[a-z0-9][a-z0-9-]*$)";
      return `must match ${String(p.pattern)}`;
    case "not":
      return verb === "do" ? 'use a `lua:` step instead of `do: lua`' : "conflicting verb keys";
    case "minItems":
      return `must have at least ${String(p.limit)} item(s)`;
    case "uniqueItems":
      return "must not contain duplicates";
    case "propertyNames":
      return "has an invalid key name";
    default:
      return e.message ?? `failed ${e.keyword}`;
  }
}

function dedupe<T extends Diagnostic>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const k = `${d.path}\u0000${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
