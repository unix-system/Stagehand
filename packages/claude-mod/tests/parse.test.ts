import { describe, expect, test } from 'claude-code/testing'

import { applyEvents, mcpText, parseToolText, perTarget, runningStep, summarize, toLive } from '../hooks/parse'

const NOW = 1_700_000_000_000

function partial(status: string, overrides: Record<string, unknown> = {}) {
  return {
    runId: 'r_20261017T141200_spawn-two-players',
    name: 'spawn-two-players',
    status,
    startedAt: new Date(NOW - 14_200).toISOString(),
    finishedAt: null,
    durationMs: 14_200,
    dir: 'C:/proj/.stagehand/runs/20261017T141200-spawn-two-players',
    session: { sessionId: 's1', mode: 'play', players: 2, reused: true },
    counts: { passed: 2, failed: 0, skipped: 0, cancelled: 0, pending: 2 },
    failure: null,
    softFailures: [],
    steps: [
      { id: 's1', phase: 'steps', display: 'game.reset', verb: 'game.reset', name: null, label: null, actor: null, target: 'server', nodeId: 'n1', soft: false, timeoutMs: 10_000, withinMs: null, status: 'passed', durationMs: 300, startedAt: NOW - 14_000 },
      { id: 's2', phase: 'steps', display: 'wait gui.visible Lobby', verb: 'wait', name: 'gui.visible', label: 'wait for Lobby visible', actor: { name: 'p1', playerIndex: 1 }, target: 'client#1', nodeId: 'n2', soft: false, timeoutMs: 10_000, withinMs: 10_000, status: 'passed', durationMs: 1100, startedAt: NOW - 13_000 },
      { id: 's3', phase: 'steps', display: 'gui.click PlayButton as p1', verb: 'gui.click', name: 'gui.click', label: 'click Play', actor: { name: 'p1', playerIndex: 1 }, target: 'client#1', nodeId: 'n2', soft: false, timeoutMs: 10_000, withinMs: null, status: 'running', durationMs: null, startedAt: NOW - 2400 },
      { id: 's4', phase: 'steps', display: 'wait round.started', verb: 'wait', name: 'round.started', label: null, actor: null, target: 'server', nodeId: null, soft: false, timeoutMs: 10_000, withinMs: 10_000, status: 'pending', durationMs: null, startedAt: null },
    ],
    vars: {},
    errors: [],
    warnings: [],
    logCounts: { info: 2, warn: 1, error: 0 },
    ...overrides,
  }
}

describe('parseToolText', () => {
  test('reads the runId/report trailer of a run tool result', () => {
    const text = '# spawn-two-players: PASSED\n\n| step | ... |\n\nrunId: r_20261017T141200_spawn-two-players\nreport: C:\\proj\\.stagehand\\runs\\20261017T141200-spawn-two-players'
    expect(parseToolText(text)).toEqual({ runId: 'r_20261017T141200_spawn-two-players', dir: 'C:\\proj\\.stagehand\\runs\\20261017T141200-spawn-two-players' })
  })

  test('reads the JSON a wait:false call returns', () => {
    const text = JSON.stringify({ runId: 'r_1', name: 'adhoc', status: 'queued', steps: { total: 3, finished: 0 }, dir: 'D', lastSeq: 0, hint: 'poll' })
    expect(parseToolText(text)).toEqual({ runId: 'r_1', dir: 'D' })
  })

  test('is null for anything else', () => {
    expect(parseToolText(undefined)).toEqual({ runId: null, dir: null })
    expect(parseToolText('Suite: 2/2 passed')).toEqual({ runId: null, dir: null })
  })

  test('mcpText takes the first text block', () => {
    expect(mcpText({ content: [{ type: 'image' }, { type: 'text', text: 'hi' }] })).toBe('hi')
    expect(mcpText({ content: [] })).toBeUndefined()
    expect(mcpText(undefined)).toBeUndefined()
  })
})

