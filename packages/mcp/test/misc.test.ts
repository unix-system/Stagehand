import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateLogCondition, luaPatternToRegExp } from "../src/engine/logs.js";
import { validateInput } from "../src/engine/validate.js";
import { Catalog } from "../src/spec/catalog.js";
import { collectVarRefs, isTruthy, parseDuration, substituteVars, varRefName } from "../src/spec/values.js";
import { RunsStore } from "../src/store/runs.js";
import { TestsStore } from "../src/store/tests.js";

const catalog = Catalog.load();

describe("values", () => {
  it("parses durations to ms", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("10s")).toBe(10000);
    expect(parseDuration("1.5m")).toBe(90000);
    expect(parseDuration(2)).toBe(2000);
    expect(parseDuration(0.25)).toBe(250);
    expect(() => parseDuration("10")).toThrow();
    expect(() => parseDuration("1h")).toThrow();
    expect(() => parseDuration(-1)).toThrow();
  });
  it("handles var refs and truthiness", () => {
    expect(varRefName("$spawn")).toBe("spawn");
    expect(varRefName("$1")).toBeNull();
    expect(varRefName("x $a")).toBeNull();
    expect(substituteVars({ a: "$x", b: ["$y", "$z"], c: "lit $x" }, { x: 1, y: [1, 2, 3] })).toEqual({ a: 1, b: [[1, 2, 3], "$z"], c: "lit $x" });
    expect([...collectVarRefs({ a: ["$x", { b: "$y" }] })]).toEqual(["x", "y"]);
    expect([null, undefined, false, 0, ""].map(isTruthy)).toEqual([false, false, false, false, false]);
    expect([1, "0", [], {}, true].map(isTruthy)).toEqual([true, true, true, true, true]);
  });
});

describe("log conditions", () => {
  it("converts Lua patterns", () => {
    expect(luaPatternToRegExp("^Round %d+ started$").test("Round 12 started")).toBe(true);
    expect(luaPatternToRegExp("no ammo").test("Gun: no ammo")).toBe(true);
    expect(luaPatternToRegExp("a.-b").exec("axxbyyb")![0]).toBe("axxb");
    expect(luaPatternToRegExp("%a+%s*=%s*%d").test("x = 1")).toBe(true);
    expect(luaPatternToRegExp("[%w_]+%.lua").test("my_mod.lua")).toBe(true);
    expect(luaPatternToRegExp("(x)|{y}").test("(x)|{y}")).toBe(false);
    expect(luaPatternToRegExp("%(x%)").test("(x)")).toBe(true);
  });
  it("evaluates log.matches and log.noErrors", () => {
    const logs = [
      { t: 1, level: "info" as const, message: "Round 3 started", nodeId: "n", role: "server", stepId: null },
      { t: 2, level: "warn" as const, message: "Gun: no ammo", nodeId: "n", role: "client#1", stepId: null },
    ];
    expect(evaluateLogCondition("log.matches", { pattern: "Round %d" }, logs).ok).toBe(true);
    expect(evaluateLogCondition("log.matches", { pattern: "ammo", level: "error" }, logs).ok).toBe(false);
    expect(evaluateLogCondition("log.noErrors", {}, logs).ok).toBe(true);
  });
});

describe("examples", () => {
  it("every example playtest validates (with the shared example fragments)", async () => {
    const dir = path.resolve(import.meta.dirname, "../../../examples");
    const store = new TestsStore(dir);
    const fragments = await store.fragmentMap();
    expect(Object.keys(fragments)).toContain("spawn-and-check");
    const tests = await store.list();
    expect(tests.length).toBeGreaterThanOrEqual(5);
    for (const t of tests) {
      const text = (await store.get(t.name))!.text;
      const v = validateInput(text, catalog, { expectName: t.name, sharedFragments: fragments });
      expect(v.errors, `${t.name}: ${JSON.stringify(v.errors)}`).toEqual([]);
      // examples are the reference: no unlabeled lua steps
      expect(v.warnings.filter((w) => /no label/.test(w.message)), t.name).toEqual([]);
    }
  });
});

describe("stores", () => {
  it("lists shared fragments and skips the _shared folder when listing tests", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stagehand-store-"));
    try {
      const t = new TestsStore(root);
      await mkdir(t.sharedDir, { recursive: true });
      await writeFile(path.join(t.sharedDir, "login.fragment.yaml"), "description: log in\nsteps:\n  - { lua: 'return 1', label: one }\n", "utf8");
      await writeFile(path.join(t.sharedDir, "bad.fragment.yaml"), "name: other\nsteps: []\n", "utf8");
      await writeFile(path.join(t.sharedDir, "not-a-test.playtest.yaml"), "name: not-a-test\nsteps: [{ lua: 'return 1' }]\n", "utf8");
      expect(await t.list()).toEqual([]);
      const frags = await t.fragments();
      expect(frags.map((f) => [f.name, f.parseError === null, f.steps.length])).toEqual([
        ["bad", false, 0],
        ["login", true, 1],
      ]);
      expect(Object.keys(await t.fragmentMap())).toEqual(["login"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("saves, lists, reads and deletes tests; allocates run dirs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stagehand-store-"));
    try {
      const t = new TestsStore(root);
      expect(await t.list()).toEqual([]);
      await t.save("a-test", { name: "a-test", tags: ["x"], steps: [{ lua: "return 1" }] });
      const got = await t.get("a-test");
      expect(got!.text).toMatch(/name: a-test/);
      expect((await t.list())[0]).toMatchObject({ name: "a-test", tags: ["x"] });
      await expect(t.save("Bad Name", "x")).rejects.toThrow(/invalid test name/);
      expect(await t.delete("a-test")).toBe(true);
      expect(await t.delete("a-test")).toBe(false);
      const runs = new RunsStore(root);
      const now = new Date("2026-10-15T15:01:02Z");
      const a = runs.allocate("demo", now);
      const b = runs.allocate("demo", now);
      expect(a.runId).toBe("r_20261015T150102_demo");
      expect(path.basename(a.dir)).toBe("20261015T150102-demo");
      expect(b.runId).toBe("r_20261015T150102_demo-2");
      expect(await runs.latest()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
