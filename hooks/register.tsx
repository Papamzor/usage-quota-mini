import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { AutoCompact, Category, Hold, Limit, PaceOf, Snapshot } from '../types'

const P = 'usage-quota-mini'
const snapshot = atom({ plugin: P, key: 'snapshot' } as const, null)
const isOn = atom({ plugin: P, key: 'isOn' } as const, true)
const autoCompact = atom({ plugin: P, key: 'autoCompact' } as const, { isOn: false, at: null } as AutoCompact)
const theme = atom({ plugin: P, key: 'theme' } as const, 'dark' as 'dark' | 'light')
const autoAsk = atom({ plugin: P, key: 'autoAsk' } as const, null as { at: number; percent: number } | null)
// what holds auto compact back, and in which chat: kept in state so a reload keeps it
const hold = atom({ plugin: P, key: 'hold' } as const, { chat: '', waits: false, stuck: false } as Hold)

// two palettes, the desktop's dark and light themes; set at the start of every draw
type Palette = { muted: string; green: string; greenText: string; amber: string; red: string; track: string; lit: string }
const DARK: Palette = { muted: '#8b90a0', green: '#4ade80', greenText: '#4ade80', amber: '#fbbf24', red: '#f87171', track: '#2d3140', lit: '#3a3f4d' }
// light: the same hues, deep enough to read on the pale band
const LIGHT: Palette = { muted: '#5b6070', green: '#22b856', greenText: '#16a34a', amber: '#ea8a0c', red: '#ef4444', track: '#e3e6ec', lit: '#d6d9df' }
let MUTED = DARK.muted
let GREEN = DARK.green
let GREEN_TEXT = DARK.greenText
let AMBER = DARK.amber
let RED = DARK.red
let TRACK = DARK.track
// a button's hover
let COMPACT_LIT = DARK.lit
function usePalette(p: Palette): void {
  ;({ muted: MUTED, green: GREEN, greenText: GREEN_TEXT, amber: AMBER, red: RED, track: TRACK, lit: COMPACT_LIT } = p)
}
const HOUR = 3_600_000
const WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5 Hour', ms: 5 * HOUR },
  seven_day: { label: 'Weekly', ms: 7 * 24 * HOUR },
}

// 5 hour on the left, Weekly on the right
const order = (kind: string) => (kind === 'five_hour' ? 0 : 1)

type Forecast = {
  kind: string
  label: string
  percent: number
  resetsAt: number
  /** 'idle': no window running (unused, or reset): 0% until the next message starts one */
  status: 'hit' | 'ok' | 'out' | 'idle'
  projected: number
  runOutAt: number
  color: string
}

// The pace a window is forecast at: your usual one (the median of how far your past
// windows got) blended with this window's own, which takes over as the window runs: it
// counts for half a quarter of the way in. Early jumps barely move it. `skip`: the %
// the first reply of a reopened chat took re-reading its old context, a one-off left
// out of the pace (still in the % used).
const TYPICAL_DEFAULT = 50
const TRUST = 0.25
const FINALS_KEPT = 8
// one window's reset time as two readings give it: a few minutes apart at most
const SAME_WINDOW_MS = 10 * 60_000

function forecast(limit: Limit, now: number, pace?: PaceOf): Forecast | null {
  const win = WINDOWS[limit.kind]
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!win) return null
  const p = limit.percentUsed
  // no reset time, or one already passed: the window is not running, so it is at 0
  if (!Number.isFinite(resetsAt) || resetsAt <= now) {
    return { kind: limit.kind, label: win.label, percent: 0, resetsAt: NaN, status: 'idle', projected: 0, runOutAt: Infinity, color: GREEN }
  }
  const remaining = Math.max(0, resetsAt - now)
  const elapsed = Math.max(1, win.ms - remaining)
  const base = { kind: limit.kind, label: win.label, percent: p, resetsAt }
  if (p >= 100) return { ...base, status: 'hit', projected: p, runOutAt: now, color: RED }
  const typical = pace?.typical ?? TYPICAL_DEFAULT
  const own = Math.max(0, p - (pace?.skip ?? 0)) / elapsed
  const weight = elapsed / (elapsed + win.ms * TRUST)
  const rate = weight * own + (1 - weight) * (typical / win.ms)
  const projected = p + rate * remaining
  if (projected < 100 || rate <= 0) {
    return { ...base, status: 'ok', projected, runOutAt: Infinity, color: worse(GREEN, usedColor(p)) }
  }
  return {
    ...base,
    status: 'out',
    projected,
    runOutAt: now + (100 - p) / rate,
    color: worse(projected > 130 ? RED : AMBER, usedColor(p)),
  }
}

