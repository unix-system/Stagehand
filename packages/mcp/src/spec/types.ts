// TypeScript view of a playtest document (validated by schema/playtest.schema.json).
export type Step = Record<string, unknown>;

export interface SessionSpec {
  mode?: "edit" | "run" | "play" | "multiplayer";
  players?: number;
  reuse?: boolean;
  reset?: "respawn" | "hook" | "none";
}

export interface PlaytestSpec {
  $schema?: string;
  name: string;
  description?: string;
  tags?: string[];
  session?: SessionSpec;
  timeout?: string | number;
  failOnError?: boolean;
  actors?: Record<string, { player: number }>;
  vars?: Record<string, unknown>;
  setup?: Step[];
  steps: Step[];
  teardown?: Step[];
}

export interface Diagnostic {
  severity: "error" | "warning";
  /** Dotted path into the document, e.g. "steps[3].timeout". */
  path: string;
  message: string;
  line?: number;
}

export const VERBS = ["do", "wait", "expect", "lua", "parallel", "each"] as const;
export type StepVerb = (typeof VERBS)[number];
