// The detail pane: header, overall bar, step list, output tail, buttons, history.
//
// Layout rules: fixed columns sit in `flexShrink={0}` boxes so only labels give
// way when a row is wider than the pane; glyphs are single-cell in common
// terminal fonts (no ⊘ ⚠ ⟳, which some fonts draw two cells wide).

import type { RenderElement } from 'claude-code'

import type { LiveRun, RunHistoryEntry, StepView } from '../../types'
import { RUN_GLYPH, RUN_WORD, STEP_GLYPH, bar, budget, elapsedText, fmtBudget, fmtSeconds, isTerminal, padEnd, padStart, shortId, statusColor, truncate } from '../format'
import { perTarget } from '../parse'
import type { Els } from './Band'

export type PaneHandlers = {
  onCancel: () => void
  onCopyReport: () => void
}

export type PaneCtx = {
  live: LiveRun | null
  history: RunHistoryEntry[]
  confirmCancel: boolean
  width: number
  /** Rows the body may show at once. */
  rows: number
  logLines: number
}

const IDX_W = 3
const TAG_W = 6

export function renderPane(els: Els, ctx: PaneCtx, on: PaneHandlers): RenderElement {
  const { Box, Text } = els
  const { live } = ctx
  const w = Math.max(30, ctx.width - 2)
  if (!live) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          <Text weight="semibold">Stagehand</Text> <Text dimColor>· no run yet</Text>
        </Text>
        {ctx.history.length > 0 && renderHistory(els, ctx.history, w)}
      </Box>
    )
  }

  const color = statusColor(live.status)
  const sess = live.session
    ? `${live.session.mode}${live.session.players ? ` · ${live.session.players} player${live.session.players === 1 ? '' : 's'}` : ''}${live.session.reused ? ' (reused)' : ''}`
    : live.launchMessage
      ? 'launching…'
      : ''
  const targets = perTarget(live)
  const targetLine = targets.length > 1 ? targets.map((t) => `${t.tag} ${t.done}/${t.total}`).join('  ') : ''
  const anyFailed = targets.some((t) => t.failed > 0)
  const done = isTerminal(live.status)
  const counter = `${live.finished}/${live.total} steps`
  const barWidth = Math.max(10, Math.min(30, w - counter.length - targetLine.length - 4))

  const logs = live.logs.slice(-Math.max(0, ctx.logLines))
  const recent = ctx.history.filter((entry) => entry.runId !== live.runId).slice(0, 5)

  // Rows everything but the step list takes, so the list gets the rest (never fewer than 8 or the whole list).
  const fixedRows =
    3 + (live.launchMessage ? 1 : 0) + (live.error ? 1 : 0) + (live.failure ? 2 + (live.failure.hint ? 1 : 0) : 0) + (logs.length > 0 ? logs.length + 2 : 0) + 2 + (recent.length > 0 ? recent.length + 2 : 0)
  const stepRoom = Math.max(Math.min(live.steps.length + 2, 8), ctx.rows - fixedRows)
  const window = windowSteps(live.steps, stepRoom)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          <Text color={color} weight="semibold" inverse>
            {' '}{RUN_GLYPH[live.status]} {RUN_WORD[live.status]}{' '}
          </Text>
        </Box>
        <Box flexShrink={1} overflow="hidden">
          <Text weight="semibold" wrap="truncate-end">
            {live.name}
          </Text>
        </Box>
        <Box flexShrink={2} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {sess}
          </Text>
        </Box>
        <Box flexGrow={1} />
        <Box flexShrink={0}>
          <Text tabular dimColor>
            {fmtSeconds(live.elapsedMs)}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          <Text color={done ? color : 'claude'}>{bar(live.total ? live.finished / live.total : 0, barWidth)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text tabular>{counter}</Text>
        </Box>
        {targetLine && (
          <Box flexShrink={1} overflow="hidden">
            <Text color={anyFailed ? 'error' : done ? 'success' : undefined} dimColor={!anyFailed && !done} wrap="truncate-end">
              {targetLine}
            </Text>
          </Box>
        )}
      </Box>
      {live.launchMessage && (
        <Text wrap="truncate-end">
          <Text color="claude">~</Text> {live.launchMessage}
        </Text>
      )}
      {live.error && <Text color="warning">{live.error}</Text>}
      <Text> </Text>

      {window.before > 0 && <Text dimColor>{`  ${window.before} earlier…`}</Text>}
      {window.steps.map((s) => renderStep(els, s, w))}
      {window.after > 0 && <Text dimColor>{`  ${window.after} more pending…`}</Text>}

      {live.failure && (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="wrap">
            <Text color="error" weight="semibold">
              Failed{live.failure.step ? ` at ${live.failure.step}` : ''}:
            </Text>{' '}
            {live.failure.reason}
          </Text>
          {live.failure.hint && (
            <Text dimColor wrap="wrap">
              {'  hint: '}
              {live.failure.hint}
            </Text>
          )}
        </Box>
      )}

      {logs.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{`Output ${'─'.repeat(Math.max(0, w - 7))}`}</Text>
          {logs.map((l) => (
            <Text wrap="truncate-end">
              {'  '}
              <Text dimColor>{padEnd(truncate(l.role, 7), 7)}</Text>{' '}
              <Text color={l.level === 'error' ? 'error' : l.level === 'warn' ? 'warning' : undefined}>
                {l.level === 'warn' ? '! ' : l.level === 'error' ? '!! ' : ''}
                {l.message}
              </Text>
            </Text>
          ))}
        </Box>
      )}

      <Box flexDirection="row" gap={2} marginTop={1}>
        {!done && live.runId !== 'pending' && (
          <Box flexShrink={0}>
            <els.Button key="cancel" variant={ctx.confirmCancel ? 'primary' : 'secondary'} hotkey="c" onPress={on.onCancel}>
              {ctx.confirmCancel ? 'Really cancel?' : 'Cancel run'}
            </els.Button>
          </Box>
        )}
        {live.dir && (
          <Box flexShrink={0}>
            <els.Button key="copy" hotkey="r" onPress={on.onCopyReport}>
              Copy report path
            </els.Button>
          </Box>
        )}
        <Box flexGrow={1} />
        <Box flexShrink={1} overflow="hidden">
          <Text dimColor wrap="truncate-start">
            {live.runId}
          </Text>
        </Box>
      </Box>

      {recent.length > 0 && renderHistory(els, recent, w)}
    </Box>
  )
}

