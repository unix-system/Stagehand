import { describe, expect, it } from "vitest";
import { compile } from "../src/engine/compile.js";
import { describePlan, type Plan, stepsOf, targetKey } from "../src/engine/plan.js";
import { validateInput } from "../src/engine/validate.js";
import { Catalog, type CatalogEntry, type JsonSchema } from "../src/spec/catalog.js";
import type { PlaytestSpec } from "../src/spec/types.js";
import { BLUE_TEAM, NIGHT_MODE, TWO_PLAYER } from "./fixtures.js";

const catalog = Catalog.load();

function sample(ps: JsonSchema): unknown {
  if (Array.isArray(ps.enum)) return ps.enum[0];
  if (Array.isArray(ps.oneOf)) return sample(ps.oneOf[0] as JsonSchema);
  if (ps.format === "selector") return "Workspace.Part";
  if (ps.format === "duration") return "1s";
  if (ps.type === "array") return ps.minItems === 3 ? [0, 0, 0] : [];
  if (ps.type === "integer" || ps.type === "number") return (ps.minimum as number | undefined) ?? 1;
  if (ps.type === "boolean") return true;
  if (ps.type === "string") return "x";
  if (ps.type === "object") return {};
  return 1;
}

function stepFor(e: CatalogEntry, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const props = (e.params.properties as Record<string, JsonSchema>) ?? {};
  const step: Record<string, unknown> = { [e.kind === "action" ? "do" : "expect"]: e.name, ...extra };
  for (const k of (e.params.required as string[]) ?? []) step[k] = sample(props[k]!);
  return step;
}

function compileOne(step: Record<string, unknown>, session: PlaytestSpec["session"]) {
  const spec: PlaytestSpec = { name: "t", session, steps: [step] };
  return compile(spec, catalog);
}

function ok(spec: unknown): Plan {
  const v = validateInput(spec, catalog);
  if (!v.ok) throw new Error(JSON.stringify(v.errors, null, 2));
  return v.plan!;
}

function errorsOf(spec: unknown): string[] {
  return validateInput(spec, catalog).errors.map((e) => `${e.path}: ${e.message}`);
}

