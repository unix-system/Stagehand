// Compiled plan: segments routed to nodes, plus fork/join and conditional groups.
import type { Context, WireStep } from "../broker/protocol.js";

export type Phase = "setup" | "steps" | "teardown";
export type SessionMode = "edit" | "run" | "play" | "multiplayer";

export interface NormalizedSession {
  mode: SessionMode;
  players: number;
  reuse: boolean;
  reset: "respawn" | "hook" | "none";
}

export type NodeTarget = { role: "edit" } | { role: "server" } | { role: "client"; playerIndex: number };

export function targetKey(t: NodeTarget): string {
  return t.role === "client" ? `client#${t.playerIndex}` : t.role;
}

export interface PlanStep extends WireStep {
  phase: Phase;
  context: Context;
  target: NodeTarget;
  /** `if: $var` — evaluated by the daemon before dispatch. */
  ifVar: string | null;
  /** Evaluated by the daemon (log.* with scope "all") instead of a node. */
  daemon: boolean;
  /** One-line description for reports. */
  display: string;
}

export interface SegmentNode {
  kind: "segment";
  id: string;
  target: NodeTarget;
  steps: PlanStep[];
  ifVar: string | null;
}

export interface DaemonNode {
  kind: "daemon";
  step: PlanStep;
  ifVar: string | null;
}

export interface ParallelNode {
  kind: "parallel";
  stepId: string;
  label: string | null;
  soft: boolean;
  ifVar: string | null;
  branches: PlanNode[][];
}

/** A conditional block (an `each` with `if`). */
export interface GroupNode {
  kind: "group";
  stepId: string;
  label: string | null;
  soft: boolean;
  ifVar: string | null;
  children: PlanNode[];
}

export type PlanNode = SegmentNode | DaemonNode | ParallelNode | GroupNode;

export interface Plan {
  name: string;
  description: string | null;
  tags: string[];
  session: NormalizedSession;
  timeoutMs: number;
  failOnError: boolean;
  /** actor name -> playerIndex (p1..pN plus aliases). */
  actors: Record<string, number>;
  vars: Record<string, unknown>;
  setup: PlanNode[];
  steps: PlanNode[];
  teardown: PlanNode[];
  /** Every compiled step in document order. */
  allSteps: PlanStep[];
}

/** All plan steps beneath a list of nodes, in order. */
export function stepsOf(nodes: PlanNode[]): PlanStep[] {
  const out: PlanStep[] = [];
  for (const n of nodes) {
    if (n.kind === "segment") out.push(...n.steps);
    else if (n.kind === "daemon") out.push(n.step);
    else if (n.kind === "parallel") for (const b of n.branches) out.push(...stepsOf(b));
    else out.push(...stepsOf(n.children));
  }
  return out;
}

/** Compact, human-readable plan outline. */
export function describePlan(plan: Plan): string[] {
  const lines: string[] = [];
  const walk = (nodes: PlanNode[], indent: string) => {
    for (const n of nodes) {
      if (n.kind === "segment") {
        lines.push(`${indent}${n.id} -> ${targetKey(n.target)}${n.ifVar ? ` (if $${n.ifVar})` : ""}: ${n.steps.map((s) => s.id).join(", ")}`);
      } else if (n.kind === "daemon") {
        lines.push(`${indent}daemon: ${n.step.id} ${n.step.display}`);
      } else if (n.kind === "parallel") {
        lines.push(`${indent}parallel ${n.stepId}${n.ifVar ? ` (if $${n.ifVar})` : ""}`);
        n.branches.forEach((b, i) => {
          lines.push(`${indent}  branch ${i}:`);
          walk(b, `${indent}    `);
        });
      } else {
        lines.push(`${indent}group ${n.stepId} (if $${n.ifVar ?? "?"})`);
        walk(n.children, `${indent}  `);
      }
    }
  };
  for (const phase of ["setup", "steps", "teardown"] as const) {
    if (plan[phase].length === 0) continue;
    lines.push(`${phase}:`);
    walk(plan[phase], "  ");
  }
  return lines;
}
