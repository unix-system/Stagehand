import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerServer } from "../src/broker/http.js";
import { NodeRegistry, type RegistryEvent } from "../src/broker/nodes.js";
import { FakeNode, NO_REPLY, waitFor } from "./helpers/fakeNode.js";

let registry: NodeRegistry;
let broker: BrokerServer;
let base: string;
const nodes: FakeNode[] = [];

function node(opts: ConstructorParameters<typeof FakeNode>[1]): FakeNode {
  const n = new FakeNode(base, opts);
  nodes.push(n);
  return n;
}

beforeEach(async () => {
  registry = new NodeRegistry({ pollTimeoutMs: 300, expiryMs: 400, sweepMs: 50 });
  broker = new BrokerServer({ registry, port: 0 });
  const port = await broker.listen();
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.stop()));
  registry.close();
  await broker.close();
});

describe("broker over HTTP", () => {
  it("health lists attached nodes", async () => {
    const n = node({ role: "edit" });
    await n.attach();
    const h = (await (await fetch(`${base}/v1/health`)).json()) as any;
    expect(h).toMatchObject({ ok: true, version: "0.1.0", nodes: [{ nodeId: n.nodeId, role: "edit", sessionId: null, orphan: false }] });
    expect(typeof h.uptimeMs).toBe("number");
  });

  it("attach returns ids, timings and rejects a protocol mismatch / bad body", async () => {
    const n = node({ role: "edit" });
    const r = await n.attach();
    expect(r).toEqual({ nodeId: "n_1", playerIndex: null, pollTimeoutMs: 300, eventFlushMs: 50, brokerVersion: "0.1.0" });
    const bad = node({ role: "edit", protocolVersion: 2 });
    await expect(bad.attach()).rejects.toThrow(/400/);
    const raw = await fetch(`${base}/v1/attach`, { method: "POST", body: "{nope", headers: { "Content-Type": "application/json" } });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as any).error.code).toBe("BAD_REQUEST");
  });

  it("two edit nodes with placeId 0 but distinct instanceIds do not evict each other", async () => {
    const a = node({ role: "edit", placeId: 0, instanceId: "a" });
    const b = node({ role: "edit", placeId: 0, instanceId: "b" });
    await a.attach();
    await b.attach();
    expect(registry.list().map((n) => n.nodeId).sort()).toEqual([a.nodeId, b.nodeId].sort());
    const again = node({ role: "edit", placeId: 0, instanceId: "a" });
    await again.attach();
    expect(registry.list().map((n) => n.nodeId).sort()).toEqual([again.nodeId, b.nodeId].sort());
    // a reloaded plugin (new instanceId) wins over its not-yet-expired predecessor
    const reloaded = node({ role: "edit", placeId: 0, instanceId: "c" });
    await reloaded.attach();
    expect(registry.findEdit(0)?.nodeId).toBe(reloaded.nodeId);
  });

  it("listen() falls back to the next port of the range when the first is taken", async () => {
    const taken = broker.port; // bound in beforeEach
    const second = new BrokerServer({ registry: new NodeRegistry({ sweepMs: 50 }), port: taken });
    const port = await second.listen();
    try {
      expect(port).not.toBe(taken);
      expect(port).toBeGreaterThan(taken);
      expect(port).toBeLessThan(taken + 10);
      const h = (await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()) as any;
      expect(h.port).toBe(port);
    } finally {
      await second.close();
    }
  });

  it("findEdit prefers the --place Studio (id or name substring), else the newest edit node", async () => {
    const staging = node({ role: "edit", placeId: 111, placeName: "Staging", instanceId: "s" });
    const lobby = node({ role: "edit", placeId: 222, placeName: "Lobby Place", instanceId: "l" });
    await staging.attach();
    await lobby.attach();
    expect(registry.findEdit()?.nodeId).toBe(lobby.nodeId);
    registry.setPreferredPlace("staging");
    expect(registry.findEdit()?.nodeId).toBe(staging.nodeId);
    registry.setPreferredPlace("222");
    expect(registry.findEdit()?.nodeId).toBe(lobby.nodeId);
    registry.setPreferredPlace("nope");
    expect(registry.findEdit()?.nodeId).toBe(lobby.nodeId);
    registry.setPreferredPlace("111");
    expect(registry.edits().map((e) => [e.placeName, e.selected])).toEqual([
      ["Lobby Place", false],
      ["Staging", true],
    ]);
  });

  it("long-poll returns 204 after the poll timeout", async () => {
    const n = node({ role: "edit" });
    await n.attach();
    const t0 = Date.now();
    const r = await n.poll();
    expect(r.status).toBe(204);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it("delivers a command to a waiting poll and correlates the result", async () => {
    const n = node({ role: "edit" });
    await n.attach();
    const pollP = n.poll();
    const sendP = registry.send(n.nodeId, "ping", {}, { timeoutMs: 1000 });
    const r = await pollP;
    expect(r.status).toBe(200);
    expect(r.command).toMatchObject({ type: "ping", params: {} });
    expect(r.command.id).toMatch(/^c_\d+$/);
    expect((await n.result(r.command.id, true, { pong: true, t: 1 })).body).toEqual({ ok: true });
    await expect(sendP).resolves.toEqual({ pong: true, t: 1 });
  });

  it("queues commands sent before the poll arrives", async () => {
    const n = node({ role: "edit" });
    await n.attach();
    const sendP = registry.send(n.nodeId, "catalog", {}, { timeoutMs: 1000 });
    const r = await n.poll();
    expect(r.command.type).toBe("catalog");
    await n.result(r.command.id, true, { entries: [] });
    await expect(sendP).resolves.toEqual({ entries: [] });
  });

  it("ok:false results reject with the node's error object", async () => {
    const n = node({ role: "edit" });
    await n.attach();
    const sendP = registry.send(n.nodeId, "eval", { code: "x(" }, { timeoutMs: 1000 }).then(() => null, (e) => e);
    const r = await n.poll();
    await n.result(r.command.id, false, { code: "LUA_ERROR", message: "syntax" });
    expect(await sendP).toMatchObject({ code: "LUA_ERROR", message: "syntax" });
  });

  it("unknown commandId -> 404, unknown node -> 410 on poll/result/events", async () => {
    const n = node({ role: "edit" });
    await n.attach();
    expect((await n.result("c_999", true, {})).status).toBe(404);
    const ghost = node({ role: "edit" });
    ghost.nodeId = "n_404";
    expect((await ghost.poll()).status).toBe(410);
    const ev = await ghost.events([{ type: "log", level: "info", message: "x" }]);
    expect(ev.status).toBe(410);
    expect(ev.body.error.code).toBe("UNKNOWN_NODE");
    expect((await ghost.result("c_1", true, {})).status).toBe(410);
  });

  it("times out commands the node never answers (daemon timeout)", async () => {
    const n = node({ role: "server", sessionId: "s_1", handlers: { run_segment: () => NO_REPLY } });
    await n.attach();
    n.start();
    const t0 = Date.now();
    await expect(registry.send(n.nodeId, "run_segment", { steps: [] }, { timeoutMs: 200 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
  });

  it("aborting a queued command withdraws it; cancel/ping bypass per-type serialization", async () => {
    const n = node({ role: "server", sessionId: "s_1", manual: true });
    await n.attach();
    n.start();
    const first = registry.send(n.nodeId, "eval", { code: "return 1" }, { timeoutMs: 5000 });
    const c1 = await n.waitForCommand((c) => c.type === "eval");
    const ctrl = new AbortController();
    const second = registry.send(n.nodeId, "eval", { code: "return 2" }, { timeoutMs: 5000, signal: ctrl.signal, abortQueuedOnly: true });
    const pingP = registry.send(n.nodeId, "ping", {}, { timeoutMs: 5000 });
    const pc = await n.waitForCommand((c) => c.type === "ping");
    expect(n.received.filter((c) => c.type === "eval")).toHaveLength(1);
    ctrl.abort();
    await expect(second).rejects.toMatchObject({ code: "CANCELLED" });
    await n.result(pc.id, true, {});
    await expect(pingP).resolves.toEqual({});
    await n.result(c1.id, true, { value: 1, logs: [] });
    await expect(first).resolves.toMatchObject({ value: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(n.received.filter((c) => c.type === "eval")).toHaveLength(1);
  });

  it("?wait=0 answers at once: 204 when idle, the command when one is queued", async () => {
    const n = node({ role: "server", sessionId: "s_1" });
    await n.attach();
    const url = (w: string) => `${n.base}/v1/poll?node=${n.nodeId}&wait=${w}`;
    const t0 = Date.now();
    expect((await fetch(url("0"))).status).toBe(204);
    expect(Date.now() - t0).toBeLessThan(150);
    const sendP = registry.send(n.nodeId, "catalog", {}, { timeoutMs: 1000 });
    const r = await fetch(url("0"));
    expect(r.status).toBe(200);
    const cmd = ((await r.json()) as any).command;
    expect(cmd.type).toBe("catalog");
    await n.result(cmd.id, true, { entries: [] });
    await expect(sendP).resolves.toEqual({ entries: [] });
    expect((await fetch(url("abc"))).status).toBe(400);
  });

  it("delivers several run_segments to one node at once (parallel branches on the same node)", async () => {
    const n = node({ role: "client", sessionId: "s_1", manual: true });
    await n.attach();
    n.start();
    const a = registry.send(n.nodeId, "run_segment", { segmentId: "seg_1" }, { timeoutMs: 5000 });
    const b = registry.send(n.nodeId, "run_segment", { segmentId: "seg_2" }, { timeoutMs: 5000 });
    const ca = await n.waitForCommand((c) => c.type === "run_segment" && c.params.segmentId === "seg_1");
    const cb = await n.waitForCommand((c) => c.type === "run_segment" && c.params.segmentId === "seg_2");
    await n.result(cb.id, true, { segmentId: "seg_2", status: "passed", steps: [] });
    await n.result(ca.id, true, { segmentId: "seg_1", status: "passed", steps: [] });
    await expect(a).resolves.toMatchObject({ segmentId: "seg_1" });
    await expect(b).resolves.toMatchObject({ segmentId: "seg_2" });
  });

  it("events are acked, de-duplicated by seq and forwarded", async () => {
    const seen: RegistryEvent[] = [];
    registry.on((e) => seen.push(e));
    const n = node({ role: "server", sessionId: "s_1" });
    await n.attach();
    const r = await n.events([
      { type: "node.ready", role: "server", catalogHash: "deadbeef" },
      { type: "log", level: "warn", message: "hi", node: n.nodeId, stepId: null },
    ]);
    expect(r.body).toEqual({ ack: 2 });
    const dup = await n.post("/v1/events", { node: n.nodeId, events: [{ seq: 2, type: "log", t: 1, level: "warn", message: "dup" }] });
    expect(dup.body).toEqual({ ack: 2 });
    const evs = seen.filter((e) => e.kind === "event").map((e) => (e as any).event.type);
    expect(evs).toEqual(["node.ready", "log"]);
    expect(registry.get(n.nodeId)!.catalogHash).toBe("deadbeef");
  });

  it("assigns playerIndex in attach order and renumbers on session.ready", async () => {
    const server = node({ role: "server", sessionId: "s_1" });
    await server.attach();
    const c2 = node({ role: "client", sessionId: "s_1", userId: -2, playerName: "Player2" });
    const c1 = node({ role: "client", sessionId: "s_1", userId: -1, playerName: "Player1" });
    expect((await c2.attach()).playerIndex).toBe(1);
    expect((await c1.attach()).playerIndex).toBe(2);
    await server.events([{ type: "session.ready", sessionId: "s_1", players: [{ name: "Player1", userId: -1 }, { name: "Player2", userId: -2 }] }]);
    expect(registry.get(c1.nodeId)!.playerIndex).toBe(1);
    expect(registry.get(c2.nodeId)!.playerIndex).toBe(2);
    expect(registry.findClient("s_1", 1)!.nodeId).toBe(c1.nodeId);
    // A client attaching after session.ready gets its confirmed index straight away.
    const late = node({ role: "client", sessionId: "s_1", userId: -1, playerName: "Player1" });
    expect((await late.attach()).playerIndex).toBe(1);
  });

  it("re-attach replaces the node, keeps playerIndex and cancels its queued commands", async () => {
    const c = node({ role: "client", sessionId: "s_1", userId: -1 });
    await c.attach();
    const old = c.nodeId;
    const pending = registry.send(old, "ping", {}, { timeoutMs: 5000 }).then(() => null, (e) => e);
    const again = node({ role: "client", sessionId: "s_1", userId: -1 });
    const r = await again.attach();
    expect(r.playerIndex).toBe(1);
    expect(r.nodeId).not.toBe(old);
    expect(await pending).toMatchObject({ code: "SESSION_ERROR", message: expect.stringMatching(/replaced by re-attach/) });
    expect((await c.poll()).status).toBe(410);
  });

  it("marks server/client nodes without a sessionId as orphans", async () => {
    const o = node({ role: "server", sessionId: null });
    await o.attach();
    expect(registry.get(o.nodeId)!.orphan).toBe(true);
    expect(registry.findServer("s_1")).toBeUndefined();
  });

  it("drops nodes that stop polling; a fake node re-attaches after 410", async () => {
    const detached: string[] = [];
    registry.on((e) => e.kind === "detached" && detached.push(e.node.nodeId));
    const n = node({ role: "edit" });
    await n.attach();
    const first = n.nodeId;
    await waitFor(() => detached.includes(first), 2000, "expiry");
    expect(registry.has(first)).toBe(false);
    n.start(); // poll -> 410 -> re-attach
    await waitFor(() => n.nodeId !== first && registry.has(n.nodeId), 2000, "re-attach");
    // and it stays alive while polling
    await new Promise((r) => setTimeout(r, 600));
    expect(registry.has(n.nodeId)).toBe(true);
  });
});
