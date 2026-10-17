import { describe, expect, test } from 'claude-code/testing'

import { bar, budget, elapsedText, fmtBudget, fmtSeconds, shortId, tag, truncate } from '../hooks/format'

describe('format', () => {
  test('durations read like the Studio widget', () => {
    expect(fmtSeconds(2400)).toBe('2.4s')
    expect(fmtSeconds(300)).toBe('0.3s')
    expect(fmtSeconds(65_000)).toBe('1m 05s')
    expect(fmtSeconds(-5)).toBe('0.0s')
  })

  test('budgets are round', () => {
    expect(fmtBudget(10_000)).toBe('10s')
    expect(fmtBudget(250)).toBe('250ms')
    expect(fmtBudget(90_000)).toBe('1m 30s')
    expect(fmtBudget(120_000)).toBe('2m')
    expect(elapsedText(2400, 10_000)).toBe('2.4s / 10s')
    expect(elapsedText(2400, 0)).toBe('2.4s')
    expect(elapsedText(2400, null)).toBe('2.4s')
  })

  test('budget fraction warns from 75 %', () => {
    expect(budget(2400, 10_000)).toEqual({ fraction: 0.24, warn: false })
    expect(budget(7500, 10_000)).toEqual({ fraction: 0.75, warn: true })
    expect(budget(12_000, 10_000)).toEqual({ fraction: 1, warn: true })
    expect(budget(500, 0)).toEqual({ fraction: 0, warn: false })
  })

  test('bars fill to the fraction at any width', () => {
    expect(bar(0.5, 10)).toBe('█████░░░░░')
    expect(bar(0, 4)).toBe('░░░░')
    expect(bar(1, 4)).toBe('████')
    expect(bar(7 / 16, 20)).toHaveLength(20)
    expect(bar(0.5, 0)).toBe('')
  })

  test('target tags', () => {
    expect(tag('client#2')).toBe('P2')
    expect(tag('server')).toBe('SERVER')
    expect(tag('edit')).toBe('EDIT')
    expect(tag('daemon')).toBe('DAEMON')
  })

  test('step ids are shortened for the pane column', () => {
    expect(shortId('steps.0')).toBe('0')
    expect(shortId('steps.12')).toBe('12')
    expect(shortId('setup.0')).toBe('s0')
    expect(shortId('teardown.1')).toBe('t1')
    expect(shortId('steps.2.1')).toBe('2.1')
    expect(shortId('steps.12.3')).toBe('12…')
    expect(shortId('s4')).toBe('s4')
  })

  test('truncate keeps an ellipsis', () => {
    expect(truncate('click Play', 20)).toBe('click Play')
    expect(truncate('click Play', 6)).toBe('click…')
    expect(truncate('x', 0)).toBe('')
  })
})
