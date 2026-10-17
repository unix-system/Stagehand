// Run-level types shared by the runner, reporter and MCP layer.
import type { Actor, ErrorObject } from "../broker/protocol.js";
import type { Diagnostic } from "../spec/types.js";
import type { Phase } from "./plan.js";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "error";
export type StepRecordStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cancelled";

export interface RunEvent {
  seq: number;
  type: string;
  /** ms since run start */
  t: number;
  [k: string]: unknown;
}

export interface LogRecord {
  t: number;
  level: "info" | "warn" | "error";
  message: string;
  nodeId: string;
  role: string;
  stepId: string | null;
}

export interface StepRecord {
  id: string;
  phase: Phase;
  display: string;
  verb: string;
  name: string | null;
  label: string | null;
  actor: Actor | null;
  target: string;
  nodeId: string | null;
  soft: boolean;
  /** Step budget (ms) as compiled; `expect` without `within` is instant (withinMs null). */
  timeoutMs: number;
  withinMs: number | null;
  status: StepRecordStatus;
  durationMs: number | null;
  startedAt: number | null;
  value?: unknown;
  reason?: string;
  expected?: unknown;
  actual?: unknown;
  error?: ErrorObject;
  /** One-line suggestion for the author, derived by the daemon from the failure shape. */
  hint?: string;
  skipReason?: string;
}

export interface FailureInfo {
  step: string | null;
  display: string | null;
  phase: Phase | null;
  reason: string;
  expected?: unknown;
  actual?: unknown;
  error?: ErrorObject;
  hint?: string;
  node: string | null;
  logsAround: LogRecord[];
}

export interface RunResult {
  runId: string;
  name: string;
  status: Exclude<RunStatus, "queued" | "running">;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dir: string;
  session: { sessionId: string | null; mode: string; players: number; reused: boolean } | null;
  counts: Record<"passed" | "failed" | "skipped" | "cancelled" | "pending", number>;
  failure: FailureInfo | null;
  /** Soft failures (recorded, did not abort). */
  softFailures: string[];
  steps: StepRecord[];
  vars: Record<string, unknown>;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  logCounts: { info: number; warn: number; error: number };
}

/** Snapshot of a run that is still going (same shape, live status, no finishedAt). */
export interface PartialRunResult extends Omit<RunResult, "status" | "finishedAt"> {
  status: RunStatus;
  finishedAt: string | null;
}
