import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../src/engine/types.js";
import { waitFor } from "./helpers/fakeNode.js";
import type { StepImpl } from "./helpers/fakeStudio.js";
import { type Harness, startHarness } from "./helpers/harness.js";
import { BLUE_TEAM, NIGHT_MODE, TWO_PLAYER } from "./fixtures.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** Simulated game for the blue-team example. */
function blueWorld(opts: { hostileBroken?: boolean; errorOnEquip?: boolean } = {}): StepImpl {
  return (step, ctx) => {
    const w = ctx.studio.world;
    switch (step.name) {
      case "player.setTeam":
        w.team = step.params.team;
        return { status: "passed" };
      case "character.teleport":
        w.pos = step.params.to;
        return { status: "passed" };
      case "character.equipTool":
        w.equipped = step.params.tool;
        return opts.errorOnEquip
          ? { status: "passed", logs: [{ level: "error", message: "Gun: attempt to index nil with 'Ammo'" }] }
          : { status: "passed" };
      case "instance.hasTag": {
        const hostile = w.equipped === "Gun" && !opts.hostileBroken;
        if (hostile) return { status: "passed", delayMs: 20 };
        return {
          status: "failed",
          delayMs: 30,
          reason: "condition instance.hasTag not true within 2s",
          expected: { target: "Workspace.Player1", tag: "Hostile", value: true },
          actual: { value: false, tags: [w.team] },
        };
      }
      case "character.unequip":
        w.equipped = null;
        return { status: "passed" };
      default:
        return { status: "passed" };
    }
  };
}