// A limit's colour by what is used, as the band shows it (rounded): amber from 75%,
// red from 90%. The bar and its % take the worse of this and the forecast's.
const LIMIT_AMBER_AT = 75
const LIMIT_RED_AT = 90
function usedColor(p: number): string {
  const shown = Math.round(p)
  return shown >= LIMIT_RED_AT ? RED : shown >= LIMIT_AMBER_AT ? AMBER : GREEN
}
function worse(a: string, b: string): string {
  const rank = (c: string) => (c === RED ? 2 : c === AMBER ? 1 : 0)
  return rank(b) > rank(a) ? b : a
}

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const hours = Math.floor((m % 1440) / 60)
  const min = m % 60
  if (d > 0) return hours > 0 ? `${d}d ${hours}h` : `${d}d`
  if (hours > 0) return min > 0 ? `${hours}h ${min}m` : `${hours}h`
  return `${min}m`
}

// 24-hour clock, as read in Belgium
const time = (t: number) =>
  new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

function tokens(n: number): string {
  // 1M, not 1.0M; 1.5M keeps its decimal
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${Math.round(n)}`
}

// Context by what it holds, as shown (rounded): amber from 50% (a long context costs
// more on every reply: compacting pays), red from 80%
const CONTEXT_AMBER_AT = 50
const CONTEXT_RED_AT = 80
function fillColor(percent: number): string {
  const shown = Math.round(percent)
  if (shown >= CONTEXT_RED_AT) return RED
  if (shown >= CONTEXT_AMBER_AT) return AMBER
  return GREEN
}

// text in green, which on the light band needs a deeper green than the bars to read
function ink(color: string): string {
  return color === GREEN ? GREEN_TEXT : color
}

type Segment = { color: string; share: number }

const BAR_PX = 5

// a thin rounded bar for surfaces that draw Svg: segments laid out over 0..1000,
// with an optional grey tick, the bar's own height, at `marker` percent (the forecast at reset)
function barSvg(segments: Segment[], width: number, marker?: number): string {
  const height = BAR_PX
  const y = 0
  const total = segments.reduce((sum, s) => sum + s.share, 0) || 1
  let x = 0
  const rects = segments
    .map(s => {
      const w = (s.share / total) * 1000
      const rect = `<rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${BAR_PX}" fill="${s.color}"/>`
      x += w
      return rect
    })
    .join('')
  // a plain upright block 3px wide whatever the drawn width: no rounded corners
  // (stretched sideways, those drew it as a "D"), inside the bar's rounded ends so
  // nothing pokes out past them. Placed on a whole pixel and left smooth-edged: snapped
  // edges on a scaled screen drew it 3 device pixels wide on one bar and 4 on another
  const TICK_PX = 3
  const tickW = (TICK_PX / width) * 1000
  const tickAt = marker === undefined ? 0 : Math.min(width - TICK_PX, Math.max(0, Math.round((marker / 100) * width - TICK_PX / 2)))
  const tick =
    marker === undefined
      ? ''
      : `<rect x="${((tickAt / width) * 1000).toFixed(3)}" y="${y}" width="${tickW.toFixed(3)}" height="${BAR_PX}" fill="${MUTED}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 ${height}" preserveAspectRatio="none">` +
    `<clipPath id="r"><rect y="${y}" width="1000" height="${BAR_PX}" rx="${BAR_PX / 2}" ry="${BAR_PX / 2}"/></clipPath>` +
    `<g clip-path="url(#r)">${rects}${tick}</g></svg>`
  )
}


// the terminal's bar: each cell takes the colour of the segment under its middle,
// runs of one colour merged into one Box
function segmentRuns(segments: Segment[], cells: number): { color: string; width: number }[] {
  const total = segments.reduce((sum, s) => sum + s.share, 0) || 1
  const runs: { color: string; width: number }[] = []
  for (let i = 0; i < cells; i++) {
    const at = ((i + 0.5) / cells) * total
    let acc = 0
    let color = TRACK
    for (const s of segments) {
      acc += s.share
      if (at < acc) {
        color = s.color
        break
      }
    }
    const last = runs[runs.length - 1]
    if (last && last.color === color) last.width += 1
    else runs.push({ color, width: 1 })
  }
  return runs
}

// The usage service rate-limits per login, and the app's own Usage panel asks it on
// the same allowance, so ask it seldom: when a chat opens, then every 2 minutes with the
// exact context count, one ask for the whole app (when it was last asked, the answer and
// any back-off sit in the shared store). Between asks the figures every reply from
// Claude carries keep the band current.
const PLAN_EVERY_MS = 2 * 60_000
// timers drift: a 2-minute tick a moment early still counts as due
const PLAN_SLACK_MS = 10_000
// after a failed ask wait 2, then 5, then 15 minutes, or what the service says
const PLAN_BACKOFF_MS = [120_000, 300_000, 900_000]
const LOCAL_EVERY_MS = 3_000

type Backoff = { until: number; failures: number; error: string }
/** 'no': the 3s tick, never asks; 'due': asks if 2 minutes have passed app-wide; 'now': asks unless backed off */
type Ask = 'no' | 'due' | 'now'

class AskError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