describe("routing for every catalog default context", () => {
  for (const e of catalog.file.entries) {
    it(`${e.name} -> ${e.default}`, () => {
      const res = compileOne(stepFor(e, { as: "p1" }), { mode: "play", players: 1 });
      expect(res.errors).toEqual([]);
      const s = res.plan!.allSteps[0]!;
      expect(s.context).toBe(e.default);
      expect(targetKey(s.target)).toBe(e.default === "client" ? "client#1" : e.default);
      expect(s.actor).toEqual(e.default === "edit" ? null : { name: "p1", playerIndex: 1 });
    });
  }

  it("every context listed by an entry is reachable with on:", () => {
    for (const e of catalog.file.entries) {
      for (const ctx of e.contexts) {
        const res = compileOne(stepFor(e, { as: "p1", on: ctx }), { mode: "play", players: 1 });
        expect(res.errors, `${e.name} on ${ctx}`).toEqual(e.actor === "required" && ctx === "edit" ? res.errors : []);
        if (res.plan) expect(res.plan.allSteps[0]!.target.role).toBe(ctx);
      }
    }
  });

  it("edit mode: server-default entries that allow edit resolve to edit; others are errors", () => {
    for (const e of catalog.file.entries) {
      const res = compileOne(stepFor(e), { mode: "edit", players: 0 });
      if (e.contexts.includes("edit")) {
        expect(res.errors, e.name).toEqual([]);
        expect(res.plan!.allSteps[0]!.target).toEqual({ role: "edit" });
      } else {
        expect(res.errors.length, e.name).toBeGreaterThan(0);
      }
    }
  });

  it("session.wait budgets its own duration unless a timeout is given", () => {
    const step = (extra: Record<string, unknown>) =>
      compileOne({ do: "session.wait", duration: "20s", ...extra }, { players: 1 }).plan!.allSteps[0]!.timeoutMs;
    expect(step({})).toBe(22_000);
    expect(step({ timeout: "5s" })).toBe(5_000);
    expect(compileOne({ do: "session.wait", duration: "1s" }, { players: 1 }).plan!.allSteps[0]!.timeoutMs).toBe(10_000);
  });

  it("client steps pick the actor's client node", () => {
    const res = compileOne({ do: "input.key", as: "p2", code: "Space" }, { players: 2 });
    expect(res.plan!.allSteps[0]!.target).toEqual({ role: "client", playerIndex: 2 });
  });

  it("client steps without as default to p1 and fail with 0 players", () => {
    const one = compileOne({ do: "remote.fire", name: "Ping" }, { players: 1 });
    expect(one.plan!.allSteps[0]!.target).toEqual({ role: "client", playerIndex: 1 });
    const zero = compileOne({ do: "remote.fire", name: "Ping" }, { players: 0 });
    expect(zero.errors[0]!.message).toMatch(/players is 0/);
  });

  it("actor-required steps default to p1 with one player and require as with two", () => {
    expect(compileOne({ do: "player.respawn" }, { players: 1 }).plan!.allSteps[0]!.actor).toEqual({ name: "p1", playerIndex: 1 });
    expect(compileOne({ do: "player.respawn" }, { players: 2 }).errors[0]!.message).toMatch(/needs `as:`/);
    expect(compileOne({ do: "player.respawn" }, { players: 0 }).errors[0]!.message).toMatch(/needs a player/);
  });

  it("server steps without an actor send actor null", () => {
    const s = compileOne({ do: "instance.set", target: "Lighting", prop: "ClockTime", value: 0 }, { players: 2 }).plan!.allSteps[0]!;
    expect(s.actor).toBeNull();
    expect(s.target).toEqual({ role: "server" });
  });

  it("lua defaults to server (edit in edit mode) and respects on:", () => {
    expect(compileOne({ lua: "return 1" }, { players: 0 }).plan!.allSteps[0]!.target).toEqual({ role: "server" });
    expect(compileOne({ lua: "return 1" }, { mode: "edit" }).plan!.allSteps[0]!.target).toEqual({ role: "edit" });
    expect(compileOne({ lua: "return 1", on: "client", as: "p1" }, { players: 1 }).plan!.allSteps[0]!.target).toEqual({ role: "client", playerIndex: 1 });
    const w = compileOne({ wait: "lua", code: "return true" }, { players: 0 }).plan!.allSteps[0]!;
    expect(w).toMatchObject({ verb: "wait", name: "lua", params: { code: "return true" } });
  });

  it("edit context ignores as with a warning", () => {
    const res = compileOne({ do: "instance.set", on: "edit", as: "p1", target: "Lighting", prop: "ClockTime", value: 1 }, { players: 1 });
    expect(res.plan!.allSteps[0]!.actor).toBeNull();
    expect(res.warnings[0]!.message).toMatch(/ignored/);
  });
});

