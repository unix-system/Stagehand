// State contract of the stagehand-progress mod. Every value the drawings read
// lives in `$.state` under these keys (module variables die on hot reload).

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error'

export type StepView = {
  id: string
  /** `label ?? display` from the daemon's StepRecord. */
  label: string
  /** Raw target (`server`, `client#2`, `edit`, `daemon`). */
  target: string
  /** Display tag (`SERVER`, `P2`, `EDIT`, `DAEMON`). */
  tag: string
  verb: string
  status: StepStatus
  soft: boolean
  /** Step budget in ms; 0 when instant. */
  timeoutMs: number
  startedAt: number | null
  durationMs: number | null
  /** Elapsed at the last poll tick, running steps only. */
  elapsedMs: number | null
  reason: string | null
  hint: string | null
}

export type LogLine = {
  seq: number
  level: 'info' | 'warn' | 'error'
  role: string
  message: string
  stepId: string | null
}

export type RunFailure = {
  step: string | null
  display: string | null
  reason: string
  hint: string | null
}

export type LiveRun = {
  runId: string
  name: string
  status: RunStatus
  /** Epoch ms when the run started; null while queued. */
  startedAt: number | null
  finishedAt: number | null
  /** Elapsed at the last poll tick. */
  elapsedMs: number
  session: { mode: string; players: number; reused: boolean } | null
  total: number
  finished: number
  counts: { passed: number; failed: number; skipped: number; cancelled: number; pending: number }
  steps: StepView[]
  failure: RunFailure | null
  softFailures: number
  /** tail_run cursor. */
  lastSeq: number
  logs: LogLine[]
  /** Studio launch progress while a session starts. */
  launchMessage: string | null
  /** Report directory, once known. */
  dir: string | null
  /** Last poll error, shown in the band. */
  error: string | null
  /** Set while a run_suite call is in flight: runs seen since it started. */
  suite: { seen: number; total: number | null } | null
}

export type RunHistoryEntry = {
  runId: string
  name: string
  status: RunStatus
  durationMs: number
  failingStep: string | null
  reason: string | null
}

export type UiFlags = {
  /** The Cancel button was pressed once and awaits confirmation. */
  confirmCancel: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'stagehand-progress': {
      live: LiveRun | null
      history: RunHistoryEntry[]
      ui: UiFlags
    }
  }
}
