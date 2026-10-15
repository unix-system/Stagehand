import { describe, expect, it } from "vitest";
import { cliRun, renderTable, waitForEditNode } from "../src/cli/run.js";
import { BLUE_TEAM } from "./fixtures.js";
import { startHarness } from "./helpers/harness.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, o: (s: string) => out.push(s), e: (s: string) => err.push(s) };
}

describe("cli run", () => {
  it("runs saved tests and exits 0 when all pass", async () => {
    const h = await startHarness();
    try {
      await h.daemon.tests.save("blue-team-gun-hostile", BLUE_TEAM);
      const c = capture();
      const code = await cliRun(h.daemon, { names: ["blue-team-gun-hostile"], waitForStudioMs: 2000, out: c.o, err: c.e });
      expect(code).toBe(0);
      const text = c.out.join("\n");
      expect(text).toContain("| blue-team-gun-hostile | PASS |");
      expect(text).toContain("1/1 passed");
      expect(text).toContain("report: ");
      expect(c.err.some((l) => l.includes("edit node"))).toBe(true);
      expect(h.studio.ends.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it("exits 1 when a test fails and reports the failing step", async () => {
    const h = await startHarness({ impl: () => ({ status: "failed", reason: "nope" }) });
    try {
      await h.daemon.tests.save("blue-team-gun-hostile", BLUE_TEAM);
      const c = capture();
      const code = await cliRun(h.daemon, { names: ["blue-team-gun-hostile"], waitForStudioMs: 2000, json: true, out: c.o, err: c.e });
      expect(code).toBe(1);
      const doc = JSON.parse(c.out.join("\n"));
      expect(doc.total).toBe(1);
      expect(doc.passed).toBe(0);
      expect(doc.rows[0].status).toBe("failed");
      expect(doc.rows[0].failure).toContain("nope");
    } finally {
      await h.close();
    }
  });

  it("exits 2 on an unknown test without waiting for Studio", async () => {
    const h = await startHarness({}, { startStudio: false });
    try {
      const c = capture();
      const t0 = Date.now();
      const code = await cliRun(h.daemon, { names: ["does-not-exist"], waitForStudioMs: 5000, out: c.o, err: c.e });
      expect(code).toBe(2);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(c.err.join("\n")).toContain('no saved test "does-not-exist"');
    } finally {
      await h.close();
    }
  });

  it("waitForEditNode resolves on attach and rejects on timeout", async () => {
    const h = await startHarness({}, { startStudio: false });
    try {
      await expect(waitForEditNode(h.daemon.registry, 100)).rejects.toMatchObject({ code: "SESSION_ERROR" });
      const p = waitForEditNode(h.daemon.registry, 3000);
      await h.studio.start();
      const node = await p;
      expect(node.role).toBe("edit");
      expect((await waitForEditNode(h.daemon.registry, 10)).nodeId).toBe(node.nodeId);
    } finally {
      await h.close();
    }
  });

  it("renders a summary table", () => {
    const t = renderTable([
      { name: "a", status: "passed", runId: "r1", durationMs: 12, failure: null, dir: "/x" },
      { name: "b", status: "failed", runId: "r2", durationMs: 12_345, failure: "s3 boom | bang", dir: "/y" },
    ]);
    expect(t).toContain("| a | PASS | 12ms |  |");
    expect(t).toContain("| b | FAILED | 12.3s | s3 boom \\| bang |");
    expect(t).toContain("1/2 passed");
  });
});
