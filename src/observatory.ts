/**
 * The observatory: in-memory ring buffers of what the page did on its own —
 * network requests and console output / uncaught exceptions — recorded from
 * CDP events while the session is connected. Pure data + pure formatting so
 * every rule is unit-testable without a browser.
 * @module dsh-chrome/observatory
 */

/** Default ring-buffer capacity per stream (entries beyond are dropped). */
export const DEFAULT_OBSERVATORY_MAX_ENTRIES = 500

/** Default character cap when fetching one network response body. */
export const DEFAULT_NET_BODY_MAX_CHARS = 100_000

/** Console severity levels, ordered from least to most severe. */
export type ConsoleLevel = 'debug' | 'log' | 'info' | 'warning' | 'error'

/** Severity ordering used by minimum-level filtering. */
const LEVEL_RANK: Readonly<Record<ConsoleLevel, number>> = {
  debug: 0,
  log: 1,
  info: 2,
  warning: 3,
  error: 4,
}

/** True when `level` is at least `min` in severity. Pure. */
export function levelAtLeast(level: ConsoleLevel, min: ConsoleLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min]
}

/** One tracked network request (mutated in place as CDP events arrive). */
export interface NetEntry {
  /** Monotonic recording sequence, stamped on insert ("since" cursor domain). */
  seq: number
  /** CDP request id — the key for `chrome_net_body`. */
  requestId: string
  url: string
  method: string
  /** Wall-clock epoch ms when the request was sent. */
  timestamp: number
  /** CDP resource type (Document, Script, XHR, Fetch, Image, …). */
  resourceType?: string
  /** HTTP status code, when a response arrived. */
  status?: number
  /** Response MIME type, when known. */
  mimeType?: string
  /** Whether loading failed or was canceled. */
  failed?: boolean
  /** CDP failure text (`net::ERR_…`), when failed. */
  errorText?: string
  /** Whether the load was canceled (as opposed to erroring). */
  canceled?: boolean
  /** Redirect chain length before the final request, when > 0. */
  redirects?: number
}

/** One console message, uncaught exception, or browser log entry. */
export interface ConsoleEntry {
  /** Monotonic sequence number, stable across the whole connection. */
  index: number
  /** Where it came from. */
  source: 'console' | 'exception' | 'browser-log'
  /** Severity; exceptions and failed browser logs map to `error`. */
  level: ConsoleLevel
  /** One-line human-readable text (bounded). */
  text: string
  /** Wall-clock epoch ms. */
  timestamp: number
  /** Script URL the entry originated from, when known. */
  url?: string
  /** Line number in that script, when known. */
  lineNumber?: number
}

/** Filter for {@link Observatory.netSince}. */
export interface NetListFilter {
  /** Only entries whose load failed or was canceled. */
  failedOnly?: boolean
  /** Return entries newer than this sequence number (exclusive). */
  since?: number
  /** Cap on returned entries (most recent win). */
  maxEntries?: number
}

/** Result of listing network entries. */
export interface NetListResult {
  readonly entries: readonly NetEntry[]
  /** Total entries ever recorded (including dropped and filtered-out ones). */
  readonly total: number
  /** Entries evicted by the ring buffer so far. */
  readonly dropped: number
  /** Whether `entries` was cut by `maxEntries` (the newest are kept). */
  readonly truncated: boolean
}

/** Filter for {@link Observatory.consoleSince}. */
export interface ConsoleReadFilter {
  /** Minimum severity to include. */
  minLevel?: ConsoleLevel
  /** Return entries older than the unread cursor too. */
  all?: boolean
  /** Cap on returned entries (oldest first). */
  maxEntries?: number
}

/** Result of reading console entries. */
export interface ConsoleReadResult {
  readonly entries: readonly ConsoleEntry[]
  /** Total entries ever recorded (including dropped ones). */
  readonly total: number
  /** Sequence number the next read continues from (the new cursor). */
  readonly cursor: number
  /** Entries evicted by the ring buffer so far. */
  readonly dropped: number
  /** Whether more entries beyond `maxEntries` remain unread. */
  readonly truncated: boolean
}

