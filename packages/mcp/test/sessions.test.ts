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
    expect(r).toEqual({ ended: true, via: "RunService.Stop", sessionId: a.sessionId });
    expect(h.studio.ends.map((e) => e.role)).toEqual(["server", "edit"]);
    expect(sm.current()).toBeNull();
    expect(sm.list()[0]).toMatchObject({ sessionId: a.sessionId, state: "ended" });
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
