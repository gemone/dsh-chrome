import { describe, expect, it } from 'vitest'
import {
  Observatory,
  browserLogLevel,
  consoleApiLevel,
  formatActivityHint,
  formatConsoleRead,
  formatNetEntry,
  formatNetList,
  levelAtLeast,
  serializeConsoleArgs,
} from '../src/observatory.ts'

function netEntry(overrides: Partial<Parameters<Observatory['recordRequest']>[0]> = {}) {
  return {
    requestId: 'r1',
    url: 'https://example.com/x.js',
    method: 'GET',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('Observatory network recording', () => {
  it('records requests and attaches response metadata', () => {
    const obs = new Observatory()
    obs.recordRequest(netEntry())
    obs.recordResponse({ requestId: 'r1', status: 200, mimeType: 'application/javascript' })
    const { entries } = obs.netSince()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ status: 200, mimeType: 'application/javascript', failed: false })
  })

  it('folds redirect re-emissions into one entry', () => {
    const obs = new Observatory()
    obs.recordRequest(netEntry({ url: 'https://a.com' }))
    obs.recordRequest(netEntry({ url: 'https://b.com', redirects: 1 }))
    const { entries } = obs.netSince()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.url).toBe('https://b.com')
    expect(entries[0]?.redirects).toBe(1)
  })

  it('marks failures and filters with failedOnly', () => {
    const obs = new Observatory()
    obs.recordRequest(netEntry({ requestId: 'ok', url: 'https://a.com' }))
    obs.recordRequest(netEntry({ requestId: 'bad', url: 'https://b.com' }))
    obs.recordResponse({ requestId: 'ok', status: 200 })
    obs.recordFailure({ requestId: 'bad', errorText: 'net::ERR_NAME_NOT_RESOLVED' })
    const all = obs.netSince()
    const failed = obs.netSince({ failedOnly: true })
    expect(all.entries).toHaveLength(2)
    expect(failed.entries.map(e => e.requestId)).toEqual(['bad'])
    expect(failed.entries[0]?.errorText).toBe('net::ERR_NAME_NOT_RESOLVED')
  })

  it('evicts oldest beyond the ring capacity and counts drops', () => {
    const obs = new Observatory(3)
    for (let i = 0; i < 5; i++) obs.recordRequest(netEntry({ requestId: `r${i}`, url: `https://x/${i}` }))
    const result = obs.netSince()
    expect(result.entries.map(e => e.requestId)).toEqual(['r2', 'r3', 'r4'])
    expect(result.dropped).toBe(2)
    expect(result.total).toBe(5)
    // Evicted request ids are no longer resolvable.
    expect(obs.netEntry('r0')).toBeUndefined()
    expect(obs.netEntry('r4')).toBeDefined()
  })

  it('honors since cursors and maxEntries (newest win)', () => {
    const obs = new Observatory()
    for (let i = 0; i < 4; i++) obs.recordRequest(netEntry({ requestId: `r${i}`, url: `https://x/${i}` }))
    const first = obs.netSince({ maxEntries: 2 })
    expect(first.entries.map(e => e.requestId)).toEqual(['r2', 'r3'])
    expect(first.truncated).toBe(true)
    const cursor = first.entries[0]!.seq
    const rest = obs.netSince({ since: cursor })
    expect(rest.entries.map(e => e.requestId)).toEqual(['r3'])
  })
})

