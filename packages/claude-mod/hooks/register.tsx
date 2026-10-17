// stagehand-progress: live progress of Stagehand playtests inside Claude Code.
//
// A run started through the stagehand MCP server (run_test, run_steps,
// run_suite) is followed by polling the daemon's own get_run / tail_run
// tools over the session's connection; the view model lives in $.state and
// is drawn as a band above the prompt, a pane, the status line and toasts.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LiveRun, RunHistoryEntry, UiFlags } from '../types'
import { RUN_GLYPH, elapsedText, fmtSeconds, isTerminal, truncate } from './format'
import { parseToolText, runningStep } from './parse'
import { configure, endSuite, isPolling, pinRun, startPolling, stopIfIdle, SERVER } from './poll'
import { renderBand } from './view/Band'
import { renderPane } from './view/Pane'

const PANE = 'stagehand'
const liveAtom = atom({ plugin: 'stagehand-progress', key: 'live' } as const, null as LiveRun | null)
const historyAtom = atom({ plugin: 'stagehand-progress', key: 'history' } as const, [] as RunHistoryEntry[])
const uiAtom = atom({ plugin: 'stagehand-progress', key: 'ui' } as const, { confirmCancel: false } as UiFlags)
const RUN_TOOLS = /^mcp__stagehand__(run_test|run_steps|run_suite|start_session)$/

