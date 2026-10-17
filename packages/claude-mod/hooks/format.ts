// Pure formatting helpers. Mirrors plugin/src/UI/ProgressModel.luau so the
// band and pane read like the Studio widget.

import type { RunStatus, StepStatus } from '../types'

/** "2.4s" / "0.3s" / "1m 05s" */
export function fmtSeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s >= 60) {
    const m = Math.floor(s / 60)
    const r = Math.floor(s % 60)
    return `${m}m ${String(r).padStart(2, '0')}s`
  }
  return `${s.toFixed(1)}s`
}

/** "2.4s / 10s" (budget only when known). */
export function elapsedText(elapsedMs: number, timeoutMs: number | null): string {
  const e = fmtSeconds(elapsedMs)
  if (timeoutMs && timeoutMs > 0) return `${e} / ${fmtBudget(timeoutMs)}`
  return e
}

/** Budgets are round numbers: "10s", "1m 30s", "250ms". */
export function fmtBudget(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s >= 60) {
    const m = Math.floor(s / 60)
    const r = Math.round(s % 60)
    return r === 0 ? `${m}m` : `${m}m ${String(r).padStart(2, '0')}s`
  }
  return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`
}

/** Fraction of the budget used (0..1); `warn` from 75 %. */
export function budget(elapsedMs: number, timeoutMs: number | null): { fraction: number; warn: boolean } {
  if (!timeoutMs || timeoutMs <= 0) return { fraction: 0, warn: false }
  const fraction = Math.min(1, Math.max(0, elapsedMs / timeoutMs))
  return { fraction, warn: fraction >= 0.75 }
}

/** A bar of `width` cells filled to `fraction`. */
export function bar(fraction: number, width: number, fill = '█', empty = '░'): string {
  const w = Math.max(0, Math.floor(width))
  if (w === 0) return ''
  const f = Math.min(1, Math.max(0, fraction))
  const filled = Math.round(f * w)
  return fill.repeat(filled) + empty.repeat(w - filled)
}

/** "client#2" → "P2", "server" → "SERVER". */
export function tag(target: string): string {
  const m = /^client#(\d+)$/.exec(target)
  return m ? `P${m[1]}` : target.toUpperCase()
}

// Single-cell glyphs only: some terminal fonts draw ⊘ ⚠ ⟳ ↷ two cells wide and shift the row.
export const STEP_GLYPH: Record<StepStatus, string> = {
  passed: '✓',
  failed: '✗',
  running: '▶',
  pending: '·',
  skipped: '»',
  cancelled: '×',
}

export const RUN_GLYPH: Record<RunStatus, string> = {
  queued: '…',
  running: '▶',
  passed: '✓',
  failed: '✗',
  cancelled: '×',
  error: '!',
}

/** "steps.3" → "3", "setup.0" → "s0", "teardown.1" → "t1", "steps.2.1" → "2.1"; cut to `max` cells. */
export function shortId(id: string, max = 3): string {
  const m = /^(setup|steps|teardown)\.(.+)$/.exec(id)
  const short = m ? `${m[1] === 'setup' ? 's' : m[1] === 'teardown' ? 't' : ''}${m[2]}` : id
  return short.length > max ? `${short.slice(0, max - 1)}…` : short
}

export const RUN_WORD: Record<RunStatus, string> = {
  queued: 'QUEUED',
  running: 'RUNNING',
  passed: 'PASSED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  error: 'ERROR',
}

/** Theme key for a run or step status. */
export function statusColor(status: RunStatus | StepStatus): 'success' | 'error' | 'warning' | 'claude' | 'subtle' | 'inactive' {
  switch (status) {
    case 'passed':
      return 'success'
    case 'failed':
    case 'error':
      return 'error'
    case 'running':
      return 'claude'
    case 'cancelled':
    case 'skipped':
      return 'inactive'
    case 'queued':
    case 'pending':
      return 'subtle'
  }
}

export function isTerminal(status: RunStatus): boolean {
  return status === 'passed' || status === 'failed' || status === 'cancelled' || status === 'error'
}

/** Cut to `n` cells with an ellipsis; `n` ≥ 1. */
export function truncate(s: string, n: number): string {
  if (n <= 0) return ''
  if (s.length <= n) return s
  if (n === 1) return '…'
  return `${s.slice(0, n - 1)}…`
}

export function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

export function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}