function files(dir: string) {
  return {
    events: readFileSync(path.join(dir, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as RunEvent),
    result: JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")),
    summary: readFileSync(path.join(dir, "summary.md"), "utf8"),
  };
}

describe("runner: blue-team example end to end", () => {
  it("pushes progress snapshots to the edit node and every client, ending with the final status", async () => {
    h = await startHarness({ impl: blueWorld() });
    const r = await h.daemon.runs.start({ input: BLUE_TEAM }).done;
    await waitFor(() => h!.studio.progress.some((p) => p.status === "passed"));
    await waitFor(() => h!.studio.clientProgress.some((p) => p.playerIndex === 1 && p.snapshot.status === "passed"));
    const last = h.studio.progress.at(-1);
    expect(last).toMatchObject({ runId: r.runId, status: "passed", total: r.steps.length, finished: r.steps.length });
    expect(last.steps[0]).toMatchObject({ id: r.steps[0]!.id, target: r.steps[0]!.target, status: "passed", verb: "do", soft: false, timeoutMs: 10000 });
    expect(typeof last.steps[0].durationMs).toBe("number");
    expect(last.steps[0].elapsedMs).toBeUndefined();
    // while a step runs its snapshot carries elapsedMs for the live counter
    const running = h.studio.progress.flatMap((p) => p.steps as any[]).find((s) => s.status === "running");
    if (running) expect(typeof running.elapsedMs).toBe("number");
  });

  it("produces a passing report", async () => {
    h = await startHarness({ impl: blueWorld() });
    const run = h.daemon.runs.start({ input: BLUE_TEAM });
    const seen: string[] = [];
    run.on((ev) => seen.push(ev.type));
    const r = await run.done;
    expect(r.status, JSON.stringify(r.failure)).toBe("passed");
    expect(r.runId).toMatch(/^r_\d{8}T\d{6}_blue-team-gun-hostile$/);
    expect(r.counts).toMatchObject({ passed: 7, failed: 0, skipped: 0 });
    expect(r.session).toMatchObject({ mode: "play", players: 1, reused: false });
    expect(r.failure).toBeNull();
    // One merged server segment for steps + one for teardown.
    const segs = h.studio.segments.filter((s) => s.params.runId === r.runId);
    expect(segs.map((s) => [s.role, s.params.steps.length])).toEqual([["server", 6], ["server", 1]]);
    const teleport = segs[0]!.params.steps[3];
    expect(teleport).toEqual({
      id: "steps.3",
      verb: "do",
      name: "character.teleport",
      params: { to: [120, 5, -40] },
      timeoutMs: 10000,
      withinMs: null,
      soft: false,
      actor: { name: "p1", playerIndex: 1 },
      label: null,
      save: null,
    });
    expect(segs[0]!.params.steps[5]).toMatchObject({ id: "steps.5", withinMs: 2000 });
    expect(h.studio.world.equipped).toBeNull(); // teardown ran
    // Report files.
    const f = files(r.dir);
    expect(f.result.status).toBe("passed");
    expect(f.events[0]!.type).toBe("run.started");
    expect(f.events.at(-1)!.type).toBe("run.finished");
    expect(f.events.filter((e) => e.type === "step.passed").map((e) => e.stepId)).toContain("steps.5");
    expect(f.summary).toMatch(/# blue-team-gun-hostile: PASSED/);
    expect(seen).toContain("session.ready");
    // The runs store finds it.
    expect((await h.daemon.runsStore.get(r.runId))!.status).toBe("passed");
    expect((await h.daemon.runsStore.latest())!.runId).toBe(r.runId);
  });

  it("produces a failing report with expected/actual captured", async () => {
    h = await startHarness({ impl: blueWorld({ hostileBroken: true }) });
    const r = await h.daemon.runs.start({ input: BLUE_TEAM }).done;
    expect(r.status).toBe("failed");
    expect(r.failure).toMatchObject({
      step: "steps.5",
      phase: "steps",
      reason: "condition instance.hasTag not true within 2s",
      expected: { target: "Workspace.Player1", tag: "Hostile", value: true },
      actual: { value: false, tags: ["Blue"] },
      error: { code: "ASSERTION_FAILED" },
    });
    expect(r.failure!.node).toMatch(/^n_/);
    const byId = Object.fromEntries(r.steps.map((s) => [s.id, s.status]));
    expect(byId).toMatchObject({ "steps.4": "passed", "steps.5": "failed", "teardown.0": "passed" });
    const f = files(r.dir);
    expect(f.result.failure.expected).toEqual({ target: "Workspace.Player1", tag: "Hostile", value: true });
    expect(f.summary).toMatch(/FAILED/);
    expect(f.summary).toMatch(/"tags": \[\n\s+"Blue"/);
    expect(f.events.some((e) => e.type === "step.failed" && e.stepId === "steps.5" && (e.actual as any).value === false)).toBe(true);
  });

  it("keeps the failure reason when the step.failed event trails the result (relayed client events)", async () => {
    h = await startHarness({ impl: blueWorld({ hostileBroken: true }), eventsAfterResultMs: 600 });
    const run = h.daemon.runs.start({ input: BLUE_TEAM });
    const r = await run.done;
    expect(r.status).toBe("failed");
    expect(r.failure).toMatchObject({
      step: "steps.5",
      reason: "condition instance.hasTag not true within 2s",
      expected: { target: "Workspace.Player1", tag: "Hostile", value: true },
      actual: { value: false, tags: ["Blue"] },
    });
    const failedEvents = run.events.filter((e) => e.type === "step.failed" && e.stepId === "steps.5");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({ reason: "condition instance.hasTag not true within 2s", actual: { value: false } });
    expect(r.failure!.reason).not.toBe("step failed");
  });

  it("a plugin without result details: waits for the event, and never prints a bare 'step failed' with an error present", async () => {
    h = await startHarness({ impl: blueWorld({ hostileBroken: true }), bareResults: true, eventsAfterResultMs: 100 });
    const r = await h.daemon.runs.start({ input: BLUE_TEAM }).done;
    expect(r.status).toBe("failed");
    expect(r.failure!.reason).toBe("condition instance.hasTag not true within 2s");
  });

  it("markdown report: lua values and vars are shown, action failures have no null Expected/Actual block", async () => {
    h = await startHarness({
      impl: (step) =>
        step.verb === "lua"
          ? { status: "passed", value: step.params.code === "return 1" ? 1 : { lamps: 3, names: ["a", "b"] } }
          : step.name === "character.jump"
            ? { status: "failed", reason: "no humanoid", code: "ACTION_ERROR" }
            : { status: "passed" },
    });
    const r = await h.daemon.runs.start({
      input: {
        name: "values",
        session: { players: 1 },
        steps: [{ lua: "return lamps()", label: "count lamps" }, { lua: "return 1", save: "one" }, { do: "character.jump" }, { do: "player.respawn" }],
      },
    }).done;
    expect(r.status).toBe("failed");
    const md = files(r.dir).summary;
    expect(md).toMatch(/count lamps \| server \| PASS → \{"lamps":3,"names":\["a","b"\]\}/);
    expect(md).toMatch(/## Vars\n\n- `one` = 1/);
    expect(md).toMatch(/\*\*Reason:\*\* no humanoid/);
    expect(md).not.toMatch(/Expected:/);
    expect(md).not.toMatch(/Actual:/);
    expect(r.steps[0]!.value).toEqual({ lamps: 3, names: ["a", "b"] });
  });

  it("hints: an instant expect that failed suggests within:, an unset server attribute suggests on: client", async () => {
    h = await startHarness({
      impl: (step) =>
        step.name === "player.attribute"
          ? { status: "failed", reason: "condition player.attribute is false", code: "ASSERTION_FAILED", expected: { name: "MenuOpen", value: true }, actual: { set: false } }
          : step.name === "character.alive"
            ? { status: "failed", reason: "condition character.alive is false", code: "ASSERTION_FAILED", actual: { alive: false } }
            : { status: "passed" },
    });
    const a = await h.daemon.runs.start({ input: { name: "hint-a", session: { players: 1 }, steps: [{ expect: "player.attribute", name: "MenuOpen", value: true }] } }).done;
    expect(a.failure!.hint).toMatch(/not set on the server.*on: client/);
    expect(files(a.dir).summary).toMatch(/\*\*Hint:\*\* the attribute is not set on the server/);
    const b = await h.daemon.runs.start({ input: { name: "hint-b", session: { players: 1 }, steps: [{ expect: "character.alive" }] } }).done;
    expect(b.failure!.hint).toMatch(/within: 2s/);
    const c = await h.daemon.runs.start({ input: { name: "hint-c", session: { players: 1 }, steps: [{ expect: "character.alive", within: "100ms" }] } }).done;
    expect(c.failure!.hint).toBeUndefined();
  });

  it("markdown report: a spec that never ran has no step table; a long skipped tail collapses", async () => {
    h = await startHarness({ impl: (step) => (step.name === "character.jump" ? { status: "failed", reason: "nope" } : { status: "passed" }) });
    const bad = await h.daemon.runs.start({ input: { name: "bad", session: { players: 1 }, steps: [{ do: "nope.nothing" }, { do: "character.jump" }] } }).done;
    expect(bad.status).toBe("error");
    expect(files(bad.dir).summary).not.toMatch(/## Steps/);
    const steps = [{ do: "character.jump" }, ...Array.from({ length: 5 }, () => ({ do: "player.respawn" }))];
    const r = await h.daemon.runs.start({ input: { name: "tail", session: { players: 1 }, steps } }).done;
    const md = files(r.dir).summary;
    expect(md).toMatch(/\| … \| 5 more step\(s\) not run \(aborted\) \|/);
    expect(md).not.toMatch(/steps\.3/);
  });

  it("failOnError attributes an error log to the active step and still tears down", async () => {
    h = await startHarness({ impl: blueWorld({ errorOnEquip: true }) });
    const r = await h.daemon.runs.start({ input: BLUE_TEAM }).done;
    expect(r.status).toBe("failed");
    expect(r.failure!.step).toBe("steps.4");
    expect(r.failure!.reason).toMatch(/failOnError.*attempt to index nil/);
    expect(r.failure!.logsAround.map((l) => l.message).join()).toMatch(/Ammo/);
    expect(r.steps.find((s) => s.id === "teardown.0")!.status).toBe("passed");
    expect(r.logCounts.error).toBe(1);
  });

  it("failOnError: false ignores error logs", async () => {
    h = await startHarness({ impl: blueWorld({ errorOnEquip: true }) });
    const r = await h.daemon.runs.start({ input: BLUE_TEAM.replace("tags: [smoke, combat]", "tags: [smoke, combat]\nfailOnError: false") }).done;
    expect(r.status).toBe("passed");
  });

  it("reuses the session on a second run and runs setup once", async () => {
    h = await startHarness({ impl: blueWorld() });
    const spec = BLUE_TEAM.replace("steps:\n", "setup:\n  - { do: player.setTeam, as: p1, team: Red }\nsteps:\n");
    const a = await h.daemon.runs.start({ input: spec }).done;
    const b = await h.daemon.runs.start({ input: spec }).done;
    expect([a.status, b.status]).toEqual(["passed", "passed"]);
    expect(b.session).toMatchObject({ reused: true, sessionId: a.session!.sessionId });
    expect(h.studio.launches).toHaveLength(1);
    expect(a.steps.find((s) => s.id === "setup.0")!.status).toBe("passed");
    expect(b.steps.find((s) => s.id === "setup.0")).toMatchObject({ status: "skipped", skipReason: expect.stringMatching(/reused/) });
  });
});

describe("runner: control flow", () => {
  it("runs the two-player example with each + parallel", async () => {
    h = await startHarness();
    const r = await h.daemon.runs.start({ input: TWO_PLAYER }).done;
    expect(r.status, JSON.stringify(r.failure)).toBe("passed");
    expect(r.counts.passed).toBe(14);
    const segs = h.studio.segments.filter((s) => s.params.runId === r.runId);
    expect(segs.map((s) => `${s.role}${s.playerIndex ?? ""}:${s.params.steps.length}`).sort()).toEqual(
      ["server:8", "server:2", "client2:1", "server:2", "client2:1"].sort(),
    );
    // Every run_segment carries the full actor map, so @red.character resolves on any node.
    for (const seg of segs) expect(seg.params.actors).toEqual({ p1: 1, p2: 2, blue: 1, red: 2 });
  });

  it("a failing parallel branch cancels the other branch", async () => {
    h = await startHarness({
      impl: (step) =>
        step.name === "character.jump"
          ? { status: "failed", reason: "no humanoid", delayMs: 50 }
          : step.name === "input.move"
            ? { status: "passed", delayMs: 3000 }
            : { status: "passed" },
    });
    const t0 = Date.now();
    const r = await h.daemon.runs.start({ input: TWO_PLAYER }).done;
    expect(r.status).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(2500);
    const s = Object.fromEntries(r.steps.map((x) => [x.id, x.status]));
    expect(s).toMatchObject({
      "steps.3.parallel.0.0": "failed",
      "steps.3.parallel.0.1": "skipped",
      "steps.3.parallel.1.0": "cancelled",
      "steps.4": "skipped",
    });
    expect(h.studio.client(2)!.received.some((c) => c.type === "cancel")).toBe(true);
    // The node reported step.failed{CANCELLED} for the daemon-initiated cancel: recorded as cancelled, not failed.
    expect(r.failure?.step).toBe("steps.3.parallel.0.0");
  });

  it("night-mode: lua save, expect lua, daemon-side log.noErrors", async () => {
    h = await startHarness({ impl: (step) => (step.verb === "lua" ? { status: "passed", value: 3 } : { status: "passed" }) });
    const r = await h.daemon.runs.start({ input: NIGHT_MODE }).done;
    expect(r.status, JSON.stringify(r.failure)).toBe("passed");
    expect(r.vars.lit).toBe(3);
    expect(r.steps.find((s) => s.id === "steps.6")).toMatchObject({ status: "passed", target: "daemon" });
    expect(h.studio.segments.some((s) => s.params.steps.some((x: any) => x.name === "log.noErrors"))).toBe(false);
  });

  it("log.noErrors fails when an error was logged (failOnError off)", async () => {
    h = await startHarness({
      impl: (step) => (step.verb === "lua" ? { status: "passed", value: 1, logs: [{ level: "error", message: "lamp script crashed" }] } : { status: "passed" }),
    });
    const r = await h.daemon.runs.start({ input: NIGHT_MODE.replace("tags: [smoke]", "tags: [smoke]\nfailOnError: false") }).done;
    expect(r.status).toBe("failed");
    expect(r.failure).toMatchObject({ step: "steps.6", expected: { errors: 0 }, actual: { errors: 1 } });
  });

  it("if: skips steps whose var is falsy and runs truthy ones; saved vars flow to later segments", async () => {
    h = await startHarness({ impl: (step) => (step.verb === "lua" ? { status: "passed", value: step.params.code === "return 0" ? 0 : "Workspace.Clone" } : { status: "passed" }) });
    const spec = {
      name: "if-test",
      session: { players: 0 },
      steps: [
        { lua: "return 0", save: "zero" },
        { lua: "return 'x'", save: "path" },
        { do: "instance.destroy", target: "$path", if: "$zero" },
        { do: "instance.destroy", target: "$path", if: "$path" },
      ],
    };
    const r = await h.daemon.runs.start({ input: spec }).done;
    expect(r.status, JSON.stringify(r.failure)).toBe("passed");
    expect(r.steps.find((s) => s.id === "steps.2")).toMatchObject({ status: "skipped", skipReason: "if" });
    expect(r.steps.find((s) => s.id === "steps.3")!.status).toBe("passed");
    const destroy = h.studio.segments.find((s) => s.params.steps[0].id === "steps.3")!;
    expect(destroy.params.steps[0].params.target).toBe("Workspace.Clone");
  });

  it("soft failures are recorded without failing the run", async () => {
    h = await startHarness({ impl: (step) => (step.name === "character.jump" ? { status: "failed", reason: "nope" } : { status: "passed" }) });
    const r = await h.daemon.runs.start({ input: { name: "soft", session: { players: 1 }, steps: [{ do: "character.jump", soft: true }, { do: "player.respawn" }] } }).done;
    expect(r.status).toBe("passed");
    expect(r.softFailures).toEqual(["steps.0"]);
    expect(r.steps[1]!.status).toBe("passed");
  });

  it("enforces the run timeout, cancels the in-flight segment and still tears down", async () => {
    h = await startHarness({ impl: (step) => (step.name === "session.wait" ? { status: "passed", delayMs: 5000 } : { status: "passed" }) });
    const spec = { name: "slow", timeout: "400ms", session: { players: 0 }, steps: [{ do: "session.wait", duration: "5s" }], teardown: [{ lua: "return 1" }] };
    const r = await h.daemon.runs.start({ input: spec }).done;
    expect(r.status).toBe("failed");
    expect(r.failure).toMatchObject({ step: "steps.0", error: { code: "TIMEOUT" } });
    expect(r.steps.find((s) => s.id === "teardown.0")!.status).toBe("passed");
    expect(h.studio.server()!.received.some((c) => c.type === "cancel" && c.params.segmentId === "seg_1")).toBe(true);
  });

  it("cancel_run cancels mid-step; teardown runs", async () => {
    h = await startHarness({ impl: (step) => (step.name === "session.wait" ? { status: "passed", delayMs: 5000 } : { status: "passed" }) });
    const run = h.daemon.runs.start({ input: { name: "cancel-me", session: { players: 0 }, steps: [{ do: "session.wait", duration: "5s" }, { lua: "return 2" }], teardown: [{ lua: "return 1" }] } });
    run.on((ev) => {
      if (ev.type === "step.started" && ev.stepId === "steps.0") run.cancel();
    });
    const r = await run.done;
    expect(r.status).toBe("cancelled");
    expect(r.steps.map((s) => s.status)).toEqual(["cancelled", "skipped", "passed"]);
  });

  it("daemon-side timeout when a node never answers", async () => {
    h = await startHarness({ impl: () => new Promise(() => {}) as never });
    const spec = { name: "hang", session: { players: 0 }, steps: [{ lua: "return 1", timeout: "100ms" }] };
    const r = await h.daemon.runs.start({ input: spec }).done;
    expect(r.status).toBe("failed");
    expect(r.failure).toMatchObject({ step: "steps.0", error: { code: "TIMEOUT" } });
  }, 10000);

  it("invalid specs finish immediately with status error", async () => {
    h = await startHarness();
    const r = await h.daemon.runs.start({ input: "name: bad\nsteps:\n  - { do: nope.nope }\n" }).done;
    expect(r.status).toBe("error");
    expect(r.errors[0]!.message).toMatch(/unknown action/);
    expect(existsSync(path.join(r.dir, "summary.md"))).toBe(true);
    expect(h.studio.launches).toHaveLength(0);
  });

  it("an unknown game hook is reported after the session starts", async () => {
    h = await startHarness({ gameEntries: [] });
    const r = await h.daemon.runs.start({ input: BLUE_TEAM }).done;
    expect(r.status).toBe("error");
    expect(r.errors.map((e) => e.message).join()).toMatch(/unknown game hook "game.requestSpawn"/);
  });

  it("session.ended from the edit node fails the in-flight step with SESSION_ERROR and clears the session", async () => {
    h = await startHarness({ impl: (step) => (step.name === "session.wait" ? { status: "passed", delayMs: 5000 } : { status: "passed" }) });
    const run = h.daemon.runs.start({ input: { name: "ended-mid-run", session: { players: 0 }, steps: [{ do: "session.wait", duration: "5s" }] } });
    run.on((ev) => {
      if (ev.type === "step.started" && ev.stepId === "steps.0") {
        const sid = h!.daemon.sessions.current()!.sessionId;
        void h!.studio.edit.events([{ type: "session.ended", sessionId: sid, ok: true, reason: "ended in Studio", result: "stopped by hand", elapsedMs: 12_000 }]);
      }
    });
    const r = await run.done;
    expect(r.status).toBe("failed");
    expect(r.steps[0]).toMatchObject({ id: "steps.0", status: "failed" });
    expect(r.failure?.reason).toMatch(/session ended \(ended in Studio \(after 12s; Execute\*Async returned "stopped by hand"\): the test was ended outside this daemon/);
    expect(h.daemon.sessions.current()).toBeNull();
    expect(h.daemon.sessions.list().at(-1)!.state).toBe("ended");
  });

  it("session errors finish the run with status error", async () => {
    h = await startHarness({}, { startStudio: false });
    const r = await h.daemon.runs.start({ input: BLUE_TEAM }).done;
    expect(r.status).toBe("error");
    expect(r.failure!.error!.code).toBe("SESSION_ERROR");
  });

  it("edit-mode runs target the edit node", async () => {
    h = await startHarness();
    const r = await h.daemon.runs.start({ input: { name: "edit-run", session: { mode: "edit" }, steps: [{ do: "instance.set", target: "Lighting", prop: "ClockTime", value: 3 }] } }).done;
    expect(r.status).toBe("passed");
    expect(h.studio.segments[0]!.role).toBe("edit");
  });
});