describe('Observatory console recording', () => {
  it('records console calls with mapped levels and bounded text', () => {
    const obs = new Observatory()
    obs.recordConsole({ type: 'error', args: [{ type: 'string', value: 'boom' }], timestamp: 1 })
    obs.recordConsole({ type: 'log', args: [{ type: 'object', description: 'Object details' }], timestamp: 2 })
    const read = obs.consoleSince({ minLevel: 'log' }, 0)
    expect(read.entries).toHaveLength(2)
    expect(read.entries[0]).toMatchObject({ level: 'error', source: 'console', text: 'boom' })
    expect(read.entries[1]?.level).toBe('log')
    expect(read.cursor).toBe(read.entries[1]!.index + 1)
  })

  it('records uncaught exceptions as error entries', () => {
    const obs = new Observatory()
    obs.recordException({ text: 'Uncaught', description: 'TypeError: x is not a function', timestamp: 1, url: 'app.js', lineNumber: 42 })
    const read = obs.consoleSince({ minLevel: 'error' }, 0)
    expect(read.entries[0]).toMatchObject({ source: 'exception', level: 'error', url: 'app.js', lineNumber: 42 })
    expect(read.entries[0]?.text).toContain('TypeError')
  })

  it('records dialogs with their answer policy', () => {
    const obs = new Observatory()
    obs.recordDialog({ kind: 'confirm', message: 'Leave site?', url: 'https://x.com/', response: 'accepted', timestamp: 1 })
    obs.recordDialog({ kind: 'prompt', message: 'Enter name', response: 'dismissed', timestamp: 2 })
    const read = obs.consoleSince({ minLevel: 'warning' }, 0)
    expect(read.entries).toHaveLength(2)
    expect(read.entries[0]).toMatchObject({ source: 'dialog', level: 'warning', url: 'https://x.com/' })
    expect(read.entries[0]?.text).toContain('confirm dialog accepted')
    expect(read.entries[1]?.text).toContain('prompt dialog dismissed')
    expect(formatConsoleRead(read)).toContain('(dialog)')
  })

  it('only returns unread entries after the cursor advances', () => {
    const obs = new Observatory()
    obs.recordConsole({ type: 'error', args: [{ type: 'string', value: 'e1' }], timestamp: 1 })
    const first = obs.consoleSince({}, 0)
    expect(first.entries).toHaveLength(1)
    obs.recordConsole({ type: 'error', args: [{ type: 'string', value: 'e2' }], timestamp: 2 })
    const second = obs.consoleSince({}, first.cursor)
    expect(second.entries.map(e => e.text)).toEqual(['e2'])
    const everything = obs.consoleSince({ all: true }, second.cursor)
    expect(everything.entries).toHaveLength(2)
  })

  it('filters by minimum level', () => {
    const obs = new Observatory()
    obs.recordConsole({ type: 'log', args: [{ type: 'string', value: 'noise' }], timestamp: 1 })
    obs.recordConsole({ type: 'warning', args: [{ type: 'string', value: 'warn' }], timestamp: 2 })
    obs.recordConsole({ type: 'error', args: [{ type: 'string', value: 'err' }], timestamp: 3 })
    const read = obs.consoleSince({ minLevel: 'warning' }, 0)
    expect(read.entries.map(e => e.level)).toEqual(['warning', 'error'])
  })

  it('evicts oldest beyond the ring capacity', () => {
    const obs = new Observatory(2)
    for (let i = 0; i < 4; i++) obs.recordConsole({ type: 'error', args: [{ type: 'string', value: `e${i}` }], timestamp: i })
    const read = obs.consoleSince({ all: true }, 0)
    expect(read.entries.map(e => e.text)).toEqual(['e2', 'e3'])
    expect(read.dropped).toBe(2)
    expect(read.total).toBe(4)
  })
})

describe('Observatory unread hints', () => {
  it('counts download lifecycle entries as unread activity (README promises hint coverage)', () => {
    const obs = new Observatory()
    obs.recordDownload({ state: 'completed', filename: 'report.bin', path: '/tmp/report.bin', receivedBytes: 10, totalBytes: 10, timestamp: 1 })
    expect(obs.unread(0, 0).consoleEntries).toBe(1)
    expect(formatActivityHint(obs.unread(0, 0))).toContain('chrome_console_read')
  })

  it('counts unread console errors and failed requests per cursors', () => {
    const obs = new Observatory()
    obs.recordConsole({ type: 'error', args: [{ type: 'string', value: 'e1' }], timestamp: 1 })
    obs.recordRequest(netEntry({ requestId: 'bad', url: 'https://b.com' }))
    obs.recordFailure({ requestId: 'bad', errorText: 'net::ERR_FAILED' })
    obs.recordRequest(netEntry({ requestId: 'ok', url: 'https://a.com' }))
    obs.recordResponse({ requestId: 'ok', status: 200 })

    const before = obs.unread(0, 0)
    expect(before).toEqual({ consoleEntries: 1, failedRequests: 1 })

    const read = obs.consoleSince({}, 0)
    const afterConsole = obs.unread(0, read.cursor)
    expect(afterConsole.consoleEntries).toBe(0)

    const net = obs.netSince()
    const afterNet = obs.unread(net.entries[net.entries.length - 1]!.seq + 1, read.cursor)
    expect(afterNet.failedRequests).toBe(0)
  })
})

