import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit, SessionUsage } from 'claude-code'

const NOW = Date.parse('2026-10-04T06:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const SURFACES = ['terminal', 'desktop'] as const
const PLUGIN = 'usage-quota-mini'
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const TURN = { answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as never
const MEASURE = { context: { window: 1_000_000, tokens: 158_000, percent: 16 }, rateLimits: [] }
const iso = (ms: number) => new Date(NOW + ms).toISOString()

function usage(rateLimits: SessionRateLimit[], percent = 16): SessionUsage {
  return {
    startedAt: NOW - HOUR,
    context: {
      window: 1_000_000,
      tokens: percent * 10_000,
      percent,
      breakdown: {
        categories: [
          { name: 'Messages', tokens: 97_000, kind: 'used', color: 'text', isDeferred: false },
          { name: 'Free space', tokens: 808_000, kind: 'free', color: 'text', isDeferred: false },
        ],
        totalTokens: 159_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, percentage: percent,
      } as never,
    },
    rateLimits,
  }
}

function world(on: On, rateLimits: SessionRateLimit[], percent = { value: 16 }, ran: string[] = []) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.usage', () => ({ value: usage(rateLimits, percent.value) }))
  on('session.authorize', () => ({ value: null }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', () => ({ changed: [] }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('command.run', (_$, e) => (ran.push(e.command), { text: '' }))
  on('session.compact', () => (ran.push('compact'), { skip: 'test' }) as never)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.status', () => ({ value: undefined }))
  return clock
}

const LIMITS = [
  { kind: 'five_hour', percentUsed: 8, resetsAt: iso(3 * HOUR + 24 * MIN) },
  { kind: 'seven_day', percentUsed: 46, resetsAt: iso(3 * 24 * HOUR + 7 * HOUR) },
]

test('one row: 5h, wk and ctx with their % and countdowns', async ($, on) => {
  world(on, LIMITS)
  await $.session.measure(MEASURE)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS })
    for (const text of ['5h', 'wk', 'ctx', '8%', '46%', '16%', '3h 24m', '3d 7h']) expect(await ui.find({ text })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: 'compact' })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: 'auto off' })).toBeDefined()
    // no headline, no breakdown, no collapse arrow
    expect(await ui.find({ text: /^On track/ })).toBeUndefined()
    expect(await ui.find({ text: 'Messages' })).toBeUndefined()
    if (surface === 'desktop') expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
    await ui.unmount()
  }
})

test('a window on course to run out says when', async ($, on) => {
  world(on, [
    { kind: 'five_hour', percentUsed: 60, resetsAt: iso(4 * HOUR) },
    { kind: 'seven_day', percentUsed: 10, resetsAt: iso(5 * 24 * HOUR) },
  ])
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ text: 'out 1h 14m' })).toBeDefined()
  await ui.unmount()
})

test('narrow: bars go first, then times', async ($, on) => {
  world(on, LIMITS)
  await $.session.measure(MEASURE)
  for (const surface of SURFACES) {
    let ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 60 } })
    expect(await ui.find({ text: '3h 24m' })).toBeDefined()
    if (surface === 'desktop') expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
    await ui.unmount()
    ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 40 } })
    expect(await ui.find({ text: '3h 24m' })).toBeUndefined()
    expect(await ui.find({ text: '46%' })).toBeDefined()
    await ui.unmount()
  }
})

test('compact runs /compact', async ($, on) => {
  const ran: string[] = []
  const clock = world(on, LIMITS, { value: 16 }, ran)
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'compact' })
  await clock.advance(1)
  expect(ran).toEqual(['compact'])
  await ui.unmount()
})

test('auto steps off, 30, 50, 70, off, and compacts between turns', async ($, on) => {
  const percent = { value: 16 }
  const ran: string[] = []
  const clock = world(on, LIMITS, percent, ran)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  for (const label of ['auto 30%', 'auto 50%', 'auto 70%', 'auto off', 'auto 30%']) {
    await ui.press({ key: 'auto' })
    expect(await ui.find({ type: 'Button', label })).toBeDefined()
  }
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  percent.value = 35
  await clock.advance(3_000)
  expect(ran).toEqual([])
  await $.turn.complete(TURN)
  await clock.advance(1_100)
  expect(ran).toEqual(['compact'])
  await ui.unmount()
})

test('turning auto on past the % asks inline, and "compact now" compacts', async ($, on) => {
  const ran: string[] = []
  const clock = world(on, LIMITS, { value: 50 }, ran)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'auto' })
  expect(await ui.find({ text: 'ctx 50%, past 30%:' })).toBeDefined()
  await ui.press({ key: 'askNow' })
  await clock.advance(1_100)
  expect(ran).toEqual(['compact'])
  expect(await ui.find({ text: /past 30%/ })).toBeUndefined()
  await ui.unmount()
})
