import { describe, expect, test } from 'claude-code/testing'

import type { RenderElement } from 'claude-code'

import type { StepView } from '../types'
import type { Els } from '../hooks/view/Band'
import { renderPane, windowSteps } from '../hooks/view/Pane'

/** A plain element table: enough to run the view functions outside a surface. */
const fakeEls: Els = {
  Box: (props) => ({ type: 'Box', props } as unknown as RenderElement),
  Text: (props) => ({ type: 'Text', props } as unknown as RenderElement),
  Button: (props) => ({ type: 'Button', props } as unknown as RenderElement),
}

describe('renderPane', () => {
  test('draws the history rows (a loop variable must not shadow the JSX factory)', () => {
    const history = [
      { runId: 'r_1', name: 'spawn-two-players', status: 'passed' as const, durationMs: 21_300, failingStep: null, reason: null },
      { runId: 'r_2', name: 'round-flow', status: 'failed' as const, durationMs: 9_000, failingStep: 's4', reason: 'GUI not found' },
    ]
    const tree = renderPane(fakeEls, { live: null, history, confirmCancel: false, width: 100, rows: 40, logLines: 8 }, { onCancel() {}, onCopyReport() {} })
    const text = JSON.stringify(tree)
    expect(text).toContain('spawn-two-players')
    expect(text).toContain('round-flow')
    expect(text).toContain('GUI not found')
    expect(text).toContain('Recent')
  })
})

function step(i: number, status: StepView['status'], extra: Partial<StepView> = {}): StepView {
  return {
    id: `s${i}`,
    label: `step ${i}`,
    target: 'server',
    tag: 'SERVER',
    verb: 'lua',
    status,
    soft: false,
    timeoutMs: 10_000,
    startedAt: null,
    durationMs: status === 'passed' ? 1000 : null,
    elapsedMs: status === 'running' ? 2400 : null,
    reason: status === 'failed' ? 'boom' : null,
    hint: null,
    ...extra,
  }
}

describe('windowSteps', () => {
  test('shows everything when it fits', () => {
    const steps = [step(1, 'passed'), step(2, 'running'), step(3, 'pending')]
    expect(windowSteps(steps, 10)).toEqual({ steps, before: 0, after: 0 })
  })

  test('keeps the running step in view in a small room', () => {
    const steps = [...Array.from({ length: 10 }, (_, i) => step(i + 1, 'passed')), step(11, 'running'), ...Array.from({ length: 10 }, (_, i) => step(i + 12, 'pending'))]
    const w = windowSteps(steps, 6)
    expect(w.steps.map((s) => s.id)).toContain('s11')
    expect(w.before + w.steps.length + w.after).toBe(21)
    expect(w.steps.length).toBeLessThanOrEqual(6)
  })

  test('anchors on the last finished step when nothing runs', () => {
    const steps = [...Array.from({ length: 8 }, (_, i) => step(i + 1, 'passed')), ...Array.from({ length: 8 }, (_, i) => step(i + 9, 'pending'))]
    const w = windowSteps(steps, 4)
    expect(w.steps.map((s) => s.id)).toContain('s8')
  })

  test('budgets extra rows for failed steps and never loops', () => {
    const steps = [step(1, 'passed'), step(2, 'failed', { hint: 'try within:' }), step(3, 'skipped'), step(4, 'skipped'), step(5, 'skipped')]
    const w = windowSteps(steps, 4)
    expect(w.steps.map((s) => s.id)).toContain('s2')
    expect(w.before + w.steps.length + w.after).toBe(5)
  })
})
