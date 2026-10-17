// Compiler: validated spec -> Plan (actors, context resolution, segment merging, parallel, each, modifiers).
import type { Actor, Context, Verb } from "../broker/protocol.js";
import { type Catalog, type CatalogEntry, LOG_CONDITIONS } from "../spec/catalog.js";
import { ALL_MODIFIERS, COMMON_MODIFIERS } from "../spec/modifiers.js";
import { formatPath, type PathPart } from "../spec/schema.js";
import { suggest } from "../spec/suggest.js";
import type { Diagnostic, PlaytestSpec, SessionSpec, Step } from "../spec/types.js";
import { collectVarRefs, parseDuration, substituteVars, varRefName } from "../spec/values.js";
import {
  type NodeTarget,
  type NormalizedSession,
  type Phase,
  type Plan,
  type PlanNode,
  type PlanStep,
  type SegmentNode,
  targetKey,
} from "./plan.js";

export const DEFAULT_STEP_TIMEOUT_MS = 10_000;
export const DEFAULT_RUN_TIMEOUT_MS = 60_000;

export interface CompileOptions {
  /** Extra vars (e.g. run_steps vars) merged over spec.vars. */
  extraVars?: Record<string, unknown>;
  /** The Studio session that is live right now, for actor hints when the spec says 0 players. */
  liveSession?: { mode: string; players: number } | null;
  /** Fragments from playtests/_shared/*.fragment.yaml, by name (the spec's own `fragments:` shadow them). */
  sharedFragments?: Record<string, Step[]>;
}

/** Nesting limit for `use:` inside fragments (guards against a fragment using itself). */
export const MAX_FRAGMENT_DEPTH = 8;

export interface CompileResult {
  plan: Plan | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

type Atom = { kind: "atom"; step: PlanStep };
type Item = Atom | PlanNode;

interface Inherited {
  as: string | null;
  soft: boolean;
}

const MODIFIERS: Record<"do" | "wait" | "expect", Set<string>> = {
  do: new Set([...COMMON_MODIFIERS, "save", "with"]),
  wait: new Set([...COMMON_MODIFIERS, "with"]),
  expect: new Set([...COMMON_MODIFIERS, "within", "with"]),
};

export function normalizeSession(s: SessionSpec | undefined, errors?: Diagnostic[]): NormalizedSession {
  const players =
    s?.players ?? (s?.mode === "play" ? 1 : s?.mode === "multiplayer" ? 2 : 0);
  const mode = s?.mode ?? (players === 0 ? "run" : players === 1 ? "play" : "multiplayer");
  const bad = (msg: string) => errors?.push({ severity: "error", path: "session.players", message: msg });
  if ((mode === "edit" || mode === "run") && players !== 0) bad(`mode ${mode} requires players: 0 (got ${players})`);
  if (mode === "play" && players !== 1) bad(`mode play requires players: 1 (got ${players}); use multiplayer for 2..8`);
  if (mode === "multiplayer" && (players < 2 || players > 8)) bad(`mode multiplayer requires players 2..8 (got ${players})`);
  return { mode, players, reuse: s?.reuse ?? true, reset: s?.reset ?? "respawn" };
}

export function compile(spec: PlaytestSpec, catalog: Catalog, opts: CompileOptions = {}): CompileResult {
  return new Compiler(spec, catalog, opts).run();
}

class Compiler {
  private readonly errors: Diagnostic[] = [];
  private readonly warnings: Diagnostic[] = [];
  private readonly session: NormalizedSession;
  private readonly actors: Record<string, number> = {};
  private readonly vars: Record<string, unknown>;
  private readonly savedNames = new Set<string>();
  private readonly allSteps: PlanStep[] = [];

  private readonly liveSession: CompileOptions["liveSession"];
  private readonly fragments: Record<string, Step[]>;
  /** Fragment names on the current `use:` expansion path (recursion guard). */
  private readonly useStack: string[] = [];

  constructor(
    private readonly spec: PlaytestSpec,
    private readonly catalog: Catalog,
    opts: CompileOptions,
  ) {
    this.liveSession = opts.liveSession ?? null;
    this.fragments = { ...(opts.sharedFragments ?? {}), ...(spec.fragments ?? {}) };
    this.session = normalizeSession(spec.session, this.errors);
    this.vars = { ...(spec.vars ?? {}), ...(opts.extraVars ?? {}) };
    for (let i = 1; i <= this.session.players; i++) this.actors[`p${i}`] = i;
    for (const [name, a] of Object.entries(spec.actors ?? {})) {
      if (a.player > this.session.players) {
        this.err(["actors", name, "player"], `actor ${name} is player ${a.player} but the session has ${this.session.players} player(s)`);
        continue;
      }
      if (/^p\d+$/.test(name) && this.actors[name] !== undefined && this.actors[name] !== a.player) {
        this.err(["actors", name], `actor ${name} conflicts with the built-in ${name} (player ${this.actors[name]})`);
        continue;
      }
      this.actors[name] = a.player;
    }
    for (const phase of ["setup", "steps", "teardown"] as const) collectSaves(spec[phase] ?? [], this.savedNames, this.fragments);
  }