function numberOption(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}
function boolOption(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

export const register: Register = (on, options) => {
  const opts = {
    pollMs: numberOption(options.pollMs, 600),
    autoOpen: boolOption(options.autoOpen, true),
    notify: boolOption(options.notify, true),
    historySize: numberOption(options.historySize, 5),
    logLines: Math.floor(numberOption(options.logLines, 8)),
  }

  // Whether this surface docks panes (fullscreen). Re-derived on every drawing; unknown until one.
  let isFullscreen: boolean | undefined
  // The newest run id the daemon knew before the current tool call.
  let lastSeenRunId: string | null = null
  let statusClear: { cancel: () => void } | null = null
  // A run seen before any drawing said whether panes dock: open once a drawing says so.
  let autoOpenPending: string | null = null

  const statusLine = (live: LiveRun | null): string | undefined => {
    if (!live || live.error) return undefined
    if (isTerminal(live.status)) {
      return `stagehand ${RUN_GLYPH[live.status]} ${live.name} ${live.status} · ${live.counts.passed}/${live.total} passed in ${fmtSeconds(live.elapsedMs)}`
    }
    if (live.launchMessage && live.steps.length === 0) return `stagehand ~ ${live.launchMessage}`
    const s = runningStep(live)
    const step = s ? ` · ${s.tag} ${truncate(s.label, 40)} ${elapsedText(s.elapsedMs ?? 0, s.timeoutMs)}` : ''
    return `stagehand ▶ ${live.name} ${live.finished}/${live.total}${step}`
  }

  on('session.start', async ($, e, next) => {
    configure({
      call: (tool, args) => $.mcp.call(SERVER, tool, args),
      every: (ms, fn) => $.clock.every(ms, fn),
      after: (ms, fn) => $.clock.after(ms, fn),
      getLive: () => read($, liveAtom),
      setLive: (fn) => update($, liveAtom, fn),
      setHistory: (fn) => update($, historyAtom, fn),
      setUi: (fn) => update($, uiAtom, fn),
      options: opts,
      onTick: (live) => {
        $.ui.status(statusLine(live))
        if (live && isTerminal(live.status)) {
          // Keep the result pinned briefly, then clear; settle ticks must not re-arm it forever.
          statusClear ??= $.clock.after(10_000, () => {
            statusClear = null
            $.ui.status(undefined)
          })
        } else {
          statusClear?.cancel()
          statusClear = null
        }
        if (autoOpenPending && live && live.runId === autoOpenPending && !isTerminal(live.status) && isFullscreen !== undefined) {
          autoOpenPending = null
          if (isFullscreen) void $.ui.open({ id: PANE, title: 'Stagehand' })
        }
      },
      onRunSeen: (live) => {
        if (!opts.autoOpen) return
        if (isFullscreen === undefined) autoOpenPending = live.runId
        else if (isFullscreen) void $.ui.open({ id: PANE, title: 'Stagehand' })
      },
      onFinish: (live) => {
        const fail = live.failure
        const text =
          live.status === 'passed'
            ? `✓ ${live.name} passed · ${live.counts.passed}/${live.total} in ${fmtSeconds(live.elapsedMs)}`
            : live.status === 'failed'
              ? `✗ ${live.name} failed${fail?.step ? ` at ${fail.step}` : ''}${fail?.display ? ` ${fail.display}` : ''}${fail?.reason ? `: ${fail.reason}` : ''} (${fmtSeconds(live.elapsedMs)})`
              : `${RUN_GLYPH[live.status]} ${live.name} ${live.status} after ${fmtSeconds(live.elapsedMs)}`
        $.ui.toast(text, { timeoutMs: live.status === 'passed' ? 5000 : 8000 })
        if (opts.notify) void $.ui.notify(text, { title: 'Stagehand' })
      },
    })

    await $.command.register({
      name: 'stagehand',
      description: 'Open the Stagehand run pane (live steps, output, cancel); /stagehand off closes it',
      argumentHint: 'off',
      immediate: true,
    })

    // After a hot reload, resume following a run that was live.
    const live = await read($, liveAtom)
    if (live && !isTerminal(live.status) && live.runId !== 'pending' && !isPolling()) {
      startPolling({ lastSeenRunId: null, runId: live.runId })
    }
    return next(e)
  })

  on('command.run', { command: 'stagehand' }, async ($, e) => {
    isFullscreen = e.presentation.isFullscreen
    if (e.args.trim() === 'off') {
      await $.ui.close({ id: PANE })
      return { text: 'Stagehand pane closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Stagehand', focus: true })
    return { text: opened.isPlaced ? 'Stagehand pane opened.' : `Stagehand pane is open but not drawn: ${opened.reason}` }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'stagehand-progress: the command failed; see the debug log.' }))

  // A run tool is about to run: start following the daemon before the call blocks.
  on('tool.call', { tool: RUN_TOOLS }, async ($, e, next) => {
    const tool = String(e.tool).replace('mcp__stagehand__', '')
    const isSuite = tool === 'run_suite'
    const suiteNames = (e as unknown as { names?: unknown }).names
    const names = isSuite && Array.isArray(suiteNames) ? suiteNames.length : null

    // Remember the newest run before this call so `latest` is not mistaken for the new one.
    try {
      const prev = await $.mcp.call(SERVER, 'get_run', { runId: 'latest', format: 'json' })
      const text = prev.content.find((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')?.text
      const o = text ? (JSON.parse(text) as { runId?: unknown }) : null
      lastSeenRunId = o && typeof o.runId === 'string' ? o.runId : null
    } catch {
      lastSeenRunId = null
    }

    const launch = tool === 'start_session' ? 'starting a Studio session…' : null
    if (tool === 'start_session') {
      await update($, liveAtom, () => null)
    }
    startPolling({ lastSeenRunId, launchMessage: launch, suite: isSuite ? { total: names } : null })
    if (launch) $.ui.status(`stagehand ~ ${launch}`)

    const ran = await next(e)

    if (tool === 'start_session') {
      // No run was created: drop the launch placeholder and the poller it fed.
      stopIfIdle()
      await update($, liveAtom, (live) => (live && live.runId === 'pending' ? null : live))
      $.ui.status(undefined)
      return ran
    }
    if (ran.deny === undefined) {
      const { runId, dir } = parseToolText(ran.text)
      if (!isSuite) pinRun(runId, dir)
    }
    if (isSuite) endSuite()
    return ran
  }).catch(($, e, next) => next(e))

  // A new prompt clears a finished run from the band.
  on('prompt.submit', async ($, e, next) => {
    const live = await read($, liveAtom)
    if (live && isTerminal(live.status) && !isPolling()) {
      await update($, liveAtom, () => null)
      statusClear?.cancel()
      statusClear = null
      $.ui.status(undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    if (e.props.hasSurvey) return next(e)
    const live = await read($, liveAtom)
    if (!live) return next(e)
    try {
      const els = $.ui.resolve(e)
      return renderBand(els, live, e.props.bodyColumns)
    } catch (err) {
      $.ui.log(`stagehand-progress: band failed: ${String(err)}`, { to: 'debug' })
      return next(e)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    const [live, history, ui] = await Promise.all([read($, liveAtom), read($, historyAtom), read($, uiAtom)])
    const els = $.ui.resolve(e)
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    try {
      return renderPane(
        els,
        {
          live,
          history,
          confirmCancel: ui.confirmCancel,
          width: e.props.bodyColumns,
          rows,
          logLines: opts.logLines,
        },
        {
        onCancel: async () => {
          const flags = await read($, uiAtom)
          const current = await read($, liveAtom)
          if (!current || isTerminal(current.status)) return
          if (!flags.confirmCancel) {
            await update($, uiAtom, (u) => ({ ...u, confirmCancel: true }))
            // Drop the confirmation if the second press never comes.
            $.clock.after(6000, () => void update($, uiAtom, (u) => ({ ...u, confirmCancel: false })))
            return
          }
          await update($, uiAtom, (u) => ({ ...u, confirmCancel: false }))
          try {
            const res = await $.mcp.call(SERVER, 'cancel_run', { runId: current.runId })
            $.ui.toast(res.isError ? `stagehand: cancel failed` : `⊘ cancelling ${current.name}`)
          } catch {
            $.ui.toast('stagehand: cancel failed (daemon not reachable)')
          }
        },
        onCopyReport: async () => {
          const current = await read($, liveAtom)
          if (!current?.dir) return
          const copied = await $.ui.copy({ text: current.dir, surface: e.surface })
          $.ui.toast(copied.isCopied ? `copied ${current.dir}` : `could not copy: ${copied.reason}`)
        },
        },
      )
    } catch (err) {
      $.ui.log(`stagehand-progress: pane failed: ${String(err)}`, { to: 'debug' })
      const { Text } = els
      return <Text color="warning">stagehand-progress: pane failed: {String(err)}</Text>
    }
  })
}