function renderStep(els: Els, s: StepView, w: number): RenderElement {
  const { Box, Text } = els
  const glyph = STEP_GLYPH[s.status]
  const color = statusColor(s.status)
  // Right column: duration, running budget bar, or pending budget.
  let right: RenderElement
  let rightW: number
  if (s.status === 'running') {
    const el = s.elapsedMs ?? 0
    const b = budget(el, s.timeoutMs)
    const text = elapsedText(el, s.timeoutMs)
    rightW = (s.timeoutMs > 0 ? 9 : 0) + text.length
    right = (
      <Text color={b.warn ? 'warning' : 'claude'} tabular>
        {s.timeoutMs > 0 ? `${bar(b.fraction, 8)} ` : ''}
        {text}
      </Text>
    )
  } else if (s.status === 'pending') {
    const text = s.timeoutMs > 0 ? `(${fmtBudget(s.timeoutMs)})` : ''
    rightW = text.length
    right = <Text dimColor>{text}</Text>
  } else {
    const text = s.durationMs !== null && s.durationMs > 0 ? fmtSeconds(s.durationMs) : s.status === 'skipped' ? 'skipped' : '—'
    rightW = text.length
    right = (
      <Text dimColor tabular>
        {text}
      </Text>
    )
  }
  const labelRoom = Math.max(8, w - 2 - IDX_W - TAG_W - rightW - 4)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0} width={1}>
          <Text color={color}>{glyph}</Text>
        </Box>
        <Box flexShrink={0} width={IDX_W}>
          <Text dimColor tabular>
            {padStart(shortId(s.id, IDX_W), IDX_W)}
          </Text>
        </Box>
        <Box flexShrink={0} width={TAG_W}>
          <Text color={s.tag === 'SERVER' ? 'warning' : s.tag.startsWith('P') ? 'claude' : undefined} dimColor={s.status === 'pending'}>
            {padEnd(s.tag, TAG_W)}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text dimColor={s.status === 'pending' || s.status === 'skipped'} weight={s.status === 'running' ? 'semibold' : undefined} wrap="truncate-end">
            {truncate(s.label, labelRoom)}
            {s.soft ? ' (soft)' : ''}
          </Text>
        </Box>
        <Box flexShrink={0}>{right}</Box>
      </Box>
      {s.status === 'failed' && s.reason && (
        <Text color="error" wrap="truncate-end">
          {'      > '}
          {s.reason}
        </Text>
      )}
      {s.status === 'failed' && s.hint && (
        <Text dimColor wrap="truncate-end">
          {'        '}
          {s.hint}
        </Text>
      )}
    </Box>
  )
}