  run(): CompileResult {
    let timeoutMs = DEFAULT_RUN_TIMEOUT_MS;
    if (this.spec.timeout !== undefined) {
      try {
        timeoutMs = parseDuration(this.spec.timeout);
      } catch (e) {
        this.err(["timeout"], (e as Error).message);
      }
    }
    const phases: Record<Phase, PlanNode[]> = { setup: [], steps: [], teardown: [] };
    for (const phase of ["setup", "steps", "teardown"] as const) {
      phases[phase] = merge(this.expandList(this.spec[phase] ?? [], phase, phase, [phase], { as: null, soft: false }));
    }
    let seg = 0;
    const number = (nodes: PlanNode[]) => {
      for (const n of nodes) {
        if (n.kind === "segment") n.id = `seg_${++seg}`;
        else if (n.kind === "parallel") n.branches.forEach(number);
        else if (n.kind === "group") number(n.children);
      }
    };
    number(phases.setup);
    number(phases.steps);
    number(phases.teardown);
    const errors = dedupe(this.errors);
    const warnings = dedupe(this.warnings);
    if (errors.length) return { plan: null, errors, warnings };
    return {
      plan: {
        name: this.spec.name,
        description: this.spec.description ?? null,
        tags: this.spec.tags ?? [],
        session: this.session,
        timeoutMs,
        failOnError: this.spec.failOnError ?? true,
        actors: { ...this.actors },
        vars: { ...this.vars },
        setup: phases.setup,
        steps: phases.steps,
        teardown: phases.teardown,
        allSteps: this.allSteps,
      },
      errors,
      warnings,
    };
  }

  private err(parts: PathPart[], message: string): void {
    this.errors.push({ severity: "error", path: formatPath(parts), message, parts } as Diagnostic);
  }

  private warn(parts: PathPart[], message: string): void {
    this.warnings.push({ severity: "warning", path: formatPath(parts), message, parts } as Diagnostic);
  }

  private expandList(steps: Step[], phase: Phase, idBase: string, parts: PathPart[], inh: Inherited): Item[] {
    const out: Item[] = [];
    steps.forEach((s, i) => out.push(...this.expandStep(s, phase, `${idBase}.${i}`, [...parts, i], inh)));
    return out;
  }