describe("spec examples", () => {
  it("example 1 (blue team): one merged server segment + teardown", () => {
    const plan = ok(BLUE_TEAM);
    expect(plan.session).toEqual({ mode: "play", players: 1, reuse: true, reset: "respawn" });
    expect(plan.steps).toHaveLength(1);
    const seg = plan.steps[0]!;
    expect(seg.kind).toBe("segment");
    if (seg.kind !== "segment") return;
    expect(seg.id).toBe("seg_1");
    expect(seg.target).toEqual({ role: "server" });
    expect(seg.steps.map((s) => s.id)).toEqual(["steps.0", "steps.1", "steps.2", "steps.3", "steps.4", "steps.5"]);
    const teleport = seg.steps[3]!;
    expect(teleport).toMatchObject({ verb: "do", name: "character.teleport", params: { to: [120, 5, -40] }, timeoutMs: 10000, withinMs: null, soft: false, actor: { name: "p1", playerIndex: 1 }, save: null, label: null });
    const hasTag = seg.steps[5]!;
    expect(hasTag).toMatchObject({ verb: "expect", name: "instance.hasTag", params: { target: "@p1.character", tag: "Hostile" }, withinMs: 2000, timeoutMs: 10000 });
    expect(seg.steps[2]!.timeoutMs).toBe(10000);
    expect(plan.teardown[0]).toMatchObject({ kind: "segment", id: "seg_2", steps: [{ id: "teardown.0", soft: true }] });
  });

  it("example 1 warns about unverified game hooks", () => {
    const v = validateInput(BLUE_TEAM, catalog);
    expect(v.warnings.map((w) => w.message).join()).toMatch(/game\.requestSpawn/);
  });

  it("example 2 (night mode): run mode, log.noErrors evaluated by the daemon", () => {
    const plan = ok(NIGHT_MODE);
    expect(plan.session.mode).toBe("run");
    expect(plan.steps.map((n) => n.kind)).toEqual(["segment", "daemon"]);
    const seg = plan.steps[0]!;
    if (seg.kind !== "segment") throw new Error();
    expect(seg.steps.map((s) => s.id)).toEqual(["steps.0", "steps.1", "steps.2", "steps.3", "steps.4", "steps.5"]);
    expect(seg.steps[3]).toMatchObject({ verb: "wait", timeoutMs: 3000, params: { target: "Workspace.Map.Lamps.*[]" } });
    expect(seg.steps[4]).toMatchObject({ verb: "lua", name: null, params: { code: expect.stringContaining("GetTagged") }, save: "lit", label: "count lamps" });
    expect(seg.steps[5]).toMatchObject({ verb: "expect", name: "lua" });
  });

  it("example 3 (two players): each + parallel expansion and merging", () => {
    const plan = ok(TWO_PLAYER);
    expect(plan.actors).toEqual({ p1: 1, p2: 2, blue: 1, red: 2 });
    const kinds = plan.steps.map((n) => n.kind);
    expect(kinds).toEqual(["segment", "parallel", "segment", "segment"]);
    const first = plan.steps[0]!;
    if (first.kind !== "segment") throw new Error();
    expect(first.steps.map((s) => s.id)).toEqual([
      "steps.0",
      "steps.1",
      "steps.2.each.p1.0",
      "steps.2.each.p1.1",
      "steps.2.each.p1.2",
      "steps.2.each.p2.0",
      "steps.2.each.p2.1",
      "steps.2.each.p2.2",
    ]);
    expect(first.steps[0]!.actor).toEqual({ name: "blue", playerIndex: 1 });
    expect(first.steps[6]!.actor).toEqual({ name: "p2", playerIndex: 2 });
    expect(first.steps[6]!.timeoutMs).toBe(15000);
    const par = plan.steps[1]!;
    if (par.kind !== "parallel") throw new Error();
    expect(par.stepId).toBe("steps.3");
    expect(par.branches).toHaveLength(2);
    expect(stepsOf(par.branches[0]!).map((s) => s.id)).toEqual(["steps.3.parallel.0.0", "steps.3.parallel.0.1"]);
    expect(par.branches[0]!).toHaveLength(1);
    expect(par.branches[1]![0]).toMatchObject({ kind: "segment", target: { role: "client", playerIndex: 2 } });
    expect(plan.steps[3]).toMatchObject({ kind: "segment", target: { role: "client", playerIndex: 2 }, steps: [{ id: "steps.6", withinMs: 2000 }] });
    const ids = plan.allSteps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const segIds: string[] = [];
    const walk = (ns: typeof plan.steps) => ns.forEach((n) => (n.kind === "segment" ? segIds.push(n.id) : n.kind === "parallel" ? n.branches.forEach(walk) : null));
    walk(plan.steps);
    expect(segIds).toEqual(["seg_1", "seg_2", "seg_3", "seg_4", "seg_5"]);
    expect(describePlan(plan).join("\n")).toMatch(/parallel steps\.3/);
  });
});

