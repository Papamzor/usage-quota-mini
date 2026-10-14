export type Category = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type PaceOf = { typical: number; skip: number }
export type Snapshot = {
  window: number
  tokens: number
  percent: number
  total: number
  categories: Category[]
  limits: Limit[]
  /** when the limit figures were read */
  limitsAt?: number
  /** why the usage service last refused, while it is backed off */
  limitsError?: string
  /** per window kind: the usual final % and the one-off % left out of the pace */
  pace?: Record<string, PaceOf>
  /** the minute it was taken in: redraws countdowns at least once a minute */
  minute?: number
}

/** auto compact: on or off, and the context % that sets it off (kept for every chat) */
export type AutoCompact = { isOn: boolean; at: number | null }

/** what holds auto compact back in a chat: an ask (or "after my next compact"), or a compaction that left it past the % */
export type Hold = { chat: string; waits: boolean; stuck: boolean }

declare module 'claude-code' {
  interface PluginState {
    'usage-quota-mini': {
      snapshot: Snapshot | null
      isOn: boolean
      autoCompact: AutoCompact
      /** the choice the bar is asking for: the context was already past a new % */
      autoAsk: { at: number; percent: number } | null
      hold: Hold
      /** the desktop app's theme, as its settings (or the OS) have it */
      theme: 'dark' | 'light'
    }
  }
}
