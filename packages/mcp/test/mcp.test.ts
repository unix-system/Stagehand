import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/index.js";
import { BLUE_TEAM } from "./fixtures.js";
import { type Harness, startHarness } from "./helpers/harness.js";

let h: Harness | null = null;
let client: Client | null = null;
afterEach(async () => {
  await client?.close();
  client = null;
  await h?.close();
  h = null;
});

async function connect(studio: Parameters<typeof startHarness>[0] = {}) {
  h = await startHarness(studio);
  const server = createMcpServer(h.daemon);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

function textOf(r: any): string {
  return r.content.map((c: any) => c.text).join("\n");
}

describe("MCP surface", () => {
  it("lists every tool, resource and the prompt", async () => {
    const c = await connect();
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      ["cancel_run", "delete_test", "eval_lua", "get_run", "get_test", "inspect", "list_actions", "list_tests", "run_steps", "run_suite", "run_test", "save_test", "stagehand_status", "start_session", "stop_session", "tail_run", "validate_test"].sort(),
    );
    for (const t of (await c.listTools()).tools) expect((t.description ?? "").length, t.name).toBeGreaterThan(40);
    const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(["write_playtest"]);
    const p = await c.getPrompt({ name: "write_playtest", arguments: { goal: "jumping works" } });
    expect((p.messages[0]!.content as any).text).toMatch(/validate_test/);
    const cat = await c.readResource({ uri: "stagehand://catalog" });
    expect(JSON.parse((cat.contents[0] as any).text).entries.length).toBeGreaterThan(40);
  });

  it("status, list_actions, validate_test", async () => {
    const c = await connect();
    const st = JSON.parse(textOf(await c.callTool({ name: "stagehand_status", arguments: {} })));
    expect(st.nodes[0].role).toBe("edit");
    expect(st.broker.listening).toBe(true);
    const la = textOf(await c.callTool({ name: "list_actions", arguments: { namespace: "character" } }));
    expect(la).toMatch(/character\.teleport \[action\] \(server\*\|client\) needs-as \{to: Vector3 \[x,y,z\] \| CFrame \{pos, look\} \| selector\}/);
    const one = JSON.parse(textOf(await c.callTool({ name: "list_actions", arguments: { name: "gui.click" } })));
    expect(one.default).toBe("client");
    const v = JSON.parse(textOf(await c.callTool({ name: "validate_test", arguments: { spec: BLUE_TEAM } })));
    expect(v.valid).toBe(true);
    expect(v.plan.join("\n")).toMatch(/seg_1 -> server: steps\.0, steps\.1/);
    const bad = JSON.parse(textOf(await c.callTool({ name: "validate_test", arguments: { spec: { name: "x", steps: [{ do: "character.teleport" }] } } })));
    expect(bad.valid).toBe(false);
    expect(bad.errors[0].message).toMatch(/missing required param "to"/);
  });

  it("tests store round trip and resources", async () => {
    const c = await connect();
    const saved = JSON.parse(textOf(await c.callTool({ name: "save_test", arguments: { name: "blue-team-gun-hostile", spec: BLUE_TEAM } })));
    expect(saved.saved).toBe(true);
    expect(saved.file).toMatch(/playtests[\\/]blue-team-gun-hostile\.playtest\.yaml$/);
    const mismatch = await c.callTool({ name: "save_test", arguments: { name: "other", spec: BLUE_TEAM } });
    expect(mismatch.isError).toBe(true);
    const list = JSON.parse(textOf(await c.callTool({ name: "list_tests", arguments: {} })));
    expect(list.tests).toEqual([{ name: "blue-team-gun-hostile", description: "Blue spawn → equip gun → Hostile tag appears", tags: ["smoke", "combat"] }]);
    expect(textOf(await c.callTool({ name: "get_test", arguments: { name: "blue-team-gun-hostile" } }))).toContain("character.equipTool");
    const res = await c.listResources();
    expect(res.resources.map((r) => r.uri)).toContain("stagehand://tests/blue-team-gun-hostile");
    const rr = await c.readResource({ uri: "stagehand://tests/blue-team-gun-hostile" });
    expect((rr.contents[0] as any).text).toBe(BLUE_TEAM);
    expect(JSON.parse(textOf(await c.callTool({ name: "delete_test", arguments: { name: "blue-team-gun-hostile" } }))).deleted).toBe(true);
  });

  it("run_steps streams progress and returns a report; get_run / tail_run / runs/latest", async () => {
    const c = await connect();
    const progress: string[] = [];
    const r = await c.callTool(
      { name: "run_steps", arguments: { steps: "- { do: player.setTeam, team: Blue }\n- { expect: player.onTeam, team: Blue }", session: { players: 1 } } },
      undefined,
      { onprogress: (p) => progress.push(String(p.message)) },
    );
    const txt = textOf(r);
    expect(txt).toMatch(/# adhoc: PASSED/);
    expect(progress.some((m) => /steps\.1 PASS/.test(m))).toBe(true);
    const runId = /runId: (\S+)/.exec(txt)![1]!;
    expect(textOf(await c.callTool({ name: "get_run", arguments: { runId: "latest" } }))).toContain(runId);
    const tail = JSON.parse(textOf(await c.callTool({ name: "tail_run", arguments: { runId, afterSeq: 0, limit: 3 } })));
    expect(tail).toMatchObject({ runId, status: "passed", done: true, more: true, lastSeq: 3 });
    const latest = await c.readResource({ uri: "stagehand://runs/latest" });
    expect(JSON.parse((latest.contents[0] as any).text).runId).toBe(runId);
  });

  it("run_test + run_suite on saved tests", async () => {
    const c = await connect();
    await c.callTool({ name: "save_test", arguments: { name: "blue-team-gun-hostile", spec: BLUE_TEAM } });
    await c.callTool({ name: "save_test", arguments: { name: "zero", spec: "name: zero\ntags: [smoke]\nsession: { players: 0 }\nsteps:\n  - { lua: \"return 1\" }\n" } });
    const one = textOf(await c.callTool({ name: "run_test", arguments: { name: "zero" } }));
    expect(one).toMatch(/PASSED/);
    const suite = textOf(await c.callTool({ name: "run_suite", arguments: { tag: "smoke" } }));
    expect(suite).toMatch(/Suite: 2\/2 passed/);
    const missing = await c.callTool({ name: "run_test", arguments: { name: "nope" } });
    expect(missing.isError).toBe(true);
  });

  it("eval_lua is gated by --allow-eval; inspect goes to the edit node", async () => {
    const c = await connect();
    const ev = await c.callTool({ name: "eval_lua", arguments: { code: "return 1" } });
    expect(ev.isError).toBe(true);
    expect(textOf(ev)).toMatch(/EVAL_DISABLED/);
    h!.studio.edit.handlers.inspect = (p: any) => ({ nodes: [{ path: p.path, className: "DataModel", name: "game", attributes: {}, tags: [] }], truncated: false });
    const ins = JSON.parse(textOf(await c.callTool({ name: "inspect", arguments: { path: "ReplicatedStorage" } })));
    expect(ins).toMatchObject({ node: { role: "edit" }, nodes: [{ path: "ReplicatedStorage" }], truncated: false });
    const cmd = h!.studio.edit.received.find((x) => x.type === "inspect")!;
    expect(cmd.params).toEqual({ path: "ReplicatedStorage", depth: 1, limit: 200 });
  });

  it("start_session / stop_session", async () => {
    const c = await connect();
    const s = JSON.parse(textOf(await c.callTool({ name: "start_session", arguments: { players: 2 } })));
    expect(s).toMatchObject({ mode: "multiplayer", players: 2, reused: false });
    const s2 = JSON.parse(textOf(await c.callTool({ name: "start_session", arguments: { players: 2 } })));
    expect(s2).toMatchObject({ sessionId: s.sessionId, reused: true });
    const stop = JSON.parse(textOf(await c.callTool({ name: "stop_session", arguments: {} })));
    expect(stop).toMatchObject({ ended: true, via: "EndTest", sessionId: s.sessionId });
  });
});
