import { afterEach, describe, expect, it } from "vitest";
import { normalizeSession } from "../src/engine/compile.js";
import { FakeNode, waitFor } from "./helpers/fakeNode.js";
import { type Harness, startHarness } from "./helpers/harness.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const cfg = (players: number, reset: "respawn" | "hook" | "none" = "respawn", reuse = true) =>
  normalizeSession({ players, reset, reuse });

describe("session manager", () => {
  it("launches via the edit node and waits for server, clients and session.ready", async () => {
    h = await startHarness();
    const sm = h.daemon.sessions;
    const progress: string[] = [];
    const handle = await sm.ensure(cfg(2), { onProgress: (m) => progress.push(m) });
    expect(handle).toMatchObject({ mode: "multiplayer", players: 2, reused: false });
    expect(h.studio.launches).toEqual([{ sessionId: handle.sessionId, mode: "multiplayer", players: 2 }]);
    expect(sm.current()!.state).toBe("ready");
    expect(sm.current()!.sessionPlayers.map((p) => p.userId)).toEqual([-1, -2]);
    expect(h.daemon.registry.findServer(handle.sessionId!)).toBeTruthy();
    expect(h.daemon.registry.findClient(handle.sessionId!, 2)!.userId).toBe(-2);
    expect(progress.join("\n")).toMatch(/launching multiplayer/);
    expect(h.daemon.broker.health().sessions).toEqual([{ sessionId: handle.sessionId, mode: "multiplayer", players: 2, state: "ready" }]);
  });

  it("ends a stray Studio test (orphan server node) before launching", async () => {
    h = await startHarness();
    const ended: unknown[] = [];
    const stray = new FakeNode(h.studio.base, { role: "server", handlers: { end_session: (p) => (ended.push(p), { ended: true, via: "EndTest" }) } });
    await stray.attach();
    const strayId = stray.nodeId;
    stray.start();
    try {
      const handle = await h.daemon.sessions.ensure(cfg(1));
      expect(ended).toEqual([{ sessionId: null }]);
      expect(h.daemon.registry.has(strayId)).toBe(false);
      expect(h.studio.launches).toEqual([{ sessionId: handle.sessionId, mode: "play", players: 1 }]);
    } finally {
      await stray.stop();
    }
  });

  it("renumbers clients that attached out of order (server-confirmed)", async () => {
    h = await startHarness({ reverseClientAttach: true });
    const handle = await h.daemon.sessions.ensure(cfg(3));
    for (const i of [1, 2, 3]) expect(h.daemon.registry.findClient(handle.sessionId!, i)!.userId).toBe(-i);
  });

  it("reuses a matching session and applies reset: respawn", async () => {
    h = await startHarness();
    const sm = h.daemon.sessions;
    const a = await sm.ensure(cfg(1));
    const b = await sm.ensure(cfg(1));
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.reused).toBe(true);
    expect(h.studio.launches).toHaveLength(1);
    const reset = h.studio.segments.find((s) => s.params.segmentId.startsWith("reset_"))!;
    expect(reset.role).toBe("server");
    expect(reset.params.steps.map((s: any) => [s.name, s.actor])).toEqual([
      ["player.respawn", { name: "p1", playerIndex: 1 }],
      ["character.loaded", { name: "p1", playerIndex: 1 }],
    ]);
  });

  it("reset: hook calls game.reset; reset: none sends nothing", async () => {
    h = await startHarness();
    const sm = h.daemon.sessions;
    await sm.ensure(cfg(1, "none"));
    await sm.ensure(cfg(1, "none"));
    expect(h.studio.segments).toHaveLength(0);
    await sm.ensure(cfg(1, "hook"));
    expect(h.studio.segments[0]!.params.steps.map((s: any) => s.name)).toEqual(["game.reset"]);
  });

  it("relaunches when the config differs or reuse is false (ending the old session via the server)", async () => {
    h = await startHarness();
    const sm = h.daemon.sessions;
    const a = await sm.ensure(cfg(1));
    const b = await sm.ensure(cfg(2));
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(h.studio.ends[0]).toMatchObject({ role: "server", params: { sessionId: a.sessionId } });
    expect(h.daemon.registry.sessionNodes(a.sessionId!)).toHaveLength(0);
    const c = await sm.ensure(cfg(2, "respawn", false));
    expect(c.sessionId).not.toBe(b.sessionId);
    expect(h.studio.launches).toHaveLength(3);
  });

  it("falls back to the edit node when end_session on the server fails", async () => {
    h = await startHarness({ serverEndFails: true });
    const sm = h.daemon.sessions;
    const a = await sm.ensure(cfg(1));
    const r = await sm.end("test");
    expect(r).toEqual({ ended: true, via: "RunService.Stop", sessionId: a.sessionId, studioStopped: true });
    expect(h.studio.ends.map((e) => e.role)).toEqual(["server", "edit"]);
    expect(sm.current()).toBeNull();
    expect(sm.list()[0]).toMatchObject({ sessionId: a.sessionId, state: "ended" });
  });

  it("end() waits for Studio's session.ended (bounded) so a launch right after does not race", async () => {
    h = await startHarness();
    const sm = h.daemon.sessions;
    const a = await sm.ensure(cfg(1));
    const r = await sm.end("test");
    expect(r).toMatchObject({ ended: true, via: "EndTest", studioStopped: true });
    expect(h.studio.launcher.current).toBeNull();
    const b = await sm.ensure(cfg(1));
    expect(b.sessionId).not.toBe(a.sessionId);
    // without session.ended the wait is bounded and reported
    await h.close();
    h = await startHarness({ noSessionEnded: true }, { sessionEndWaitMs: 150 });
    const c = await h.daemon.sessions.ensure(cfg(1));
    const t0 = Date.now();
    const r2 = await h.daemon.sessions.end("test");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(r2).toMatchObject({ ended: true, via: "EndTest", sessionId: c.sessionId, studioStopped: false });
  });

  it("the edit fallback is honest for a Play test it cannot stop; stop_session explains instead of pretending", async () => {
    h = await startHarness({ serverEndFails: true, editEndRefuses: true });
    const sm = h.daemon.sessions;
    const a = await sm.ensure(cfg(1));
    const r = await sm.end("test");
    expect(r).toMatchObject({ ended: false, via: null, sessionId: a.sessionId, studioStopped: false, hint: expect.stringMatching(/RunService:Stop\(\) cannot end/) });
    expect(sm.current()).toBeNull();
  });

  it("launch waits for our own test to finish ending and retries once; another daemon's test is refused", async () => {
    h = await startHarness();
    const sm = h.daemon.sessions;
    // Studio still tearing down a session we launched earlier (it will report session.ended in 200ms)
    h.studio.launcher.current = { sessionId: "s_OLD", mode: "play", players: 1, port: h.studio.port };
    setTimeout(() => {
      h!.studio.launcher.current = null;
      void h!.studio.edit.events([{ type: "session.ended", sessionId: "s_OLD", ok: true, reason: "ended in Studio" }]);
    }, 200);
    const a = await sm.ensure(cfg(1));
    expect(a.mode).toBe("play");
    expect(h.studio.launches).toHaveLength(1);
    await sm.end("test");
    h.studio.launcher.current = { sessionId: "s_OTHER", mode: "play", players: 1, port: h.studio.port + 1 };
    await expect(sm.ensure(cfg(1))).rejects.toMatchObject({ code: "SESSION_ERROR", message: expect.stringMatching(/for the daemon on port/) });
  });

  it("stopOwn ends a test we launched but lost track of when its server node is attached; otherwise it says what to do", async () => {
    h = await startHarness();
    const sm = h.daemon.sessions;
    const a = await sm.ensure(cfg(1));
    // The daemon forgets the session (as after a detached server node) while Studio keeps running it.
    (sm as unknown as { session: unknown }).session = null;
    (sm as unknown as { ended: unknown[] }).ended.push({ sessionId: a.sessionId, state: "ended" });
    const r = await sm.stopOwn();
    expect(r).toMatchObject({ ended: true, via: "EndTest", sessionId: a.sessionId, strays: 1 });
    expect(h.studio.launcher.current).toBeNull();
    await waitFor(() => h!.daemon.registry.list().every((n) => n.role === "edit"), 2000, "session nodes gone");
    // Studio runs our test but no server node is attached: cannot be ended from here.
    h.studio.launcher.current = { sessionId: "s_LOST", mode: "play", players: 1, port: h.studio.port };
    const r2 = await sm.stopOwn();
    expect(r2).toMatchObject({ ended: false, sessionId: "s_LOST", hint: expect.stringMatching(/no server node.*Stop in Studio/) });
    // Someone else's test: nothing to do without force.
    h.studio.launcher.current = { sessionId: "s_THEIRS", mode: "play", players: 1, port: h.studio.port + 1 };
    expect(await sm.stopOwn()).toMatchObject({ ended: false, sessionId: null });
  });

  it("ends idle sessions after the idle timeout", async () => {
    h = await startHarness({}, { idleTimeoutMs: 200 });
    const sm = h.daemon.sessions;
    const a = await sm.ensure(cfg(0));
    expect(a.mode).toBe("run");
    await sm.release(a, true);
    await waitFor(() => sm.current() === null, 2000, "idle end");
    expect(h.studio.ends[0]!.params.sessionId).toBe(a.sessionId);
  });

  it("release with reuse=false ends immediately", async () => {
    h = await startHarness();
    const sm = h.daemon.sessions;
    const a = await sm.ensure(cfg(1, "respawn", false));
    await sm.release(a, false, "passed");
    expect(h.studio.ends[0]!.params).toEqual({ sessionId: a.sessionId, result: "passed" });
    expect(sm.current()).toBeNull();
  });

  it("fails with SESSION_ERROR when session.ready never arrives", async () => {
    h = await startHarness({ noSessionReady: true }, { launchTimeoutMs: 400 });
    await expect(h.daemon.sessions.ensure(cfg(1))).rejects.toMatchObject({ code: "SESSION_ERROR", message: expect.stringMatching(/no session.ready/) });
    expect(h.daemon.sessions.current()).toBeNull();
  });

  it("fails fast when Studio never starts an accepted launch, and the next launch is not blocked", async () => {
    h = await startHarness({ launchesNeverStart: 1, editEndRefuses: true }, { launchTimeoutMs: 3000, startTimeoutMs: 300 });
    const sm = h.daemon.sessions;
    const progress: string[] = [];
    const t0 = Date.now();
    await expect(sm.ensure(cfg(1), { onProgress: (m) => progress.push(m) })).rejects.toMatchObject({
      code: "SESSION_ERROR",
      message: expect.stringMatching(/did not start test session .* within 0.3s \(no server node attached\)/),
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(progress.some((m) => /still waiting for Studio to start/.test(m))).toBe(true);
    // the edit node was told to forget the launch, so the Launcher does not refuse the next one
    expect(h.studio.ends).toEqual([{ role: "edit", params: { sessionId: h.studio.launches[0].sessionId, abandon: true } }]);
    expect(h.studio.launcher.current).toBeNull();
    const b = await sm.ensure(cfg(1));
    expect(b.sessionId).toBe(h.studio.launches[1].sessionId);
  });

  it("the start bound does not apply once the server node attached", async () => {
    h = await startHarness({ noSessionReady: true }, { launchTimeoutMs: 600, startTimeoutMs: 100 });
    await expect(h.daemon.sessions.ensure(cfg(1))).rejects.toMatchObject({ message: expect.stringMatching(/not ready after 0.6s: no session.ready/) });
    // a server node was attached, so it is ended via EndTest rather than abandoned on the edit node
    expect(h.studio.ends.map((e) => e.role)).toEqual(["server"]);
  });

  it("fails with SESSION_ERROR without an edit node or when launch is refused", async () => {
    h = await startHarness({}, { startStudio: false });
    await expect(h.daemon.sessions.ensure(cfg(1))).rejects.toMatchObject({ code: "SESSION_ERROR", message: expect.stringMatching(/no Studio edit node/) });
    await h.close();
    h = await startHarness({ launchFails: true });
    await expect(h.daemon.sessions.ensure(cfg(1))).rejects.toMatchObject({ code: "SESSION_ERROR", message: expect.stringMatching(/refused/) });
    // a refused launch (Studio busy with another daemon's test) must not stop that test via the edit node
    expect(h.studio.ends).toEqual([]);
    expect(h.daemon.sessions.current()).toBeNull();
  });

  it("edit mode needs only the edit node", async () => {
    h = await startHarness();
    const r = await h.daemon.sessions.ensure(normalizeSession({ mode: "edit" }));
    expect(r).toMatchObject({ sessionId: null, mode: "edit", placeId: 1234 });
    expect(h.studio.launches).toHaveLength(0);
  });

  it("marks the session ended when its server node goes away", async () => {
    h = await startHarness();
    const sm = h.daemon.sessions;
    await sm.ensure(cfg(1));
    await h.studio.killSession();
    await waitFor(() => sm.current() === null, 3000, "session lost");
    expect(sm.list()[0]!.state).toBe("ended");
  });

  it("cancels a launch when aborted", async () => {
    h = await startHarness({ noSessionReady: true }, { launchTimeoutMs: 5000 });
    const ctrl = new AbortController();
    const p = h.daemon.sessions.ensure(cfg(1), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