// The plan's limits, as the app's "Plan usage limits" panel reads them: the account's
// usage endpoint, through the session's own credential (the plugin never sees it).
async function fetchPlan($: EngineInterface): Promise<Limit[] | null> {
  const auth = await $.session.authorize()
  // no Claude login (an API key, a gateway): there is no plan to ask about
  if (!auth || auth.kind !== 'bearer') return null
  const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
  })
  if (!res.ok) {
    const header = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]
    const seconds = Number(Array.isArray(header) ? header[0] : header)
    const retry = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
    throw new AskError(res.status === 429 ? 'refused (429)' : `failed (${res.status})`, retry)
  }
  const body = JSON.parse(res.text) as Record<string, { utilization?: number | null; resets_at?: string | null } | null>
  const limits: Limit[] = []
  for (const kind of ['five_hour', 'seven_day']) {
    const w = body[kind]
    if (!w || typeof w.utilization !== 'number') continue
    limits.push({ kind, percentUsed: Math.round(w.utilization * 10) / 10, resetsAt: w.resets_at ?? undefined })
  }
  if (limits.length === 0) throw new AskError('answer had no limits')
  return limits
}

type Saved = { at: number; limits: Limit[] }

// this chat's own reading from its replies, and when it last changed
let live: Saved | undefined

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function storeSet($: EngineInterface, key: string, value: unknown): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {
    // this chat still has it
  }
}

// Two sources, and the newest wins: the usage service (asked seldom, shared by every
// chat through the store) and the figures each reply from Claude carries (this chat's,
// stamped when they last changed). A window that has reset since is dropped.
async function limitsOf(
  $: EngineInterface,
  rateLimits: SessionRateLimit[],
  now: number,
  ask: Ask,
): Promise<{ limits: Limit[]; at?: number; error?: string }> {
  if (rateLimits.length > 0) {
    const limits = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
    if (!live || JSON.stringify(live.limits) !== JSON.stringify(limits)) live = { at: now, limits }
  }
  let saved = (await storeGet($, 'limits')) as Saved | undefined
  let backoff = (await storeGet($, 'planBackoff')) as Backoff | undefined
  const askedAt = ((await storeGet($, 'planAskedAt')) as number | undefined) ?? 0
  const isFree = now >= (backoff?.until ?? 0)
  const isDue = ask === 'now' || (ask === 'due' && now - askedAt >= PLAN_EVERY_MS - PLAN_SLACK_MS)
  if (isDue && isFree) {
    // claim the ask first, so the other chats see it taken and skip theirs
    await storeSet($, 'planAskedAt', now)
    try {
      const plan = await fetchPlan($)
      if (plan) {
        saved = { at: now, limits: plan }
        await storeSet($, 'limits', saved)
        await storeSet($, 'planLimits', saved)
      }
      if (backoff) await storeSet($, 'planBackoff', { until: 0, failures: 0, error: '' })
      backoff = undefined
    } catch (error) {
      const failures = (backoff?.failures ?? 0) + 1
      const wait =
        error instanceof AskError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : PLAN_BACKOFF_MS[Math.min(failures - 1, PLAN_BACKOFF_MS.length - 1)]!
      backoff = { until: now + wait, failures, error: error instanceof Error ? error.message : String(error) }
      await storeSet($, 'planBackoff', backoff)
    }
  }
  const pick = [saved, live]
    .filter((r): r is Saved => r !== undefined)
    .sort((x, y) => y.at - x.at)[0]
  // newer reply figures go to the store too, so other chats get them
  if (pick && pick === live && (!saved || live.at > saved.at)) await storeSet($, 'limits', live)
  // The reply figures run behind the usage service, which the app's panel reads: whole
  // percents, and seen at 18 for an hour while the service said 19.0. Use only climbs
  // within a window, so a newer reply figure below the service's last answer is stale:
  // the higher of the two is kept. Above it, the reply's is news.
  const plan = (await storeGet($, 'planLimits')) as Saved | undefined
  const finer = (l: Limit): Limit => {
    const p = plan?.limits.find(x => x.kind === l.kind)
    return p && sameWindow(p.resetsAt, l.resetsAt) && p.percentUsed > l.percentUsed ? { ...l, percentUsed: p.percentUsed } : l
  }
  // a window that has reset since stays, at 0: the forecast reads it as not running
  const limits = (pick?.limits ?? []).map(l =>
    l.resetsAt !== undefined && Date.parse(l.resetsAt) <= now ? { kind: l.kind, percentUsed: 0 } : finer(l),
  )
  return { limits, at: pick?.at, error: backoff?.error || undefined }
}

// What the forecast learns, shared by every chat through the store: how far each past
// window got (its peak, the last few kept), and the running one's peak and skipped %.
type PaceWindow = { resetsAt: number; peak: number; skip: number }
type PaceStore = { finals: Record<string, number[]>; windows: Record<string, PaceWindow> }

// A chat reopened with a long history re-reads it all on its first reply: one big jump
// in usage. Its first turn notes the limits it started from; the first new reading
// that moved is that jump, and is left out of the pace. Only for a chat that opened
// with this much already in it (a new chat's first reply is real work).
const RESUME_MIN_TOKENS = 20_000
let isOpening = true
let openMessages = 0
let spikeFrom: { at: number; limits: Limit[] } | undefined