  private expandStep(s: Step, phase: Phase, id: string, parts: PathPart[], inh: Inherited): Item[] {
    const ifVar = this.ifVar(s, parts);
    const soft = inh.soft || s.soft === true;
    const label = typeof s.label === "string" ? s.label : null;
    if ("parallel" in s) {
      const branches = (s.parallel as unknown[]).map((b, bi) => {
        const list = (Array.isArray(b) ? b : [b]) as Step[];
        const bparts = Array.isArray(b) ? [...parts, "parallel", bi] : [...parts, "parallel", bi];
        if (Array.isArray(b)) return merge(this.expandList(list, phase, `${id}.parallel.${bi}`, bparts, { ...inh, soft }));
        return merge(this.expandStep(list[0]!, phase, `${id}.parallel.${bi}.0`, bparts, { ...inh, soft }));
      });
      return [{ kind: "parallel", stepId: id, label, soft, ifVar, branches }];
    }
    if ("each" in s) {
      const each = s.each as { actors: string[] | "all"; steps: Step[] };
      let names: string[];
      if (each.actors === "all") {
        if (this.session.players === 0) this.err([...parts, "each", "actors"], 'each.actors "all" needs session.players >= 1');
        names = Array.from({ length: this.session.players }, (_, k) => `p${k + 1}`);
      } else names = each.actors;
      const items: Item[] = [];
      if (names.length > 1) {
        // vars are run-wide: a save in an each body is overwritten by every later actor.
        const saved = new Set<string>();
        collectSaves(each.steps, saved, this.fragments);
        for (const v of saved) {
          this.warn(
            [...parts, "each", "steps"],
            `save: ${v} inside each runs once per actor (${names.join(", ")}) and the var is run-wide, so later actors overwrite it; read $${v} inside the same iteration or save distinct names`,
          );
        }
      }
      for (const a of names) {
        if (this.actors[a] === undefined) {
          this.err([...parts, "each", "actors"], this.unknownActor(a));
          continue;
        }
        items.push(...this.expandList(each.steps, phase, `${id}.each.${a}`, [...parts, "each", "steps"], { as: a, soft }));
      }
      if (ifVar) return [{ kind: "group", stepId: id, label, soft, ifVar, children: merge(items) }];
      return items;
    }
    if ("use" in s) {
      const name = String(s.use);
      const frag = this.fragments[name];
      if (!frag) {
        const known = Object.keys(this.fragments);
        this.err([...parts, "use"], `unknown fragment "${name}"${known.length ? ` (known: ${known.join(", ")})` : " (define it under fragments: or in playtests/_shared/<name>.fragment.yaml)"}`);
        return [];
      }
      if (this.useStack.includes(name) || this.useStack.length >= MAX_FRAGMENT_DEPTH) {
        this.err([...parts, "use"], `fragment "${name}" uses itself (${[...this.useStack, name].join(" → ")})`);
        return [];
      }
      // `vars` on the use step are substituted into the fragment's steps now, so one fragment can be
      // reused with different values; `as` binds the actor for steps that do not name one.
      const useVars = (s.vars && typeof s.vars === "object" ? s.vars : {}) as Record<string, unknown>;
      const asName = typeof s.as === "string" ? s.as : inh.as;
      if (asName && this.actors[asName] === undefined) {
        this.err([...parts, "as"], this.unknownActor(asName));
        return [];
      }
      const steps = (Object.keys(useVars).length ? substituteVars(frag, useVars) : frag) as Step[];
      this.useStack.push(name);
      const items = this.expandList(steps, phase, `${id}.use.${name}`, [...parts, "use"], { as: asName, soft });
      this.useStack.pop();
      if (ifVar) return [{ kind: "group", stepId: id, label, soft, ifVar, children: merge(items) }];
      return items;
    }
    const step = this.compileAtom(s, phase, id, parts, inh, ifVar, soft, label);
    return step ? [{ kind: "atom", step }] : [];
  }

  private ifVar(s: Step, parts: PathPart[]): string | null {
    if (s.if === undefined) return null;
    const name = varRefName(s.if);
    if (!name) {
      this.err([...parts, "if"], 'if must be a var reference like "$ready"');
      return null;
    }
    if (!(name in this.vars) && !this.savedNames.has(name))
      this.warn([...parts, "if"], `$${name} is not defined in vars and never saved; the step will always be skipped`);
    return name;
  }

  private unknownActor(a: string): string {
    const known = Object.keys(this.actors);
    if (known.length) return `unknown actor "${a}" (known: ${known.join(", ")})`;
    const live = this.liveSession;
    const hint =
      live && live.players > 0
        ? `; a ${live.mode} session with ${live.players} player(s) is live: omit session or pass players: ${live.players} to use it`
        : "; set session.players (1 = Play, 2-8 = multiplayer)";
    return `unknown actor "${a}" (session has 0 players${hint})`;
  }