describe('toLive', () => {
  test('maps a running PartialRunResult', () => {
    const live = toLive(partial('running'), null, NOW)
    expect(live).toBeDefined()
    if (!live) return
    expect(live.name).toBe('spawn-two-players')
    expect(live.status).toBe('running')
    expect(live.total).toBe(4)
    expect(live.finished).toBe(2)
    expect(live.elapsedMs).toBe(14_200)
    expect(live.session).toEqual({ mode: 'play', players: 2, reused: true })
    const s3 = runningStep(live)
    expect(s3?.id).toBe('s3')
    expect(s3?.label).toBe('click Play')
    expect(s3?.tag).toBe('P1')
    expect(s3?.elapsedMs).toBe(2400)
    expect(live.steps[1]?.label).toBe('wait for Lobby visible')
    expect(live.steps[3]?.label).toBe('wait round.started')
    expect(live.steps[3]?.tag).toBe('SERVER')
    expect(perTarget(live)).toEqual([
      { tag: 'SERVER', done: 1, total: 2, failed: 0 },
      { tag: 'P1', done: 1, total: 2, failed: 0 },
    ])
  })

  test('carries poller-owned fields over from the previous view of the same run', () => {
    const first = toLive(partial('running'), null, NOW)
    if (!first) throw new Error('no view')
    const withLogs = { ...first, logs: [{ seq: 3, level: 'info' as const, role: 'server', message: 'hi', stepId: null }], lastSeq: 3 }
    const second = toLive(partial('running'), withLogs, NOW + 600)
    expect(second?.logs).toHaveLength(1)
    expect(second?.lastSeq).toBe(3)
    const other = toLive(partial('running', { runId: 'r_other' }), withLogs, NOW)
    expect(other?.logs).toHaveLength(0)
    expect(other?.lastSeq).toBe(0)
  })

  test('maps a failed run with its failure', () => {
    const failed = partial('failed', {
      finishedAt: new Date(NOW).toISOString(),
      counts: { passed: 2, failed: 1, skipped: 1, cancelled: 0, pending: 0 },
      failure: { step: 's3', display: 'click Play', phase: 'steps', reason: "GUI 'PlayButton' not found", hint: 'check the Gui path', node: 'n2', logsAround: [] },
    })
    const live = toLive(failed, null, NOW)
    expect(live?.status).toBe('failed')
    expect(live?.failure).toEqual({ step: 's3', display: 'click Play', reason: "GUI 'PlayButton' not found", hint: 'check the Gui path' })
    expect(live && summarize(live)).toEqual({
      runId: 'r_20261017T141200_spawn-two-players',
      name: 'spawn-two-players',
      status: 'failed',
      durationMs: 14_200,
      failingStep: 's3',
      reason: "GUI 'PlayButton' not found",
    })
  })

  test('rejects bodies that are not a run', () => {
    expect(toLive(null, null, NOW)).toBeNull()
    expect(toLive({ error: { code: 'NOT_FOUND' } }, null, NOW)).toBeNull()
  })
})

describe('applyEvents', () => {
  test('folds logs, launch messages and the cursor in', () => {
    const live = toLive(partial('running'), null, NOW)
    if (!live) throw new Error('no view')
    const tail = {
      runId: live.runId,
      status: 'running',
      done: false,
      lastSeq: 7,
      more: false,
      events: [
        { seq: 2, type: 'session', t: 10, message: 'launching 2 clients' },
        { seq: 5, type: 'log', t: 900, level: 'warn', message: 'Coins leaderstat missing', node: 'server#1', role: 'server', stepId: 's2' },
        { seq: 6, type: 'log', t: 950, level: 'info', message: 'PlayButton pressed', node: 'client#1', role: 'client', stepId: 's3' },
        { seq: 7, type: 'step.started', t: 1000, stepId: 's3' },
      ],
    }
    const next = applyEvents(live, tail, 40)
    expect(next.lastSeq).toBe(7)
    expect(next.logs.map((l) => `${l.level}:${l.role}:${l.message}`)).toEqual(['warn:server:Coins leaderstat missing', 'info:client:PlayButton pressed'])
    // session.ready clears the launch message; a lone `session` event sets it.
    expect(applyEvents(live, { events: [{ seq: 1, type: 'session', message: 'starting' }] }, 40).launchMessage).toBe('starting')
    expect(applyEvents({ ...live, launchMessage: 'starting' }, { events: [{ seq: 2, type: 'session.ready' }] }, 40).launchMessage).toBeNull()
  })

  test('keeps only the newest logs', () => {
    const live = toLive(partial('running'), null, NOW)
    if (!live) throw new Error('no view')
    const events = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, type: 'log', level: 'info', message: `m${i}`, role: 'server' }))
    const next = applyEvents(live, { events }, 3)
    expect(next.logs.map((l) => l.message)).toEqual(['m7', 'm8', 'm9'])
  })
})