/** Count of activity the model has not been shown yet (drives auto-hints). */
export interface UnreadActivity {
  readonly consoleEntries: number
  readonly failedRequests: number
}

/** Max characters of one console entry's serialized text. */
const ENTRY_TEXT_LIMIT = 400

/**
 * Ring-buffered record of network + console activity for one CDP session.
 * All mutation goes through the `record*` methods; reads are pure.
 */
export class Observatory {
  private readonly netEntries: NetEntry[] = []
  private readonly consoleEntries: ConsoleEntry[] = []
  private readonly netById = new Map<string, NetEntry>()
  private consoleCursor = 0
  private netSeq = 0
  private droppedNet = 0
  private droppedConsole = 0

  constructor(private readonly maxEntries: number = DEFAULT_OBSERVATORY_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('observatory maxEntries must be a positive integer')
    }
  }

  /** Next console entry sequence number (also the read cursor domain). */
  get nextConsoleIndex(): number {
    return this.consoleCursor
  }

  /** Count of a stream's entries currently retained (pre-eviction basis). */
  get size(): { net: number; console: number } {
    return { net: this.netEntries.length, console: this.consoleEntries.length }
  }

  /** Begin tracking a request. */
  recordRequest(entry: {
    requestId: string
    url: string
    method: string
    timestamp: number
    resourceType?: string
    redirects?: number
  }): void {
    const existing = this.netById.get(entry.requestId)
    if (existing !== undefined) {
      // A redirect re-emits requestWillBeSent with the same id: fold it in.
      existing.url = entry.url
      existing.method = entry.method
      existing.redirects = entry.redirects
      return
    }
    const record: NetEntry = {
      seq: 0,
      requestId: entry.requestId,
      url: entry.url,
      method: entry.method,
      timestamp: entry.timestamp,
      ...entry.resourceType !== undefined ? { resourceType: entry.resourceType } : {},
      ...entry.redirects !== undefined && entry.redirects > 0 ? { redirects: entry.redirects } : {},
    }
    this.netById.set(entry.requestId, record)
    this.pushNet(record)
  }

  /** Attach response metadata to a tracked request. */
  recordResponse(params: {
    requestId: string
    status?: number
    mimeType?: string
    resourceType?: string
  }): void {
    const record = this.netById.get(params.requestId)
    if (record === undefined) return
    if (params.status !== undefined) record.status = params.status
    if (params.mimeType !== undefined) record.mimeType = params.mimeType
    if (params.resourceType !== undefined && record.resourceType === undefined) {
      record.resourceType = params.resourceType
    }
    record.failed = false
  }

  /** Mark a tracked request as failed or canceled. */
  recordFailure(params: { requestId: string; errorText?: string; canceled?: boolean }): void {
    const record = this.netById.get(params.requestId)
    if (record === undefined) return
    record.failed = true
    if (params.errorText !== undefined) record.errorText = params.errorText
    if (params.canceled === true) record.canceled = true
  }

  /** Record one `Runtime.consoleAPICalled` event. */
  recordConsole(params: {
    type: string
    args: readonly unknown[]
    timestamp: number
    url?: string
    lineNumber?: number
  }): void {
    const level = consoleApiLevel(params.type)
    this.pushConsole({
      index: this.consoleCursor++,
      source: 'console',
      level,
      text: serializeConsoleArgs(params.args),
      timestamp: params.timestamp,
      ...params.url !== undefined ? { url: params.url } : {},
      ...params.lineNumber !== undefined ? { lineNumber: params.lineNumber } : {},
    })
  }

  /** Record one uncaught `Runtime.exceptionThrown` event. */
  recordException(params: {
    text: string
    description?: string
    timestamp: number
    url?: string
    lineNumber?: number
  }): void {
    this.pushConsole({
      index: this.consoleCursor++,
      source: 'exception',
      level: 'error',
      text: params.description ?? params.text,
      timestamp: params.timestamp,
      ...params.url !== undefined ? { url: params.url } : {},
      ...params.lineNumber !== undefined ? { lineNumber: params.lineNumber } : {},
    })
  }

  /** Record one `Log.entryAdded` event (browser-side: CSP, network errors…). */
  recordBrowserLog(params: {
    level: string
    text: string
    timestamp: number
    url?: string
    lineNumber?: number
  }): void {
    this.pushConsole({
      index: this.consoleCursor++,
      source: 'browser-log',
      level: browserLogLevel(params.level),
      text: params.text,
      timestamp: params.timestamp,
      ...params.url !== undefined ? { url: params.url } : {},
      ...params.lineNumber !== undefined ? { lineNumber: params.lineNumber } : {},
    })
  }

  /** Look up one tracked network entry by CDP request id. */
  netEntry(requestId: string): NetEntry | undefined {
    return this.netById.get(requestId)
  }

  /** List network entries per the filter. Pure. */
  netSince(filter: NetListFilter = {}): NetListResult {
    const since = filter.since ?? -1
    let matched = this.netEntries.filter(entry => {
      if (filter.failedOnly === true && entry.failed !== true) return false
      return entry.seq > since
    })
    const total = this.netTotal
    const truncated = filter.maxEntries !== undefined && matched.length > filter.maxEntries
    if (truncated) matched = matched.slice(-filter.maxEntries!)
    return { entries: matched, total, dropped: this.droppedNet, truncated }
  }

  /** Read console entries per the filter; returns the advanced cursor. Pure. */
  consoleSince(filter: ConsoleReadFilter = {}, readCursor: number): ConsoleReadResult {
    const min = filter.minLevel ?? 'log'
    const from = filter.all === true ? -1 : readCursor
    let matched = this.consoleEntries.filter(entry =>
      entry.index >= from && levelAtLeast(entry.level, min),
    )
    const total = this.consoleCursor
    const truncated = filter.maxEntries !== undefined && matched.length > filter.maxEntries
    if (truncated) matched = matched.slice(0, filter.maxEntries!)
    const cursor = matched.length > 0
      ? matched[matched.length - 1]!.index + 1
      : (filter.all === true ? this.consoleCursor : Math.max(readCursor, this.consoleCursor))
    return { entries: matched, total, cursor, dropped: this.droppedConsole, truncated }
  }

  /** Count unread activity relative to the model's read cursors. Pure. */
  unread(netReadIndex: number, consoleReadIndex: number): UnreadActivity {
    return {
      consoleEntries: this.consoleEntries.filter(entry => entry.index >= consoleReadIndex && entry.level === 'error').length,
      failedRequests: this.netEntries.filter(entry => entry.failed === true && entry.seq >= netReadIndex).length,
    }
  }

  /** Total network entries ever recorded (retained + evicted). */
  private get netTotal(): number {
    return this.netEntries.length + this.droppedNet
  }

  private pushNet(entry: NetEntry): void {
    entry.seq = ++this.netSeq
    this.netEntries.push(entry)
    while (this.netEntries.length > this.maxEntries) {
      const evicted = this.netEntries.shift()
      if (evicted !== undefined) this.netById.delete(evicted.requestId)
      this.droppedNet++
    }
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleEntries.push(entry)
    while (this.consoleEntries.length > this.maxEntries) {
      this.consoleEntries.shift()
      this.droppedConsole++
    }
  }
}

