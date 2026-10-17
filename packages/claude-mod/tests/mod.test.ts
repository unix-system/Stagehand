// The mod against the engine: a run_test call starts the poller, the band and
// pane draw what the daemon reports, and finishing fires the toast.

import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'stagehand-progress'
const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'stagehand',
  props: { title: 'Stagehand', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** A `$` call's bottom answers `{ value }`: here an MCP text result. */
function mcpJson(v: unknown) {
  return { value: { content: [{ type: 'text' as const, text: JSON.stringify(v) }], isError: false } }
}

function run(runId: string, status: string, now: number) {
  const running = status === 'running'
  return {
    runId,
    name: 'spawn-two-players',
    status,
    startedAt: new Date(now - 14_200).toISOString(),
    finishedAt: running ? null : new Date(now).toISOString(),
    durationMs: 14_200,
    dir: `C:/proj/.stagehand/runs/${runId}`,
    session: { sessionId: 's1', mode: 'play', players: 2, reused: true },
    counts: running ? { passed: 1, failed: 0, skipped: 0, cancelled: 0, pending: 2 } : { passed: 3, failed: 0, skipped: 0, cancelled: 0, pending: 0 },
    failure: null,
    softFailures: [],
    steps: [
      { id: 's1', display: 'game.reset', verb: 'game.reset', label: null, target: 'server', soft: false, timeoutMs: 10_000, status: 'passed', durationMs: 300, startedAt: now - 14_000 },
      { id: 's2', display: 'gui.click PlayButton as p1', verb: 'gui.click', label: 'click Play', target: 'client#1', soft: false, timeoutMs: 10_000, status: running ? 'running' : 'passed', durationMs: running ? null : 2600, startedAt: now - 2400 },
      { id: 's3', display: 'wait round.started', verb: 'wait', label: null, target: 'server', soft: false, timeoutMs: 10_000, status: running ? 'pending' : 'passed', durationMs: running ? null : 900, startedAt: running ? null : now - 1000 },
    ],
    vars: {},
    errors: [],
    warnings: [],
    logCounts: { info: 1, warn: 0, error: 0 },
  }
}

for (const surface of SURFACES) {
  test(`follows a run_test call on ${surface}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const mcpCalls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const toasts: string[] = []
    const statuses: Array<string | undefined> = []
    let opened = 0
    // The daemon: r_0 finished earlier; r_1 appears once the tool call is under way.
    let snapshot: Record<string, unknown> = run('r_0', 'passed', Date.now() - 60_000)

    on('mcp.call', { server: 'stagehand', tool: 'get_run' }, ($, e) => {
      mcpCalls.push({ tool: e.tool, args: e.args })
      return mcpJson(snapshot)
    })
    on('mcp.call', { server: 'stagehand', tool: 'tail_run' }, ($, e) => {
      mcpCalls.push({ tool: e.tool, args: e.args })
      return mcpJson({
        runId: snapshot.runId,
        status: snapshot.status,
        done: false,
        lastSeq: 4,
        more: false,
        events: [{ seq: 4, type: 'log', t: 900, level: 'warn', message: 'Coins leaderstat missing', node: 'server#1', role: 'server', stepId: 's1' }],
      })
    })
    on('mcp.call', { server: 'stagehand', tool: 'cancel_run' }, ($, e) => {
      mcpCalls.push({ tool: e.tool, args: e.args })
      return mcpJson({ runId: e.args.runId, cancelled: true, status: 'running' })
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.status', ($, e) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-surface' as const } }))
    on('ui.open', () => {
      opened++
      return { value: { isPlaced: true as const } }
    })
    on('tool.call', { tool: 'mcp__stagehand__run_test' }, async () => {
      // The daemon allocates the run as the tool enters, then blocks until it finishes.
      snapshot = run('r_1', 'running', Date.now())
      await clock.sleep(1500)
      snapshot = run('r_1', 'passed', Date.now())
      return { result: { ok: true }, text: `# spawn-two-players: PASSED\n\nrunId: r_1\nreport: C:/proj/.stagehand/runs/r_1` }
    })

    await $.session.start({ cwd: 'C:/proj', surface, isInteractive: true })

    const call = $.tool.call({ tool: 'mcp__stagehand__run_test', name: 'spawn-two-players' })
    await clock.settle()
    // The hook read `latest` (r_0) before calling the tool, then the first tick saw r_1.
    expect(mcpCalls[0]).toMatchObject({ tool: 'get_run', args: { runId: 'latest', format: 'json' } })
    await clock.advance(600)

    // Band: name, counter, the running step with its budget.
    const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, viewport: { columns: 120, rows: 40, isFullscreen: true } })
    expect(await band.find({ type: 'Text', text: /spawn-two-players/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '1/3' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /P1 · click Play\s+2\.[4-9]s \/ 10s/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /last: ✓ s1 game.reset \(0\.3s\)/ })).toBeDefined()
    expect(statuses.at(-1)).toMatch(/^stagehand ▶ spawn-two-players 1\/3 · P1 click Play 2\.[4-9]s \/ 10s$/)

    // Pane: header, per-target counts, log tail, cancel needs a second press.
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE, viewport: { columns: 160, rows: 50, isFullscreen: true } })
    expect(await pane.find({ type: 'Text', text: /RUNNING/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'SERVER 1/2  P1 0/1' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Coins leaderstat missing/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '(10s)' })).toBeDefined()
    await pane.press({ key: 'cancel' })
    expect(mcpCalls.some((c) => c.tool === 'cancel_run')).toBe(false)
    expect(await pane.find({ type: 'Button', text: /Really cancel/ })).toBeDefined()
    await pane.press({ key: 'cancel' })
    expect(mcpCalls.find((c) => c.tool === 'cancel_run')?.args).toEqual({ runId: 'r_1' })
    expect(toasts.at(-1)).toMatch(/cancelling spawn-two-players/)

    // The tool returns and the next tick sees the run passed.
    await clock.advance(1000)
    await call
    await clock.advance(600)
    expect(toasts.at(-1)).toBe('✓ spawn-two-players passed · 3/3 in 14.2s')
    expect(await pane.find({ type: 'Text', text: /PASSED/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '3/3 steps' })).toBeDefined()
    expect(await pane.find({ type: 'Button', text: /Copy report path/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /spawn-two-players passed/ })).toBeDefined()
    expect(opened, 'the pane auto-opened once the run was seen in fullscreen').toBe(1)

    // Settling: the poller keeps ticking briefly for a suite's next run, then stops.
    await clock.advance(2600)
    const after = mcpCalls.filter((c) => c.tool === 'get_run').length
    await clock.advance(3000)
    expect(mcpCalls.filter((c) => c.tool === 'get_run').length).toBe(after)
    // The result stays on the status line for ten seconds, then clears.
    expect(statuses.at(-1)).toMatch(/passed/)
    await clock.advance(10_000)
    expect(statuses.at(-1)).toBeUndefined()

    await pane.unmount()
    await band.unmount()
  })
}