function median(list: number[] | undefined): number | undefined {
  if (!list || list.length === 0) return undefined
  const s = [...list].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const sameWindow = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WINDOW_MS

// the jump the reopened chat's first reply made, once a reading after it has moved
function takeSpike(): Record<string, number> | undefined {
  if (!spikeFrom || !live || live.at <= spikeFrom.at) return undefined
  const jump: Record<string, number> = {}
  for (const l of live.limits) {
    const before = spikeFrom.limits.find(b => b.kind === l.kind)
    if (before && sameWindow(before.resetsAt, l.resetsAt) && l.percentUsed > before.percentUsed) {
      jump[l.kind] = l.percentUsed - before.percentUsed
    }
  }
  if (Object.keys(jump).length === 0) return undefined
  spikeFrom = undefined
  return jump
}

async function trackPace($: EngineInterface, limits: Limit[], now: number): Promise<Record<string, PaceOf>> {
  const spike = takeSpike()
  const saved = ((await storeGet($, 'pace')) as PaceStore | undefined) ?? { finals: {}, windows: {} }
  let isChanged = false
  const pace: Record<string, PaceOf> = {}
  for (const l of limits) {
    const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!WINDOWS[l.kind] || !Number.isFinite(resetsAt) || resetsAt <= now) continue
    let w = saved.windows[l.kind]
    if (!w || Math.abs(w.resetsAt - resetsAt) > SAME_WINDOW_MS) {
      // a new window: the last one's peak is how far it got
      if (w && w.peak > 0) saved.finals[l.kind] = [...(saved.finals[l.kind] ?? []), w.peak].slice(-FINALS_KEPT)
      w = { resetsAt, peak: l.percentUsed, skip: 0 }
      saved.windows[l.kind] = w
      isChanged = true
    } else if (l.percentUsed > w.peak) {
      w.peak = l.percentUsed
      isChanged = true
    }
    const jump = spike?.[l.kind]
    if (jump) {
      w.skip = Math.min(w.peak, w.skip + jump)
      isChanged = true
    }
    pace[l.kind] = { typical: median(saved.finals[l.kind]) ?? TYPICAL_DEFAULT, skip: w.skip }
  }
  if (isChanged) await storeSet($, 'pace', saved)
  return pace
}

// The window is shown as three groups: Messages, Tools (System + MCP tools) and Other
// (the system prompt, skills, memory files, agents, MCP server instructions).
const TOOL_NAMES = new Set(['System tools', 'MCP tools'])
type Group = 'Messages' | 'Tools' | 'Other'
const groupOf = (name: string): Group => (name === 'Messages' ? 'Messages' : TOOL_NAMES.has(name) ? 'Tools' : 'Other')

// The free local breakdown ('summary') estimates each category from its text, which
// reads tools ~1.3-1.6x heavy. The exact count ('full', what /context and the app's
// Context window panel show) costs no tokens but sends one token-count request per tool
// and memory file (~320 here). So run it every 2 minutes, keep the exact/estimate ratio
// of Tools and Other (in the store, for every session), and scale the live 3s estimate
// by it; Messages is then the API's real input total less those two.
const CALIBRATE_EVERY_MS = 2 * 60_000
let calib: Partial<Record<Group, number>> = {}
let isCalibrating = false
// Right after /compact there is no API reply yet, so the window's real total is unknown
// and the local estimate is all there is. The exact count fills that gap until the next reply.
let exactCount: { at: number; sums: Record<Group, number> } | undefined
let noReplySince: number | undefined

function sumGroups(categories: readonly { name: string; tokens: number; kind: string }[]): Record<Group, number> {
  const sums: Record<Group, number> = { Messages: 0, Tools: 0, Other: 0 }
  for (const c of categories) if (c.kind === 'used') sums[groupOf(c.name)] += c.tokens
  return sums
}