/** Map a `Runtime.consoleAPICalled` type to a severity level. Pure. */
export function consoleApiLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'error': return 'error'
    case 'warning': return 'warning'
    case 'info': return 'info'
    case 'debug': case 'trace': return 'debug'
    default: return 'log'
  }
}

/** Map a `Log.entryAdded` level to a severity level. Pure. */
export function browserLogLevel(level: string): ConsoleLevel {
  switch (level) {
    case 'error': return 'error'
    case 'warning': return 'warning'
    case 'info': return 'info'
    case 'verbose': case 'debug': return 'debug'
    default: return 'log'
  }
}

/**
 * Serialize `Runtime.consoleAPICalled` args into one bounded line, the way
 * DevTools would render them: value > description > undefined placeholder.
 * Pure.
 */
export function serializeConsoleArgs(args: readonly unknown[]): string {
  if (args.length === 0) return ''
  const parts = args.slice(0, 8).map(arg => {
    const obj = arg as { type?: string; value?: unknown; description?: string }
    if (obj.type === 'string' || obj.type === 'number' || obj.type === 'boolean') {
      return String(obj.value)
    }
    if (obj.type === 'undefined') return 'undefined'
    if (obj.type === 'object' && obj.value === null) return 'null'
    if (typeof obj.description === 'string' && obj.description.length > 0) {
      return obj.description.length > ENTRY_TEXT_LIMIT
        ? `${obj.description.slice(0, ENTRY_TEXT_LIMIT)}…`
        : obj.description
    }
    if (obj.value !== undefined) {
      let text: string
      try { text = JSON.stringify(obj.value) ?? String(obj.value) } catch { text = String(obj.value) }
      return text.length > ENTRY_TEXT_LIMIT ? `${text.slice(0, ENTRY_TEXT_LIMIT)}…` : text
    }
    return obj.type ?? 'unknown'
  })
  const text = parts.join(' ')
  return text.length > ENTRY_TEXT_LIMIT * 2 ? `${text.slice(0, ENTRY_TEXT_LIMIT * 2)}…` : text
}

