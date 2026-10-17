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
  /** Named step sequences for `use:` steps (shadow shared fragments of the same name). */
  fragments?: Record<string, Step[]>;
  setup?: Step[];
  steps: Step[];
  teardown?: Step[];
}

/** A shared fragment file: playtests/_shared/<name>.fragment.yaml. */
export interface FragmentSpec {
  name: string;
  description?: string;
  steps: Step[];
}

export interface Diagnostic {
  severity: "error" | "warning";
  /** Dotted path into the document, e.g. "steps[3].timeout". */
  path: string;
  message: string;
  line?: number;
}

export const VERBS = ["do", "wait", "expect", "lua", "parallel", "each", "use"] as const;
export type StepVerb = (typeof VERBS)[number];
