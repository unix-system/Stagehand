import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Daemon } from "../../src/daemon.js";
import { FakeStudio, type FakeStudioOptions } from "./fakeStudio.js";

export const GAME_ENTRIES = [
  { name: "game.requestSpawn", kind: "action", contexts: ["server"], default: "server", summary: "spawn", actor: "optional", params: { type: "object", additionalProperties: true }, source: "hook" },
  { name: "game.reset", kind: "action", contexts: ["server"], default: "server", summary: "reset", actor: "none", params: { type: "object", additionalProperties: true }, source: "hook" },
];

export interface Harness {
  daemon: Daemon;
  studio: FakeStudio;
  root: string;
  close: () => Promise<void>;
}

export async function startHarness(
  studioOpts: Partial<FakeStudioOptions> = {},
  daemonOpts: { idleTimeoutMs?: number; launchTimeoutMs?: number; startStudio?: boolean } = {},
): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "stagehand-test-"));
  const daemon = new Daemon({
    root,
    port: 0,
    log: () => {},
    registry: { pollTimeoutMs: 300, expiryMs: 500, sweepMs: 50 },
    sessions: { launchTimeoutMs: daemonOpts.launchTimeoutMs ?? 3000, idleTimeoutMs: daemonOpts.idleTimeoutMs ?? 0, endTimeoutMs: 1000 },
    settleMs: 40,
    cancelGraceMs: 500,
    catalogTimeoutMs: 1000,
  });
  const port = await daemon.start();
  const studio = new FakeStudio(`http://127.0.0.1:${port}`, {
    impl: () => ({ status: "passed" }),
    gameEntries: GAME_ENTRIES,
    ...studioOpts,
  });
  if (daemonOpts.startStudio !== false) await studio.start();
  return {
    daemon,
    studio,
    root,
    close: async () => {
      await studio.stop();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