  private compileAtom(
    s: Step,
    phase: Phase,
    id: string,
    parts: PathPart[],
    inh: Inherited,
    ifVar: string | null,
    soft: boolean,
    label: string | null,
  ): PlanStep | null {
    const errCount = this.errors.length;
    let verb: Verb;
    let name: string | null;
    let entry: CatalogEntry | undefined;
    let params: Record<string, unknown> = {};
    if ("lua" in s) {
      verb = "lua";
      name = null;
      entry = this.catalog.luaEntry("action");
      const l = s.lua as string | { code: string; returns?: string };
      params = typeof l === "string" ? { code: l } : { ...l };
    } else {
      verb = ("do" in s ? "do" : "wait" in s ? "wait" : "expect") as "do" | "wait" | "expect";
      name = String(s[verb]);
      const mods = MODIFIERS[verb];
      for (const [k, v] of Object.entries(s)) {
        if (k === verb || mods.has(k)) continue;
        if (k === "save") {
          this.err([...parts, k], "save is only allowed on do/lua steps");
          continue;
        }
        if (k === "within") {
          this.err([...parts, k], "within is only allowed on expect steps");
          continue;
        }
        params[k] = v;
      }
      if (s.with && typeof s.with === "object") Object.assign(params, s.with as Record<string, unknown>);
      const kind = verb === "do" ? "action" : "condition";
      if (name === "lua") {
        if (verb === "do") {
          this.err([...parts, "do"], "use a `lua:` step for Lua actions (do: lua is not valid)");
          return null;
        }
        entry = this.catalog.luaEntry("condition");
      } else {
        entry = this.catalog.get(name);
        if (name.startsWith("game.") && !this.catalog.gameVerified) {
          // No game node is attached: a cached entry from a past session may be stale (params renamed,
          // hook removed), so check it loosely now; the run re-validates once the session is ready.
          if (entry) {
            this.warn(
              [...parts, verb],
              `game hook "${name}" is known from a previous session only; its params are re-checked against the running game after the session starts`,
            );
            entry = { ...this.catalog.provisionalGameEntry(name, entry.kind), contexts: entry.contexts, default: entry.default, actor: entry.actor, summary: entry.summary };
          } else {
            this.warn([...parts, verb], `game hook "${name}" cannot be verified until the game is running; it will be checked after the session starts`);
            entry = this.catalog.provisionalGameEntry(name, kind);
          }
        } else if (!entry && name.startsWith("game.")) {
          this.err([...parts, verb], `unknown game hook "${name}"; the running game did not register it (Hooks.server/Hooks.client)${suggest(name, this.catalog.names())}`);
          return null;
        }
        if (!entry) {
          this.err([...parts, verb], `unknown ${kind} "${name}"${suggest(name, this.catalog.names())}`);
          return null;
        }
        if (entry.kind !== kind) {
          this.err(
            [...parts, verb],
            entry.kind === "condition"
              ? `${name} is a condition; use wait: or expect: instead of do:`
              : `${name} is an action; use do: instead of ${verb}:`,
          );
          return null;
        }
      }
    }

    // Vars: substitute known (and never re-saved) vars now; the rest are resolved at dispatch / on the node.
    const frozen: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.vars)) if (!this.savedNames.has(k)) frozen[k] = v;
    params = substituteVars(params, frozen) as Record<string, unknown>;
    for (const ref of collectVarRefs(params)) {
      if (!(ref in this.vars) && !this.savedNames.has(ref))
        this.err(parts, `unknown var $${ref} (define it under vars: or save it in an earlier step)`);
    }
    for (const e of this.catalog.validateParams(entry, params)) {
      // A required param named like a modifier (label, timeout, …) was written flat and eaten as the
      // modifier: say so instead of "missing required param".
      const m = /^missing required param "([^"]+)"/.exec(e);
      if (m && ALL_MODIFIERS.has(m[1]!) && m[1]! in s && !(m[1]! in params)) {
        this.err(
          parts,
          `${name}: param "${m[1]}" collides with the step modifier "${m[1]}" and was read as the modifier; pass it as with: { ${m[1]}: … }`,
        );
        continue;
      }
      this.err(parts, `${name ?? "lua"}: ${e}`);
    }

    // Context resolution (spec.md rules 1-4).
    const on = typeof s.on === "string" ? (s.on as Context) : null;
    const mode = this.session.mode;
    let context: Context = on ?? entry.default;
    if (on && !entry.contexts.includes(on)) {
      this.err([...parts, "on"], `${name ?? "lua"} cannot run on ${on} (allowed: ${entry.contexts.join(", ")})`);
    }
    if (mode === "edit") {
      if (context === "client") {
        this.err(parts, `${name ?? "lua"} runs on the client, which does not exist in edit mode`);
      } else if (context === "server") {
        if (!entry.contexts.includes("edit"))
          this.err(parts, `${name} needs a running game (contexts: ${entry.contexts.join(", ")}); it cannot run in edit mode`);
        context = "edit";
      }
    } else if (context === "edit" && !on) {
      context = entry.contexts.includes("server") ? "server" : context;
    }

    // Actor resolution.
    const explicitAs = typeof s.as === "string" ? s.as : null;
    const asName = explicitAs ?? inh.as;
    let actor: Actor | null = null;
    if (asName) {
      const idx = this.actors[asName];
      if (idx === undefined) this.err([...parts, "as"], this.unknownActor(asName));
      else actor = { name: asName, playerIndex: idx };
    } else if (entry.actor === "required" && context !== "edit") {
      if (this.session.players === 1) actor = { name: "p1", playerIndex: 1 };
      else if (this.session.players === 0)
        this.err(parts, `${name} needs a player but session.players is 0 (set session: { players: 1 })`);
      else this.err(parts, `${name} needs \`as:\` (which player) when session.players >= 2`);
    }
    let target: NodeTarget;
    if (context === "client") {
      if (this.session.players === 0) {
        this.err(parts, `${name ?? "lua"} runs on a client but session.players is 0`);
        target = { role: "client", playerIndex: 1 };
      } else {
        if (!actor) actor = { name: "p1", playerIndex: 1 };
        target = { role: "client", playerIndex: actor.playerIndex };
      }
    } else if (context === "server") {
      target = { role: "server" };
    } else {
      target = { role: "edit" };
      if (explicitAs) this.warn([...parts, "as"], `as: ${explicitAs} is ignored for steps that run on the edit node`);
      actor = null;
    }

    // Durations.
    let timeoutMs = DEFAULT_STEP_TIMEOUT_MS;
    let withinMs: number | null = null;
    if (s.timeout !== undefined) {
      try {
        timeoutMs = parseDuration(s.timeout);
      } catch (e) {
        this.err([...parts, "timeout"], (e as Error).message);
      }
    }
    if (verb === "expect" && s.within !== undefined) {
      try {
        withinMs = parseDuration(s.within);
        if (s.timeout === undefined) timeoutMs = Math.max(DEFAULT_STEP_TIMEOUT_MS, withinMs);
        else withinMs = Math.min(withinMs, timeoutMs);
      } catch (e) {
        this.err([...parts, "within"], (e as Error).message);
      }
    }

    // session.wait sleeps by design: budget its duration (plus slack) unless a timeout is given.
    if (name === "session.wait" && s.timeout === undefined) {
      try {
        timeoutMs = Math.max(DEFAULT_STEP_TIMEOUT_MS, parseDuration(params.duration as string | number) + 2_000);
      } catch {
        /* $var or invalid: param validation reports it */
      }
    }

    const save = typeof s.save === "string" ? s.save : null;
    const daemon =
      (verb === "wait" || verb === "expect") && !!name && LOG_CONDITIONS.has(name) && (params.scope ?? "all") === "all";
    if (this.errors.length > errCount) return null;
    // Lua steps read badly as "lua lua as p1": show the code (collapsed) and ask for a label.
    const isLua = verb === "lua" || name === "lua";
    if (isLua && label === null) {
      this.warn(parts, `${verb === "lua" ? "lua" : `${verb}: lua`} step has no label; add label: "<what it does or checks>" so reports and the Studio progress widget read well`);
    }
    const suffix = `${actor ? ` as ${actor.name}` : ""}${context !== entry.default ? ` on ${context}` : ""}`;
    const display =
      label ??
      (isLua
        ? `${verb === "lua" ? "lua" : `${verb} lua`}: ${collapseCode(String(params.code ?? ""))}${suffix}`
        : `${verb} ${name}${suffix}`);
    const step: PlanStep = {
      id,
      verb,
      name,
      params,
      timeoutMs,
      withinMs,
      soft,
      actor,
      label,
      save,
      phase,
      context,
      target,
      ifVar,
      daemon,
      display,
    };
    this.allSteps.push(step);
    return step;
  }
}

