// The poller: while a Stagehand run is active, one tick asks the daemon for
// the run snapshot (get_run json) and new events (tail_run), then writes the
// view model to $.state so the band and pane redraw.
//
// It never holds `$`: register.tsx hands it closures that spell each call.

import type { McpToolResult, Timer } from 'claude-code'

import type { LiveRun, RunHistoryEntry, UiFlags } from '../types'
import { isTerminal } from './format'
import { applyEvents, mcpText, summarize, toLive, tryJson } from './parse'

export const SERVER = 'stagehand'

export type PollOptions = {
  pollMs: number
  logLines: number
  historySize: number
}

export type PollDeps = {
  /** `$.mcp.call(SERVER, tool, args)` */
  call: (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>
  /** `$.clock.every` */
  every: (ms: number, fn: () => void) => Timer
  /** `$.clock.after` */
  after: (ms: number, fn: () => void) => Timer
  /** `read($, liveAtom)` */
  getLive: () => Promise<LiveRun | null>
  /** `update($, liveAtom, fn)` */
  setLive: (fn: (live: LiveRun | null) => LiveRun | null) => Promise<unknown>
  /** `update($, historyAtom, fn)` */
  setHistory: (fn: (h: RunHistoryEntry[]) => RunHistoryEntry[]) => Promise<unknown>
  /** `update($, uiAtom, fn)` */
  setUi: (fn: (u: UiFlags) => UiFlags) => Promise<unknown>
  options: PollOptions
  /** A run reached a terminal status (toast, notify, status line). */
  onFinish: (live: LiveRun) => void
  /** First tick that saw the run as live (auto-open the pane). */
  onRunSeen: (live: LiveRun) => void
  /** Every tick that produced a view (status line). */
  onTick: (live: LiveRun | null) => void
}

type Poller = {
  timer: Timer
  /** `"latest"` until the tool result names the run. */
  runId: string
  /** The newest run before this call; a `latest` equal to it has not started yet. */
  lastSeenRunId: string | null
  dir: string | null
  busy: boolean
  misses: number
  seen: boolean
  /** The last run this poller finished; keeps a suite's next run from re-firing finish for the old one. */
  finishedRunId: string | null
  suite: { seen: number; total: number | null } | null
  launchMessage: string | null
}

const MAX_MISSES = 10
/** After a run finishes, keep polling this long for a suite's next run. */
const SETTLE_MS = 2500

// Module state: a hot reload drops the timer with the module, and session.start resumes from $.state.
let poller: Poller | null = null
let deps: PollDeps | null = null
let settleTimer: Timer | null = null

export function configure(d: PollDeps): void {
  deps = d
}

export function isPolling(): boolean {
  return poller !== null
}

export type StartArgs = {
  lastSeenRunId: string | null
  runId?: string
  launchMessage?: string | null
  suite?: { total: number | null } | null
}

/** Start (or re-aim) the poller. */
export function startPolling(args: StartArgs): void {
  if (!deps) return
  if (poller) {
    poller.lastSeenRunId = args.lastSeenRunId ?? poller.lastSeenRunId
    if (args.runId) poller.runId = args.runId
    if (args.launchMessage !== undefined) poller.launchMessage = args.launchMessage
    if (args.suite !== undefined) poller.suite = args.suite ? { seen: 0, total: args.suite.total } : null
    return
  }
  const p: Poller = {
    timer: deps.every(Math.max(150, deps.options.pollMs), () => void tick()),
    runId: args.runId ?? 'latest',
    lastSeenRunId: args.lastSeenRunId,
    dir: null,
    busy: false,
    misses: 0,
    seen: false,
    finishedRunId: null,
    suite: args.suite ? { seen: 0, total: args.suite.total } : null,
    launchMessage: args.launchMessage ?? null,
  }
  poller = p
  void tick()
}

/** The tool result named the run: pin the poller to it. */
export function pinRun(runId: string | null, dir: string | null): void {
  if (!poller) return
  if (runId) poller.runId = runId
  if (dir) poller.dir = dir
}

/** The tool call that owned a suite returned: stop counting runs for it. */
export function endSuite(): void {
  if (poller) poller.suite = null
}

/** Stop a poller that never saw a run (a `start_session` call creates none). */
export function stopIfIdle(): boolean {
  if (poller && poller.runId === 'latest' && !poller.seen) {
    stopPolling()
    return true
  }
  return false
}

export function stopPolling(): void {
  poller?.timer.cancel()
  poller = null
  settleTimer?.cancel()
  settleTimer = null
}

async function call(tool: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
  if (!deps) return null
  try {
    return await deps.call(tool, args)
  } catch {
    return null
  }
}

async function tick(): Promise<void> {
  const p = poller
  if (!p || !deps || p.busy) return
  p.busy = true
  try {
    await step(p, deps)
  } finally {
    p.busy = false
  }
}

async function step(p: Poller, d: PollDeps): Promise<void> {
  const now = Date.now()
  const got = await call('get_run', { runId: p.runId, format: 'json' })
  const body = got && !got.isError ? tryJson(mcpText(got)) : null
  if (!body) {
    p.misses++
    if (p.misses >= MAX_MISSES) {
      const why = got ? (mcpText(got)?.slice(0, 120) ?? 'empty reply') : 'mcp.call failed'
      await d.setLive((live) => (live ? { ...live, error: `daemon not answering (get_run: ${why})` } : live))
      d.onTick(await d.getLive())
      stopPolling()
    }
    return
  }
  p.misses = 0

  // `latest` still names the run that was newest before this call: nothing has started yet.
  const bodyRunId = typeof body.runId === 'string' ? body.runId : null
  if (p.runId === 'latest' && bodyRunId && bodyRunId === p.lastSeenRunId) {
    if (p.launchMessage) {
      const msg = p.launchMessage
      await d.setLive((live) => (live && live.runId === 'pending' ? { ...live, launchMessage: msg } : launchPlaceholder(msg, now)))
    }
    d.onTick(await d.getLive())
    return
  }
  if (bodyRunId && bodyRunId === p.finishedRunId) {
    // The run we already reported; a suite may still start another one.
    d.onTick(await d.getLive())
    return
  }

  const prev = await d.getLive()
  let next = toLive(body, prev, now)
  if (!next) {
    p.misses++
    return
  }
  const isNew = !prev || prev.runId !== next.runId
  if (p.dir && !next.dir) next = { ...next, dir: p.dir }
  if (p.suite) {
    if (isNew) p.suite.seen++
    next = { ...next, suite: { ...p.suite } }
  } else if (isNew) {
    next = { ...next, suite: null }
  }
  if (p.launchMessage && !next.launchMessage && next.status === 'queued') next = { ...next, launchMessage: p.launchMessage }

  const tail = await call('tail_run', { runId: next.runId, afterSeq: next.lastSeq, limit: 200 })
  const tailBody = tail && !tail.isError ? tryJson(mcpText(tail)) : null
  if (tailBody) next = applyEvents(next, tailBody, Math.max(d.options.logLines, 8) * 5)
  if (next.status !== 'queued' && !next.launchMessage) p.launchMessage = null

  const done = next
  await d.setLive(() => done)
  if (!p.seen) {
    p.seen = true
    d.onRunSeen(done)
  }
  d.onTick(done)

  if (isTerminal(done.status)) {
    p.finishedRunId = done.runId
    p.lastSeenRunId = done.runId
    p.runId = 'latest'
    const size = Math.max(1, d.options.historySize)
    await d.setHistory((h) => [summarize(done), ...h.filter((e) => e.runId !== done.runId)].slice(0, size))
    await d.setUi((u) => ({ ...u, confirmCancel: false }))
    d.onFinish(done)
    // Give a suite the chance to start its next run; otherwise stop.
    settleTimer?.cancel()
    settleTimer = d.after(SETTLE_MS, () => {
      settleTimer = null
      const q = poller
      if (!q || !q.finishedRunId || q.runId !== 'latest') return
      void (async () => {
        const probe = await call('get_run', { runId: 'latest', format: 'json' })
        const b = probe && !probe.isError ? tryJson(mcpText(probe)) : null
        const id = b && typeof b.runId === 'string' ? b.runId : null
        if (!id || id === q.finishedRunId) stopPolling()
      })()
    })
  }
}

function launchPlaceholder(message: string, now: number): LiveRun {
  return {
    runId: 'pending',
    name: 'starting session',
    status: 'queued',
    startedAt: now,
    finishedAt: null,
    elapsedMs: 0,
    session: null,
    total: 0,
    finished: 0,
    counts: { passed: 0, failed: 0, skipped: 0, cancelled: 0, pending: 0 },
    steps: [],
    failure: null,
    softFailures: 0,
    lastSeq: 0,
    logs: [],
    launchMessage: message,
    dir: null,
    error: null,
    suite: null,
  }
}