function renderHistory(els: Els, history: RunHistoryEntry[], w: number): RenderElement {
  const { Box, Text } = els
  const nameW = Math.max(12, Math.min(28, w - 24))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{`Recent ${'─'.repeat(Math.max(0, w - 7))}`}</Text>
      {history.slice(0, 5).map((entry) => (
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={0} width={1}>
            <Text color={statusColor(entry.status)}>{RUN_GLYPH[entry.status]}</Text>
          </Box>
          <Box flexShrink={0} width={nameW}>
            <Text wrap="truncate-end">{truncate(entry.name, nameW)}</Text>
          </Box>
          <Box flexShrink={0} width={7}>
            <Text dimColor tabular>
              {padStart(fmtSeconds(entry.durationMs), 7)}
            </Text>
          </Box>
          <Box flexShrink={1} overflow="hidden">
            <Text wrap="truncate-end">
              {entry.failingStep ? <Text color="error">{entry.failingStep} </Text> : null}
              {entry.reason ? <Text dimColor>{entry.reason}</Text> : null}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/** Choose which steps to draw in `room` rows: keep the running (or first failed) step in view. */
export function windowSteps(steps: StepView[], room: number): { steps: StepView[]; before: number; after: number } {
  // Failed rows take up to three lines; budget for them.
  const cost = (s: StepView) => (s.status === 'failed' ? 1 + (s.reason ? 1 : 0) + (s.hint ? 1 : 0) : 1)
  const total = steps.reduce((n, s) => n + cost(s), 0)
  if (total <= room) return { steps, before: 0, after: 0 }
  const focus = Math.max(
    0,
    steps.findIndex((s) => s.status === 'running'),
    steps.findIndex((s) => s.status === 'failed'),
  )
  // Last non-pending step (no findLastIndex: the hooks runtime may predate ES2023).
  let lastDone = 0
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.status !== 'pending') {
      lastDone = i
      break
    }
  }
  const anchor = focus > 0 ? focus : lastDone
  // Grow a window around the anchor, favouring what comes after it slightly.
  let lo = anchor
  let hi = anchor
  let used = cost(steps[anchor] as StepView) + 2 // two marker rows
  while (used < room && (lo > 0 || hi < steps.length - 1)) {
    if (hi < steps.length - 1 && (hi - anchor <= anchor - lo || lo === 0)) {
      hi++
      used += cost(steps[hi] as StepView)
    } else if (lo > 0) {
      lo--
      used += cost(steps[lo] as StepView)
    } else break
    if (used > room) {
      // Undo the last growth.
      if (hi > anchor && used - cost(steps[hi] as StepView) <= room - 0) {
        hi--
      } else if (lo < anchor) lo++
      break
    }
  }
  return { steps: steps.slice(lo, hi + 1), before: lo, after: steps.length - 1 - hi }
}