describe('level mapping and serialization', () => {
  it('maps console API types and browser log levels', () => {
    expect(consoleApiLevel('error')).toBe('error')
    expect(consoleApiLevel('warning')).toBe('warning')
    expect(consoleApiLevel('dir')).toBe('log')
    expect(consoleApiLevel('trace')).toBe('debug')
    expect(browserLogLevel('verbose')).toBe('debug')
    expect(browserLogLevel('mystery')).toBe('log')
  })

  it('orders severity with levelAtLeast', () => {
    expect(levelAtLeast('error', 'warning')).toBe(true)
    expect(levelAtLeast('log', 'warning')).toBe(false)
    expect(levelAtLeast('warning', 'warning')).toBe(true)
  })

  it('serializes console args from value or description, bounded', () => {
    expect(serializeConsoleArgs([])).toBe('')
    expect(serializeConsoleArgs([{ type: 'string', value: 'a' }, { type: 'number', value: 1 }])).toBe('a 1')
    expect(serializeConsoleArgs([{ type: 'undefined' }])).toBe('undefined')
    expect(serializeConsoleArgs([{ type: 'object', value: null }])).toBe('null')
    expect(serializeConsoleArgs([{ type: 'object', description: 'HTMLDivElement' }])).toBe('HTMLDivElement')
    const long = 'x'.repeat(1000)
    expect(serializeConsoleArgs([{ type: 'string', value: long }]).length).toBeLessThan(900)
  })
})

describe('formatting', () => {
  it('formats net entries and lists', () => {
    const obs = new Observatory()
    obs.recordRequest(netEntry({ requestId: 'bad', url: 'https://b.com', method: 'POST', resourceType: 'Fetch' }))
    obs.recordFailure({ requestId: 'bad', errorText: 'net::ERR_FAILED' })
    const text = formatNetList(obs.netSince({ failedOnly: true }), true)
    expect(text).toContain('POST FAILED')
    expect(text).toContain('(requestId: bad)')
    expect(text).toContain('net::ERR_FAILED')
    expect(text).toContain('chrome_net_body')
    expect(formatNetList(obs.netSince({ since: 10_000 }), false)).toContain('No network requests recorded')
  })

  it('formats console reads and the empty case', () => {
    const obs = new Observatory()
    obs.recordException({ text: 'Uncaught', description: 'TypeError: nope', timestamp: 1, url: 'app.js', lineNumber: 7 })
    const text = formatConsoleRead(obs.consoleSince({ minLevel: 'debug' }, 0))
    expect(text).toContain('ERROR (exception) @ app.js:7')
    expect(text).toContain('TypeError: nope')
    expect(formatConsoleRead(new Observatory().consoleSince({ all: true }, 0))).toContain('No console entries')
  })

  it('renders the activity hint only when there is unread activity', () => {
    expect(formatActivityHint({ consoleEntries: 0, failedRequests: 0 })).toBe('')
    const hint = formatActivityHint({ consoleEntries: 2, failedRequests: 1 })
    expect(hint).toContain('2 unread console/dialog entry(ies)')
    expect(hint).toContain('1 failed request(s)')
    expect(hint).toContain('chrome_console_read')
    expect(hint).toContain('chrome_net_list')
  })
})

describe('Observatory construction', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new Observatory(0)).toThrow(/positive integer/)
    expect(() => new Observatory(-1)).toThrow(/positive integer/)
  })
})