/** One line of Lua for a display name: whitespace collapsed, `return ` dropped, cut at 48 chars. */
export function collapseCode(code: string, max = 48): string {
  const one = code.replace(/\s+/g, " ").trim().replace(/^return\s+/, "");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Merge consecutive same-node atoms into segments; `if` and daemon steps stand alone. */
export function merge(items: Item[]): PlanNode[] {
  const out: PlanNode[] = [];
  let open: SegmentNode | null = null;
  for (const it of items) {
    if (it.kind !== "atom") {
      out.push(it);
      open = null;
      continue;
    }
    const st = it.step;
    if (st.daemon) {
      out.push({ kind: "daemon", step: st, ifVar: st.ifVar });
      open = null;
      continue;
    }
    if (st.ifVar) {
      out.push({ kind: "segment", id: "", target: st.target, steps: [st], ifVar: st.ifVar });
      open = null;
      continue;
    }
    if (open && targetKey(open.target) === targetKey(st.target)) {
      open.steps.push(st);
      continue;
    }
    open = { kind: "segment", id: "", target: st.target, steps: [st], ifVar: null };
    out.push(open);
  }
  return out;
}

function collectSaves(steps: Step[], out: Set<string>, fragments: Record<string, Step[]> = {}, seen = new Set<string>()): void {
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.save === "string") out.add(s.save);
    if (Array.isArray(s.parallel))
      for (const b of s.parallel as unknown[]) collectSaves((Array.isArray(b) ? b : [b]) as Step[], out, fragments, seen);
    if (s.each && typeof s.each === "object" && Array.isArray((s.each as Step).steps))
      collectSaves((s.each as Step).steps as Step[], out, fragments, seen);
    if (typeof s.use === "string" && fragments[s.use] && !seen.has(s.use)) {
      seen.add(s.use);
      collectSaves(fragments[s.use]!, out, fragments, seen);
    }
  }
}

function dedupe(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const k = `${d.path}\u0000${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