/** Render one net entry as a compact model-facing line. Pure. */
export function formatNetEntry(entry: NetEntry): string {
  const status = entry.status !== undefined
    ? String(entry.status)
    : entry.failed ? 'FAILED' : '…'
  const parts = [
    entry.method,
    status,
    entry.resourceType ?? '',
    entry.url,
    `(requestId: ${entry.requestId})`,
  ].filter(part => part.length > 0)
  let line = parts.join(' ')
  if (entry.errorText !== undefined) line += ` — ${entry.errorText}`
  else if (entry.canceled === true) line += ' — canceled'
  if (entry.redirects !== undefined) line += ` (${entry.redirects} redirect(s))`
  return line
}

/** Render a {@link NetListResult} as model-facing text. Pure. */
export function formatNetList(result: NetListResult, failedOnly: boolean): string {
  if (result.entries.length === 0) {
    return `No ${failedOnly ? 'failed ' : ''}network requests recorded.`
      + (result.dropped > 0 ? ` (${result.dropped} older entries were evicted from the buffer.)` : '')
  }
  const header = `${result.entries.length} request(s)${failedOnly ? ' (failed only)' : ''}`
    + (result.truncated ? ` — showing the most recent, older entries truncated` : '')
    + (result.dropped > 0 ? ` — ${result.dropped} oldest evicted` : '')
    + '. Use chrome_net_body with a requestId to read a response body.\n\n'
  return header + result.entries.map(formatNetEntry).join('\n')
}

/** Render a {@link ConsoleReadResult} as model-facing text. Pure. */
export function formatConsoleRead(result: ConsoleReadResult): string {
  if (result.entries.length === 0) {
    return `No console entries at the requested level.`
      + (result.dropped > 0 ? ` (${result.dropped} older entries were evicted from the buffer.)` : '')
  }
  const header = `${result.entries.length} entr(y/ies)`
    + (result.truncated ? ` — truncated, read again for more` : '')
    + (result.dropped > 0 ? ` — ${result.dropped} oldest evicted` : '')
    + '\n\n'
  const lines = result.entries.map(entry => {
    const url = entry.url !== undefined && entry.url.length > 0 ? entry.url : undefined
    const loc = url !== undefined
      ? ` @ ${url}${entry.lineNumber !== undefined ? `:${entry.lineNumber}` : ''}`
      : ''
    return `[${entry.index}] ${entry.level.toUpperCase()} (${entry.source})${loc}: ${entry.text}`
  })
  return header + lines.join('\n')
}

/**
 * One-line nudge appended to other tools' output when unread errors exist, so
 * the model learns about page failures without polling. Pure; empty when quiet.
 */
export function formatActivityHint(activity: UnreadActivity): string {
  const parts: string[] = []
  if (activity.consoleEntries > 0) {
    parts.push(`${activity.consoleEntries} unread console error(s) — use chrome_console_read`)
  }
  if (activity.failedRequests > 0) {
    parts.push(`${activity.failedRequests} failed request(s) — use chrome_net_list({ failedOnly: true })`)
  }
  if (parts.length === 0) return ''
  return `\n\n[page activity: ${parts.join('; ')}]`
}