async function calibrate($: EngineInterface): Promise<void> {
  if (isCalibrating) return
  isCalibrating = true
  try {
    const exact = await $.session.usage({ breakdown: 'full' })
    const rough = await $.session.usage({ breakdown: 'summary' })
    const real = sumGroups(exact.context.breakdown?.categories ?? [])
    const guess = sumGroups(rough.context.breakdown?.categories ?? [])
    const next = { ...calib }
    for (const g of ['Tools', 'Other'] as const) if (guess[g] > 0 && real[g] > 0) next[g] = real[g] / guess[g]
    calib = next
    exactCount = { at: await $.clock.now(), sums: real }
    await $.store.set('calib', next)
    lastSnapshot = ''
  } catch (error) {
    $.ui.log(`usage-quota: exact count failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    isCalibrating = false
  }
  // the usage service is asked alongside, on the same 2 minutes
  await refresh($, 'due')
}

// Auto compact fires whenever the chat is idle (no turn running) and the context
// is at or past the %: at the end of a turn, on opening a chat, on any refresh between
// turns. Held back only by: `waits` (the band is asking, or the person chose
// "after my next compact", which is also what an unanswered ask means: cleared only by
// a real compaction, never by the % flickering below), `stuck` (a compaction already ran and
// the context is still past the %: it would only repeat; dropping below clears it).
// The % is compared as the band shows it, rounded.
// a reply has been seen since the chat opened or was last compacted
let hadReply = false
async function setHold($: EngineInterface, patch: Partial<Hold>): Promise<void> {
  await update($, hold, held => ({ ...held, ...patch }))
}
let isBusy = false
let isCompacting = false
let lastPercent = 0

function compactNow($: EngineInterface): void {
  if (isCompacting) return
  isCompacting = true
  // compacting takes longer than a press or a hook may run, so a timer starts it
  $.clock.after(0, async () => {
    try {
      await $.command.run({ command: 'compact' })
    } finally {
      isCompacting = false
    }
  })
}

// Auto compact compacts through the session itself, not by typing /compact: a
// command run from the end of a turn is refused while the turn winds down, which
// is why it toasted and then did nothing. The compaction also rejects while a turn
// runs, so it is tried again a few times, a couple of seconds apart.
const AUTO_TRIES = 6
let canCompactDirectly = true
const AUTO_RETRY_MS = 2_000

function autoCompactNow($: EngineInterface, attempt = 1): void {
  if (attempt === 1) {
    if (isCompacting) return
    isCompacting = true
  }
  $.clock.after(attempt === 1 ? 1_000 : AUTO_RETRY_MS, async () => {
    try {
      // the desktop app (an SDK session) has no direct compaction: there /compact runs
      // as a turn of its own, so it is typed, as the Compact button does
      const result = canCompactDirectly
        ? await $.session.compact()
        : (await $.command.run({ command: 'compact' }), undefined)
      // held as stuck while the figures are read again, so no tick fires a second one
      await setHold($, { stuck: true })
      isCompacting = false
      if (result && 'skip' in result && result.skip) $.ui.toast(`Auto compact was skipped: ${result.skip}`)
      lastSnapshot = ''
      const usage = await $.session.usage({ breakdown: 'summary' })
      const percent = usage.context.percent ?? 0
      // still past the % after compacting: say so once, and do not loop on it
      const auto = await read($, autoCompact)
      if (auto.at !== null && Math.round(percent) >= auto.at) {
        $.ui.toast(`Context is still at ${Math.round(percent)}% after compacting, past your ${auto.at}%: auto compact waits until it drops below`)
      } else await setHold($, { stuck: false })
      await refresh($)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // any refusal of the direct way: type /compact from then on, as the button does
      if (canCompactDirectly) {
        canCompactDirectly = false
        return autoCompactNow($, attempt + 1)
      }
      if (attempt < AUTO_TRIES) return autoCompactNow($, attempt + 1)
      isCompacting = false
      $.ui.toast(`Auto compact could not start: ${reason}`)
      $.ui.log(`usage-quota: auto compact failed: ${reason}`, { to: 'debug' })
    }
  })
}

// called with the context % whenever it is read
async function watchAuto($: EngineInterface, percent: number): Promise<void> {
  lastPercent = percent
  const auto = await read($, autoCompact)
  if (!auto.isOn || auto.at === null) return
  const held = await read($, hold)
  if (Math.round(percent) < auto.at) {
    if (held.stuck) await setHold($, { stuck: false })
    return
  }
  if (held.waits || held.stuck || isBusy || isCompacting) return
  $.ui.toast(`Context at ${Math.round(percent)}%: auto compacting (set at ${auto.at}%)`)
  autoCompactNow($)
}

async function saveAuto($: EngineInterface, next: AutoCompact): Promise<void> {
  await update($, autoCompact, () => next)
  await storeSet($, `autoCompact:${autoChat ?? (await chatId($))}`, next)
}

// auto compact is set per chat: a chat that never had it opens with it off (at the
// default %); a chat reopened, or the app restarted, gets back its own. Read again
// whenever the chat's id changes (a /clear goes on under a new one, unannounced)
let autoChat: string | undefined
async function chatId($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return 'chat'
  }
}
async function loadAuto($: EngineInterface): Promise<void> {
  const id = await chatId($)
  if (id === autoChat) return
  autoChat = id
  const saved = (await storeGet($, `autoCompact:${id}`)) as AutoCompact | undefined
  await update($, autoCompact, () => (saved ? { ...saved, at: saved.at ?? AT_DEFAULT } : { isOn: false, at: AT_DEFAULT }))
  // the same chat after a reload keeps its ask and what holds it back
  if ((await read($, hold)).chat === id) return
  await update($, hold, () => ({ chat: id, waits: false, stuck: false }))
  await update($, autoAsk, () => null)
}

// auto compact's %: one click on the label steps off → 30 → 50 → 70 → off
const AT_DEFAULT = 30
const AT_STEPS = [30, 50, 70]

async function cycleAuto($: EngineInterface): Promise<void> {
  const cur = await read($, autoCompact)
  const nextAt = cur.isOn ? AT_STEPS.find(s => s > (cur.at ?? 0)) : AT_STEPS[0]
  if (nextAt === undefined) {
    await saveAuto($, { isOn: false, at: cur.at ?? AT_DEFAULT })
    await update($, autoAsk, () => null)
    await setHold($, { waits: false })
    $.ui.toast('Auto compact off')
    return
  }
  await setThreshold($, nextAt)
}

// a new threshold: armed when the context is below it, else the band asks, in its
// own buttons (never the chat's question dialog, which runs through the chat)
async function setThreshold($: EngineInterface, at: number): Promise<void> {
  await saveAuto($, { isOn: true, at })
  await askIfPast($, at)
}

// turning it on, or a new %, while the context is already past it: ask first
async function askIfPast($: EngineInterface, at: number | null): Promise<void> {
  const isPast = at !== null && Math.round(lastPercent) >= at
  await setHold($, { waits: isPast, stuck: false })
  await update($, autoAsk, () => (isPast ? { at: at!, percent: Math.round(lastPercent) } : null))
  if (!isPast && at !== null) $.ui.toast(`Auto compact at ${at}% context`)
}

type AskChoice = 'now' | 'next'

async function answerAsk($: EngineInterface, choice: AskChoice): Promise<void> {
  await update($, autoAsk, () => null)
  // 'next': goes on waiting until a compaction is seen (the reply total goes blank)
  if (choice === 'now') {
    await setHold($, { waits: false })
    autoCompactNow($)
  }
}

let isRefreshing = false
// an ask that arrived while a 3s tick was running: done right after it, not dropped
let pendingAsk: Ask = 'no'
let lastSnapshot = ''
let hadError = false

// The desktop app's theme is not told to plugins: it is read from the app's own
// settings (userThemeMode), and for "system" from the OS. Looked at every 2s so a
// switch shows at once, each look a single file-time check (the file is read only
// once it changed); the OS, for "system" alone, is asked at most every 15s
const THEME_EVERY_MS = 2_000
const SYSTEM_EVERY_MS = 15_000
let didLogTheme = false
let systemTheme: { at: number; value: 'dark' | 'light' } | undefined
async function desktopConfig($: EngineInterface): Promise<string | undefined> {
  const appData = await $.env.get('APPDATA')
  if (appData) return `${appData}/Claude/config.json`
  const home = await $.env.get('HOME')
  return home ? `${home}/Library/Application Support/Claude/config.json` : undefined
}
async function osTheme($: EngineInterface): Promise<'dark' | 'light'> {
  const now = await $.clock.now()
  if (systemTheme && now - systemTheme.at < SYSTEM_EVERY_MS) return systemTheme.value
  let value: 'dark' | 'light' = 'dark'
  try {
    if (await $.env.get('APPDATA')) {
      const { stdout } = await $.process.run(['reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { timeoutMs: 5_000 })
      if (/AppsUseLightTheme\s+REG_DWORD\s+0x1\b/.test(stdout)) value = 'light'
    } else {
      const { stdout } = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 5_000 })
      if (!/dark/i.test(stdout)) value = 'light'
    }
  } catch {
    // unknown: dark, as the band was built
  }
  systemTheme = { at: now, value }
  return value
}
// the settings file is read again only when it has changed since the last look: a
// look is otherwise one file-time check, no read, no parse
let themeFile: { mtimeMs: number; mode: string | undefined } | undefined
async function syncTheme($: EngineInterface): Promise<void> {
  let mode: string | undefined
  try {
    const path = await desktopConfig($)
    if (!path) return
    const { mtimeMs } = await $.fs.stat(path)
    if (themeFile?.mtimeMs === mtimeMs) mode = themeFile.mode
    else {
      mode = (JSON.parse(await $.fs.read(path)) as { userThemeMode?: string }).userThemeMode
      themeFile = { mtimeMs, mode }
    }
  } catch (error) {
    if (!didLogTheme) $.ui.log(`usage-quota: the app's theme could not be read: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    didLogTheme = true
    return
  }
  const next = mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : await osTheme($)
  if (next !== (await read($, theme))) await update($, theme, () => next)
}

async function refresh($: EngineInterface, ask: Ask = 'no'): Promise<void> {
  await loadAuto($)
  if (isRefreshing) {
    if (ask === 'now' || (ask === 'due' && pendingAsk === 'no')) pendingAsk = ask
    return
  }
  isRefreshing = true
  try {
    const now = await $.clock.now()
    const usage = await $.session.usage({ breakdown: 'summary' })
    const { context } = usage
    const breakdown = context.breakdown
    const all = (breakdown?.categories ?? []).filter(c => c.kind !== 'deferred' && c.tokens > 0)
    const rough = sumGroups(all)
    if (context.tokens === undefined) {
      // no reply since the chat opened or was compacted: get the exact count once
      if (noReplySince === undefined) {
        noReplySince = now
        $.clock.after(0, () => void calibrate($))
      }
    } else noReplySince = undefined
    // what the chat opened with, before its first turn here (a reopened chat may
    // already carry its last reply's total, so not only while that is blank)
    if (isOpening) openMessages = Math.max(rough.Messages, context.tokens ?? 0)
    // the reply total going blank after a reply: the chat was compacted (or cleared)
    if (context.tokens !== undefined) hadReply = true
    else if (hadReply) {
      hadReply = false
      // an ask left unanswered meant "after my next compact": done with now
      if ((await read($, hold)).waits) {
        await update($, autoAsk, () => null)
        await setHold($, { waits: false })
      }
    }
    const useExact = context.tokens === undefined && exactCount !== undefined && noReplySince !== undefined && exactCount.at >= noReplySince
    let tools = Math.round(rough.Tools * (calib.Tools ?? 1))
    let other = Math.round(rough.Other * (calib.Other ?? 1))
    // Messages is what the window holds beyond everything else, as /context counts it:
    // the API's real input total less the other groups, not the local estimate
    let messages = context.tokens !== undefined && context.tokens - tools - other > 0
      ? context.tokens - tools - other
      : rough.Messages
    if (useExact) ({ Messages: messages, Tools: tools, Other: other } = exactCount!.sums)
    const used = context.tokens ?? (useExact ? messages + tools + other : breakdown?.totalTokens ?? 0)
    const categories: Category[] = [
      { name: 'Messages', tokens: messages, kind: 'used' },
      { name: 'Tools', tokens: tools, kind: 'used' },
      { name: 'Other', tokens: other, kind: 'used' },
      ...all
        .filter(c => c.kind === 'buffer' || c.kind === 'free')
        .map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind as Category['kind'] })),
    ].filter(c => c.tokens > 0)
    const { limits, at: limitsAt, error: limitsError } = await limitsOf($, usage.rateLimits, now, ask)
    const pace = await trackPace($, limits, now)
    const next: Snapshot = {
      window: context.window,
      tokens: used,
      percent: useExact ? Math.round((used / context.window) * 100) : context.percent ?? breakdown?.percentage ?? Math.round((used / context.window) * 100),
      total: categories.reduce((sum, c) => sum + c.tokens, 0) || context.window,
      categories,
      limits,
      ...(limitsAt !== undefined ? { limitsAt } : {}),
      ...(limitsError ? { limitsError } : {}),
      ...(Object.keys(pace).length > 0 ? { pace } : {}),
      // the minute, so countdowns and ages redraw even when nothing else moves
      minute: Math.floor(now / 60_000),
    }
    await watchAuto($, next.percent)
    // redraw only when something moved, not on every tick
    const json = JSON.stringify(next)
    if (json !== lastSnapshot) {
      lastSnapshot = json
      await update($, snapshot, () => next)
    }
    if (hadError) $.ui.status(undefined)
    hadError = false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $.ui.status(`usage-quota: ${message.replace(/^usage-quota: /, '')}`)
    hadError = true
  } finally {
    isRefreshing = false
  }
  if (pendingAsk !== 'no') {
    const queued = pendingAsk
    pendingAsk = 'no'
    await refresh($, queued)
  }
}

