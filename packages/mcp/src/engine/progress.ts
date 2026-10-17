// Pushes a compact step list to the edit node and every client node of the session for the
// "Stagehand Progress" widget in each Studio window (`progress` command, docs/protocol.md).
// Fire-and-forget, coalesced to one send per interval.
import type { NodeRegistry } from "../broker/nodes.js";
import type { Run } from "./run.js";

export const PROGRESS_INTERVAL_MS = 150;

export function pushProgress(run: Run, registry: NodeRegistry, intervalMs = PROGRESS_INTERVAL_MS): void {
  let ready = false;
  let sessionId: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  const send = () => {
    timer = null;
    if (!ready) return;
    const targets = [registry.findEdit(), ...(sessionId ? registry.clients(sessionId) : [])].filter((n) => n != null);
    const now = Date.now();
    const steps = run.stepRecords().map((r) => ({
      id: r.id,
      display: r.label ?? r.display,
      target: r.target,
      status: r.status,
      verb: r.verb,
      soft: r.soft,
      timeoutMs: r.timeoutMs,
      ...(r.reason ? { reason: r.reason } : {}),
      // The widget counts on from elapsedMs with its own clock, so no clock sync is needed.
      ...(r.status === "running" && r.startedAt != null ? { elapsedMs: now - r.startedAt } : {}),
      ...(r.durationMs != null ? { durationMs: r.durationMs } : {}),
    }));
    const snapshot = { runId: run.id, name: run.name, status: run.status, total: run.totalSteps, finished: run.finishedSteps, steps };
    for (const n of targets) registry.send(n.nodeId, "progress", snapshot, { timeoutMs: 5_000 }).catch(() => {});
  };

  const off = run.on((ev) => {
    if (ev.type === "session.ready") {
      ready = true;
      sessionId = (ev.sessionId as string | null) ?? null;
    }
    if (ev.type === "run.finished") {
      if (timer) clearTimeout(timer);
      send();
      off();
      return;
    }
    if (ready && !timer && (ev.type === "session.ready" || ev.type.startsWith("step."))) timer = setTimeout(send, intervalMs);
  });
}