describe("segment merging and modifiers", () => {
  const base = { name: "m", session: { players: 2 } };

  it("splits segments on node changes and merges same-node runs", () => {
    const plan = ok({
      ...base,
      steps: [
        { do: "player.setTeam", as: "p1", team: "Blue" },
        { do: "player.setTeam", as: "p2", team: "Red" },
        { do: "input.key", as: "p1", code: "Space" },
        { do: "gui.click", as: "p1", target: "@p1.gui.Menu.Play" },
        { do: "input.key", as: "p2", code: "Space" },
        { expect: "player.count", value: 2 },
      ],
    });
    expect(plan.steps.map((n) => (n.kind === "segment" ? `${targetKey(n.target)}:${n.steps.length}` : n.kind))).toEqual([
      "server:2",
      "client#1:2",
      "client#2:1",
      "server:1",
    ]);
  });

  it("if steps stand alone and if on each becomes a group", () => {
    const plan = ok({
      ...base,
      vars: { flag: true },
      steps: [
        { do: "player.respawn", as: "p1" },
        { do: "player.respawn", as: "p2", if: "$flag" },
        { do: "player.respawn", as: "p1" },
        { each: { actors: "all", steps: [{ do: "player.respawn" }] }, if: "$flag" },
      ],
    });
    expect(plan.steps.map((n) => n.kind)).toEqual(["segment", "segment", "segment", "group"]);
    expect(plan.steps[1]).toMatchObject({ ifVar: "flag" });
    const g = plan.steps[3]!;
    if (g.kind !== "group") throw new Error();
    expect(stepsOf(g.children).map((s) => s.id)).toEqual(["steps.3.each.p1.0", "steps.3.each.p2.0"]);
  });

  it("propagates soft from each/parallel and single-step parallel branches", () => {
    const plan = ok({
      ...base,
      steps: [
        { each: { actors: ["p2"], steps: [{ do: "player.respawn" }] }, soft: true },
        { parallel: [{ do: "character.jump", as: "p1" }, [{ do: "character.jump", as: "p2" }]], soft: true },
      ],
    });
    expect(plan.allSteps.every((s) => s.soft)).toBe(true);
    expect(plan.allSteps.map((s) => s.id)).toEqual(["steps.0.each.p2.0", "steps.1.parallel.0.0", "steps.1.parallel.1.0"]);
  });

  it("timeouts, within, save, label, with", () => {
    const plan = ok({
      ...base,
      steps: [
        { expect: "character.alive", as: "p1", within: "30s" },
        { expect: "character.alive", as: "p1", within: "5s", timeout: "2s" },
        { wait: "character.loaded", as: "p1", timeout: 1.5 },
        { do: "instance.clone", target: "Workspace.Part", parent: "Workspace", save: "copy", label: "clone it" },
        { do: "remote.fire", as: "p1", name: "x", with: { name: "Ping", args: [1] } },
        { do: "instance.destroy", target: "$copy" },
      ],
    });
    const s = plan.allSteps;
    expect(s[0]).toMatchObject({ withinMs: 30000, timeoutMs: 30000 });
    expect(s[1]).toMatchObject({ withinMs: 2000, timeoutMs: 2000 });
    expect(s[2]).toMatchObject({ timeoutMs: 1500 });
    expect(s[3]).toMatchObject({ save: "copy", label: "clone it", display: "clone it" });
    expect(s[4]!.params).toEqual({ name: "Ping", args: [1] });
    expect(s[5]!.params).toEqual({ target: "$copy" });
  });

  it("substitutes known vars at compile time but not re-saved ones", () => {
    const plan = ok({ ...base, vars: { pos: [1, 2, 3], copy: "Workspace.A" }, steps: [
      { do: "character.teleport", as: "p1", to: "$pos" },
      { do: "instance.clone", target: "Workspace.Part", parent: "Workspace", save: "copy" },
      { do: "instance.destroy", target: "$copy" },
    ] });
    expect(plan.allSteps[0]!.params.to).toEqual([1, 2, 3]);
    expect(plan.allSteps[2]!.params.target).toBe("$copy");
  });
});