// what each limit's time reads: the countdown to its reset, or, when it matters
// more, when it runs out or comes back
function timeOf(f: Forecast, now: number): { text: string; color: string } {
  if (f.status === 'idle') return { text: duration(WINDOWS[f.kind]?.ms ?? 0), color: MUTED }
  if (f.status === 'hit') return { text: `back ${time(f.resetsAt)}`, color: RED }
  if (f.status === 'out') return { text: `out ${duration(f.runOutAt - now)}`, color: ink(f.color) }
  return { text: duration(f.resetsAt - now), color: MUTED }
}

// The bar is one row. What fits decides what shows: bars and times, times only, or
// just the percentages. Nothing wraps unless the chat is narrower than that.
const WITH_BARS_AT = 80
const WITH_TIMES_AT = 52
// room for the longest countdown ("6d 23h"), so the next item never shifts
const TIME_CELLS = 6

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quota', description: 'Toggle the usage bar above the prompt' })
    const result = await next(e)
    try {
      calib = ((await $.store.get('calib')) as typeof calib | undefined) ?? {}
    } catch {
      calib = {}
    }
    await loadAuto($)
    await refresh($, 'due')
    // the exact count on a timer, never from the hook itself
    $.clock.after(2_000, () => void calibrate($))
    $.clock.every(CALIBRATE_EVERY_MS, () => void calibrate($))
    $.clock.every(LOCAL_EVERY_MS, () => void refresh($))
    await syncTheme($)
    $.clock.every(THEME_EVERY_MS, () => void syncTheme($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('turn.start', async ($, e, next) => {
    isBusy = true
    if (isOpening) {
      isOpening = false
      const snap = await read($, snapshot)
      if (snap && snap.limits.length > 0 && openMessages >= RESUME_MIN_TOKENS) {
        spikeFrom = { at: await $.clock.now(), limits: snap.limits }
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    spikeFrom = undefined
    // the turn is over: auto compact may fire now, never mid-reply
    isBusy = false
    const snap = await read($, snapshot)
    if (snap) await watchAuto($, snap.percent)
    return result
  })

  on('command.run', { command: 'quota' }, async $ => {
    const now = !(await read($, isOn))
    await update($, isOn, () => now)
    if (now) await refresh($, 'now')
    return { text: now ? 'Usage bar on.' : 'Usage bar off.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)

    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
    usePalette(e.surface === 'desktop' && (await read($, theme)) === 'light' ? LIGHT : DARK)
    const width = Math.max(20, e.props.bodyColumns)
    const now = await $.clock.now()

    const known = snap.limits.length === 0 ? [] : Object.keys(WINDOWS).map(kind => snap.limits.find(l => l.kind === kind) ?? { kind, percentUsed: 0 })
    const limits = known
      .map(l => forecast(l, now, snap.pace?.[l.kind]))
      .filter((f): f is Forecast => f !== null)
      .sort((a, b) => order(a.kind) - order(b.kind))
    const auto = await read($, autoCompact)
    const ask = await read($, autoAsk)
    const age = snap.limitsAt === undefined ? 0 : now - snap.limitsAt
    const isStale = !!snap.limitsError && limits.length > 0 && age >= 2 * 60_000

    const hasBars = width >= WITH_BARS_AT
    const hasTimes = width >= WITH_TIMES_AT
    const BAR_CELLS = 6
    // the terminal draws its own hide control ([-]) over the top-right corner
    const HOST_HIDE = Svg ? 0 : 4

    const bar = (alt: string, segments: Segment[]) =>
      Svg ? (
        <Box width={BAR_CELLS} height={1} alignItems="center" flexShrink={0}>
          <Svg alt={alt} source={barSvg(segments, BAR_CELLS * 8)} height={BAR_PX} />
        </Box>
      ) : (
        <Box flexDirection="row" width={BAR_CELLS} flexShrink={0}>
          {segmentRuns(segments, BAR_CELLS).map(run => (
            <Box width={run.width} backgroundColor={run.color}>
              <Text> </Text>
            </Box>
          ))}
        </Box>
      )
    const fill = (percent: number, color: string): Segment[] => [
      { color, share: Math.min(100, Math.max(0, percent)) },
      { color: TRACK, share: Math.max(0, 100 - percent) },
    ]

    // one item: a quiet label, the bar, the % in its colour, then its time
    const item = (key: string, label: string, percent: number, color: string, alt: string, after?: { text: string; color: string }) => {
      const pct = `${Math.round(percent)}%`
      return (
        <Box key={key} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          <Text color={MUTED}>{label}</Text>
          {hasBars ? bar(alt, fill(percent, color)) : null}
          <Box width={4} flexShrink={0}>
            <Text bold color={ink(color)}>{pct}</Text>
          </Box>
          {after && hasTimes ? (
            <Box width={Math.max(TIME_CELLS, after.text.length)} flexShrink={0}>
              <Text color={after.color}>{after.text}</Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    const items = [
      ...limits.map(f =>
        item(
          f.kind,
          f.kind === 'five_hour' ? '5h' : 'wk',
          f.percent,
          f.color,
          `${f.label} ${Math.round(f.percent)}% used`,
          timeOf(f, now),
        ),
      ),
      item(
        'context',
        'ctx',
        snap.percent,
        fillColor(snap.percent),
        `Context ${Math.round(snap.percent)}% used, ${tokens(snap.tokens)} of ${tokens(snap.window)}`,
      ),
    ]

    const note = limits.length === 0
      ? <Text key="note" color={snap.limitsError ? AMBER : MUTED}>{snap.limitsError ? `usage check ${snap.limitsError}` : 'limits after first reply'}</Text>
      : isStale
        ? <Text key="note" color={AMBER}>{`${duration(age)} old`}</Text>
        : null

    const controls = ask ? (
      <Box key="ask" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
        <Text color={AMBER}>{`ctx ${ask.percent}%, past ${ask.at}%:`}</Text>
        <Button key="askNow" label="compact now" plain hover={{ backgroundColor: COMPACT_LIT }} onPress={() => void answerAsk($, 'now')} />
        <Button key="askNext" label="after next" plain hover={{ backgroundColor: COMPACT_LIT }} onPress={() => void answerAsk($, 'next')} />
      </Box>
    ) : (
      <Box key="controls" flexDirection="row" alignItems="center" columnGap={2} flexShrink={0}>
        <Button
          key="auto"
          label={auto.isOn ? `auto ${auto.at ?? AT_DEFAULT}%` : 'auto off'}
          plain
          hover={{ backgroundColor: COMPACT_LIT }}
          onPress={() => void cycleAuto($)}
        />
        <Button key="compact" label="compact" plain hover={{ backgroundColor: COMPACT_LIT }} onPress={() => compactNow($)} />
      </Box>
    )

    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={3} flexWrap="wrap" paddingRight={HOST_HIDE}>
        <Box flexDirection="row" alignItems="center" columnGap={3} flexShrink={1} flexWrap="wrap">
          {items}
          {note}
        </Box>
        {controls}
      </Box>
    )
  })
}
