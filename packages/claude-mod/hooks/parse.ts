// Pure mapping from the daemon's tool output to the mod's view model.
// Shapes come from packages/mcp/src/engine/types.ts (PartialRunResult,
// StepRecord, RunEvent) and server/tools.ts (result text trailers).

import type { LiveRun, LogLine, RunFailure, RunHistoryEntry, RunStatus, StepStatus, StepView } from '../types'
import { tag } from './format'

type Loose = Record<string, unknown>

const RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'passed', 'failed', 'cancelled', 'error']
const STEP_STATUSES: readonly StepStatus[] = ['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled']

function obj(v: unknown): Loose | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The `runId:` / `report:` trailer of a run tool's text, or the JSON a `wait:false` call returns. */
export function parseToolText(text: string | undefined): { runId: string | null; dir: string | null } {
  if (!text) return { runId: null, dir: null }
  const idLine = /^runId:\s*(\S+)\s*$/m.exec(text)
  const dirLine = /^report:\s*(.+?)\s*$/m.exec(text)
  if (idLine) return { runId: idLine[1] ?? null, dir: dirLine?.[1] ?? null }
  const o = tryJson(text)
  if (o) return { runId: str(o.runId), dir: str(o.dir) }
  return { runId: null, dir: null }
}

/** Parse a tool's text as JSON; null when it is not an object. */
export function tryJson(text: string | undefined): Loose | null {
  if (!text) return null
  try {
    return obj(JSON.parse(text))
  } catch {
    return null
  }
}

/** The text of an MCP result's first text block. */
export function mcpText(result: { content?: ReadonlyArray<unknown> } | undefined): string | undefined {
  for (const block of result?.content ?? []) {
    const b = obj(block)
    if (b && b.type === 'text' && typeof b.text === 'string') return b.text
  }
  return undefined
}

function toStep(raw: unknown, now: number): StepView | null {
  const s = obj(raw)
  if (!s) return null
  const id = str(s.id)
  if (!id) return null
  const status = (STEP_STATUSES as readonly string[]).includes(String(s.status)) ? (s.status as StepStatus) : 'pending'
  const target = str(s.target) ?? 'daemon'
  const startedAt = num(s.startedAt)
  const timeoutMs = num(s.timeoutMs) ?? 0
  return {
    id,
    label: str(s.label) ?? str(s.display) ?? id,
    target,
    tag: tag(target),
    verb: str(s.verb) ?? '',
    status,
    soft: s.soft === true,
    timeoutMs,
    startedAt,
    durationMs: num(s.durationMs),
    elapsedMs: status === 'running' && startedAt !== null ? Math.max(0, now - startedAt) : null,
    reason: str(s.reason),
    hint: str(s.hint),
  }
}

function toFailure(raw: unknown): RunFailure | null {
  const f = obj(raw)
  if (!f) return null
  const reason = str(f.reason)
  if (!reason) return null
  return { step: str(f.step), display: str(f.display), reason, hint: str(f.hint) }
}

/**
 * Build the live view from a `get_run format:"json"` body. Carries over the
 * poller-owned fields (`logs`, `lastSeq`, `launchMessage`, `suite`, `dir`) from `prev`.
 */