describe("validation errors", () => {
  const s = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ name: "e", session: { players: 1 }, steps, ...extra });

  it("unknown action with suggestion", () => {
    expect(errorsOf(s([{ do: "character.teleprot", to: [0, 0, 0] }])).join()).toMatch(/unknown action "character.teleprot".*did you mean "character.teleport"/);
  });
  it("kind mismatch", () => {
    expect(errorsOf(s([{ do: "character.alive" }])).join()).toMatch(/is a condition/);
    expect(errorsOf(s([{ expect: "character.jump" }])).join()).toMatch(/is an action/);
  });
  it("bad / missing / unknown params", () => {
    const e = errorsOf(s([{ do: "character.teleport", too: [0, 0, 0] }])).join("\n");
    expect(e).toMatch(/missing required param "to"/);
    expect(e).toMatch(/unknown param "too"/);
    expect(errorsOf(s([{ expect: "player.count", op: "equals", value: 1 }])).join()).toMatch(/must be one of/);
    expect(errorsOf(s([{ do: "character.teleport", to: [0, 0] }])).join()).toMatch(/param "to"/);
  });
  it("bad selector syntax", () => {
    expect(errorsOf(s([{ expect: "instance.exists", target: "Workspace.My Part" }])).join()).toMatch(/bad selector/);
  });
  it("schema errors: verbs, durations, unknown keys, name", () => {
    expect(errorsOf(s([{ do: "character.jump", wait: "character.alive" }])).join()).toMatch(/more than one verb/);
    expect(errorsOf(s([{ as: "p1" }])).join()).toMatch(/no verb/);
    expect(errorsOf(s([{ do: "character.jump", timeout: "10 seconds" }])).join()).toMatch(/steps\[0\]\.timeout: must be a duration/);
    expect(errorsOf(s([{ lua: "return 1", bogus: 1 }])).join()).toMatch(/unknown key "bogus"/);
    expect(errorsOf({ name: "Bad_Name", steps: [{ lua: "return 1" }] }).join()).toMatch(/kebab-case/);
    expect(errorsOf({ name: "x", steps: [] }).join()).toMatch(/at least 1/);
    expect(errorsOf(s([{ do: "lua" }])).join()).toMatch(/lua/);
  });
  it("modifier misuse", () => {
    expect(errorsOf(s([{ do: "character.jump", within: "1s" }])).join()).toMatch(/within is only allowed on expect/);
    expect(errorsOf(s([{ wait: "character.alive", save: "x" }])).join()).toMatch(/save is only allowed/);
    expect(errorsOf(s([{ do: "player.setTeam", on: "client", team: "Blue" }])).join()).toMatch(/cannot run on client/);
  });
  it("actors and vars", () => {
    expect(errorsOf(s([{ do: "character.jump", as: "p2" }])).join()).toMatch(/unknown actor "p2"/);
    expect(errorsOf(s([{ do: "character.jump" }], { actors: { red: { player: 2 } } })).join()).toMatch(/has 1 player/);
    expect(errorsOf(s([{ do: "character.teleport", to: "$nowhere" }])).join()).toMatch(/unknown var \$nowhere/);
  });
  it("session mode/players mismatch", () => {
    expect(errorsOf({ name: "x", session: { mode: "play", players: 2 }, steps: [{ lua: "return 1" }] }).length).toBeGreaterThan(0);
    expect(errorsOf({ name: "x", session: { mode: "edit" }, steps: [{ do: "input.key", code: "E" }] }).join()).toMatch(/edit mode/);
  });
  it("YAML syntax errors carry a line", () => {
    const v = validateInput("name: x\nsteps:\n  - { do: character.jump\n", catalog);
    expect(v.ok).toBe(false);
    expect(v.errors[0]!.message).toMatch(/YAML/);
  });
  it("diagnostics carry line numbers for YAML input", () => {
    const v = validateInput("name: x\nsession: { players: 1 }\nsteps:\n  - { do: character.jump }\n  - { do: nope.nope }\n", catalog);
    expect(v.errors[0]).toMatchObject({ path: "steps[1].do", line: 5 });
  });
  it("game.* hooks are errors once a running game reported its catalog", () => {
    const c = Catalog.load();
    c.setLive("n_9", "server", [{ name: "game.reset", kind: "action", contexts: ["server"], default: "server", summary: "", actor: "none", params: { type: "object" }, source: "hook" }]);
    expect(validateInput(BLUE_TEAM, c).errors.join()).toBeTruthy();
    expect(validateInput(BLUE_TEAM, c).errors[0]!.message).toMatch(/unknown game hook "game.requestSpawn"/);
    c.setLive("n_9", "server", [{ name: "game.requestSpawn", kind: "action", contexts: ["server"], default: "server", summary: "", actor: "optional", params: { type: "object", additionalProperties: true }, source: "hook" }]);
    expect(validateInput(BLUE_TEAM, c).ok).toBe(true);
  });
});
