// Wire types for the broker <-> node protocol (docs/protocol.md, v1).
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const BROKER_VERSION = "0.1.0";
export const DEFAULT_PORT = 38491;
export const POLL_TIMEOUT_MS = 25_000;
export const EVENT_FLUSH_MS = 50;
export const DAEMON_TIMEOUT_SLACK_MS = 2_000;
export const NODE_EXPIRY_MS = 60_000;

export type Role = "edit" | "server" | "client";
export type Context = Role;

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNKNOWN_NODE"
  | "UNKNOWN_COMMAND"
  | "UNKNOWN_ACTION"
  | "BAD_PARAMS"
  | "RESOLVE_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "ACTION_ERROR"
  | "ASSERTION_FAILED"
  | "LUA_ERROR"
  | "SESSION_ERROR"
  | "EVAL_DISABLED"
  | "INTERNAL";

export interface ErrorObject {
  code: ErrorCode | string;
  message: string;
  stepId?: string;
  details?: unknown;
}

/** Error carrying a protocol ErrorObject. */
export class StagehandError extends Error {
  readonly code: ErrorCode | string;
  readonly details?: unknown;
  readonly stepId?: string;
  constructor(code: ErrorCode | string, message: string, details?: unknown, stepId?: string) {
    super(message);
    this.name = "StagehandError";
    this.code = code;
    this.details = details;
    this.stepId = stepId;
  }
  toObject(): ErrorObject {
    const o: ErrorObject = { code: this.code, message: this.message };
    if (this.stepId !== undefined) o.stepId = this.stepId;
    if (this.details !== undefined) o.details = this.details;
    return o;
  }
  static from(e: unknown): StagehandError {
    if (e instanceof StagehandError) return e;
    if (e && typeof e === "object" && "code" in e && "message" in e) {
      const o = e as ErrorObject;
      return new StagehandError(String(o.code), String(o.message), o.details, o.stepId);
    }
    return new StagehandError("INTERNAL", e instanceof Error ? e.message : String(e));
  }
}

export const attachRequestSchema = z.object({
  protocolVersion: z.number(),
  role: z.enum(["edit", "server", "client"]),
  placeId: z.number().int(),
  placeName: z.string(),
  sessionId: z.string().nullable().optional().transform((v) => v ?? null),
  playerName: z.string().nullable().optional().transform((v) => v ?? null),
  userId: z.number().int().nullable().optional().transform((v) => v ?? null),
  playerIndex: z.null().optional(),
  pluginVersion: z.string(),
  transport: z.enum(["http", "remote"]).optional().default("http"),
});
export type AttachRequest = z.infer<typeof attachRequestSchema>;

export interface AttachResponse {
  nodeId: string;
  playerIndex: number | null;
  pollTimeoutMs: number;
  eventFlushMs: number;
  brokerVersion: string;
}

export const errorObjectSchema = z.object({
  code: z.string(),
  message: z.string(),
  stepId: z.string().optional(),
  details: z.unknown().optional(),
});

export const resultRequestSchema = z.object({
  node: z.string(),
  commandId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: errorObjectSchema.optional(),
});
export type ResultRequest = z.infer<typeof resultRequestSchema>;

export const nodeEventSchema = z
  .object({
    seq: z.number().int(),
    type: z.string(),
    t: z.number(),
  })
  .passthrough();

export const eventsRequestSchema = z.object({
  node: z.string(),
  events: z.array(nodeEventSchema),
});

/** An event as posted by a node (extra fields depend on `type`). */
export interface NodeEvent {
  seq: number;
  type: string;
  t: number;
  runId?: string;
  segmentId?: string;
  stepId?: string | null;
  [k: string]: unknown;
}

export type CommandType =
  | "run_segment"
  | "cancel"
  | "catalog"
  | "inspect"
  | "eval"
  | "launch_session"
  | "end_session"
  | "add_players"
  | "ping";

export interface Command {
  id: string;
  type: CommandType;
  params: unknown;
}

export interface Actor {
  name: string;
  playerIndex: number;
}

export type Verb = "do" | "wait" | "expect" | "lua";

/** A step as sent inside run_segment. */
export interface WireStep {
  id: string;
  verb: Verb;
  name: string | null;
  params: Record<string, unknown>;
  timeoutMs: number;
  withinMs: number | null;
  soft: boolean;
  actor: Actor | null;
  label: string | null;
  save: string | null;
  /** Optional on the wire; the daemon evaluates `if:` itself and never sends it (nodes honour it if present). */
  if?: string;
}

export interface RunSegmentParams {
  runId: string;
  segmentId: string;
  vars: Record<string, unknown>;
  /** Full actor map (name -> playerIndex: p1..pN plus aliases), sent on every run_segment. */
  actors: Record<string, number>;
  steps: WireStep[];
}

export type StepStatus = "passed" | "failed" | "skipped" | "cancelled";

export interface SegmentStepResult {
  id: string;
  status: StepStatus;
  durationMs: number;
  value?: unknown;
}

export interface RunSegmentResult {
  segmentId: string;
  status: "passed" | "failed" | "cancelled";
  steps: SegmentStepResult[];
  vars?: Record<string, unknown>;
}

export interface SessionPlayer {
  name: string;
  userId: number;
}