export function toLive(raw: unknown, prev: LiveRun | null, now: number): LiveRun | null {
  const r = obj(raw)
  if (!r) return null
  const runId = str(r.runId)
  if (!runId) return null
  const status = (RUN_STATUSES as readonly string[]).includes(String(r.status)) ? (r.status as RunStatus) : 'running'
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((s) => toStep(s, now)).filter((s): s is StepView => s !== null)
  const c = obj(r.counts) ?? {}
  const counts = {
    passed: num(c.passed) ?? 0,
    failed: num(c.failed) ?? 0,
    skipped: num(c.skipped) ?? 0,
    cancelled: num(c.cancelled) ?? 0,
    pending: num(c.pending) ?? 0,
  }
  const startedIso = str(r.startedAt)
  const startedAt = startedIso ? Date.parse(startedIso) : NaN
  const finishedIso = str(r.finishedAt)
  const finishedAt = finishedIso ? Date.parse(finishedIso) : NaN
  const sess = obj(r.session)
  const same = prev && prev.runId === runId ? prev : null
  const durationMs = num(r.durationMs)
  const elapsedMs =
    Number.isFinite(finishedAt) && durationMs !== null ? durationMs : Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0
  return {
    runId,
    name: str(r.name) ?? runId,
    status,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    finishedAt: Number.isFinite(finishedAt) ? finishedAt : null,
    elapsedMs,
    session: sess ? { mode: str(sess.mode) ?? '?', players: num(sess.players) ?? 0, reused: sess.reused === true } : null,
    total: steps.length,
    finished: steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length,
    counts,
    steps,
    failure: toFailure(r.failure),
    softFailures: Array.isArray(r.softFailures) ? r.softFailures.length : 0,
    lastSeq: same?.lastSeq ?? 0,
    logs: same?.logs ?? [],
    launchMessage: same?.launchMessage ?? null,
    dir: str(r.dir) ?? same?.dir ?? null,
    error: null,
    suite: same?.suite ?? prev?.suite ?? null,
  }
}

/** Fold a `tail_run` body into the live view: log lines, launch messages, the cursor. */
export function applyEvents(live: LiveRun, raw: unknown, maxLogs: number): LiveRun {
  const t = obj(raw)
  if (!t) return live
  const events = Array.isArray(t.events) ? t.events : []
  let logs = live.logs
  let launchMessage = live.launchMessage
  let lastSeq = num(t.lastSeq) ?? live.lastSeq
  for (const raw of events) {
    const ev = obj(raw)
    if (!ev) continue
    const seq = num(ev.seq) ?? lastSeq
    if (seq > lastSeq) lastSeq = seq
    const type = str(ev.type)
    if (type === 'log') {
      const level = ev.level === 'warn' || ev.level === 'error' ? ev.level : 'info'
      const line: LogLine = { seq, level, role: str(ev.role) ?? str(ev.node) ?? '?', message: str(ev.message) ?? '', stepId: str(ev.stepId) }
      logs = [...logs, line]
    } else if (type === 'session') {
      launchMessage = str(ev.message)
    } else if (type === 'session.ready' || type === 'phase.started') {
      launchMessage = null
    }
  }
  if (logs.length > maxLogs) logs = logs.slice(-maxLogs)
  return { ...live, logs, launchMessage, lastSeq }
}

export function runningStep(live: LiveRun): StepView | null {
  return live.steps.find((s) => s.status === 'running') ?? null
}

export function lastFinishedStep(live: LiveRun): StepView | null {
  for (let i = live.steps.length - 1; i >= 0; i--) {
    const s = live.steps[i]
    if (s && (s.status === 'passed' || s.status === 'failed' || s.status === 'skipped' || s.status === 'cancelled')) return s
  }
  return null
}

export function firstFailedStep(live: LiveRun): StepView | null {
  return live.steps.find((s) => s.status === 'failed') ?? null
}

/** Per-target counts in first-seen order. */
export function perTarget(live: LiveRun): Array<{ tag: string; done: number; total: number; failed: number }> {
  const out: Array<{ tag: string; done: number; total: number; failed: number }> = []
  for (const s of live.steps) {
    let row = out.find((r) => r.tag === s.tag)
    if (!row) {
      row = { tag: s.tag, done: 0, total: 0, failed: 0 }
      out.push(row)
    }
    row.total++
    if (s.status !== 'pending' && s.status !== 'running') row.done++
    if (s.status === 'failed') row.failed++
  }
  return out
}

export function summarize(live: LiveRun): RunHistoryEntry {
  const failed = live.failure?.step ?? firstFailedStep(live)?.id ?? null
  return {
    runId: live.runId,
    name: live.name,
    status: live.status,
    durationMs: live.elapsedMs,
    failingStep: failed,
    reason: live.failure?.reason ?? firstFailedStep(live)?.reason ?? null,
  }
}