test('a start_session call shows the launch line and leaves nothing behind', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const statuses: Array<string | undefined> = []
  let polls = 0
  on('mcp.call', { server: 'stagehand', tool: 'get_run' }, () => {
    polls++
    return mcpJson(run('r_0', 'passed', Date.now() - 60_000))
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'mcp__stagehand__start_session' }, async () => {
    await clock.sleep(2000)
    return { result: {}, text: JSON.stringify({ sessionId: 's1', mode: 'play', players: 2, reused: false }) }
  })

  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const call = $.tool.call({ tool: 'mcp__stagehand__start_session', players: 2 })
  await clock.advance(700)
  expect(statuses.at(-1)).toMatch(/^stagehand ~ starting a Studio session/)
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /launching Studio/ })).toBeDefined()
  await band.unmount()

  await clock.advance(1400)
  await call
  expect(statuses.at(-1)).toBeUndefined()
  const after = polls
  await clock.advance(3000)
  expect(polls, 'the poller stopped once start_session returned').toBe(after)
})

test('gives up after repeated daemon misses and says so', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const statuses: Array<string | undefined> = []
  on('mcp.call', { server: 'stagehand' }, () => ({ value: { content: [{ type: 'text' as const, text: '{"error":{"code":"NOT_FOUND","message":"no such run"}}' }], isError: true } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'mcp__stagehand__run_steps' }, () => ({ result: {}, text: 'validation failed' }))

  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__stagehand__run_steps', steps: 'do: game.reset' })
  await clock.advance(600 * 12)
  // Nothing was ever live, so there is no band to show the error in; the status line is clear.
  expect(statuses.at(-1)).toBeUndefined()
})
