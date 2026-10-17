// The band above the prompt: one or two lines while a run is active.

import type { Elements, RenderElement } from 'claude-code'

import type { LiveRun } from '../../types'
import { RUN_GLYPH, STEP_GLYPH, bar, budget, elapsedText, fmtSeconds, isTerminal, statusColor, truncate } from '../format'
import { lastFinishedStep, runningStep } from '../parse'

/** The three elements every surface draws; the union of tables collapses to this. */
export type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export function renderBand(els: Els, live: LiveRun, width: number): RenderElement {
  const { Box, Text } = els
  const w = Math.max(20, width)
  const glyph = RUN_GLYPH[live.status]
  const color = statusColor(live.status)

  if (live.error) {
    return (
      <Box flexDirection="column">
        <Text color="warning" wrap="truncate-end">
          stagehand: {live.error}
        </Text>
      </Box>
    )
  }

  if (live.launchMessage && live.steps.length === 0) {
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="claude">~</Text> <Text weight="semibold">stagehand</Text> <Text dimColor>launching Studio ·</Text> {live.launchMessage}
        </Text>
      </Box>
    )
  }

  if (isTerminal(live.status)) {
    const fail = live.failure
    const summary = `${live.counts.passed} passed, ${live.counts.failed} failed, ${live.counts.skipped} skipped · ${fmtSeconds(live.elapsedMs)}`
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={color} weight="semibold">
            {glyph} {live.name} {live.status}
          </Text>{' '}
          <Text dimColor>{summary}</Text>
        </Text>
        {fail && (
          <Text wrap="truncate-end">
            {'  '}
            <Text color="error">{fail.step ? `${fail.step} ` : ''}{fail.display ?? ''}</Text> <Text>{fail.reason}</Text>
            {fail.hint ? <Text dimColor> · {fail.hint}</Text> : null}
          </Text>
        )}
      </Box>
    )
  }

  const running = runningStep(live)
  const last = lastFinishedStep(live)
  const counter = `${live.finished}/${live.total}`
  const suite = live.suite ? `test ${live.suite.seen}${live.suite.total ? `/${live.suite.total}` : ''} · ` : ''
  const head = `${glyph} ${suite}${live.name}`
  // Right side: "<TAG> <label>  <elapsed>/<budget>"
  let right = ''
  let warn = false
  if (running) {
    const el = running.elapsedMs ?? 0
    const b = budget(el, running.timeoutMs)
    warn = b.warn
    right = `${running.tag} · ${running.label}  ${elapsedText(el, running.timeoutMs)}`
  } else if (live.status === 'queued') {
    right = live.launchMessage ?? 'queued'
  }
  const fixed = head.length + 2 + counter.length + 2 + 2
  const barWidth = Math.max(6, Math.min(24, Math.floor((w - fixed) * 0.3)))
  const rightRoom = Math.max(10, w - fixed - barWidth - 1)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          <Text color="claude" weight="semibold" wrap="truncate-end">
            {head}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color="claude">{bar(live.total ? live.finished / live.total : 0, barWidth)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text tabular>{counter}</Text>
        </Box>
        <Box flexShrink={1} overflow="hidden">
          <Text color={warn ? 'warning' : undefined} wrap="truncate-end">
            {truncate(right, rightRoom)}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor wrap="truncate-end">
          {last ? lastLine(last) : live.launchMessage ? `  ${live.launchMessage}` : '  waiting for the first step'}
        </Text>
        <Text dimColor>/stagehand</Text>
      </Box>
    </Box>
  )
}

function lastLine(s: { id: string; status: string; label: string; durationMs: number | null; reason: string | null }): string {
  const mark = STEP_GLYPH[s.status as keyof typeof STEP_GLYPH] ?? '·'
  const time = s.durationMs !== null ? ` (${fmtSeconds(s.durationMs)})` : ''
  const why = s.status === 'failed' && s.reason ? `: ${s.reason}` : ''
  return `  last: ${mark} ${s.id} ${s.label}${time}${why}`
}
