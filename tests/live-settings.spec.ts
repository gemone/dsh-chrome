import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { apply, Config, TOOL_KEYS } from '../src/index.ts'
import { FAMILY_REGISTERERS } from '../src/registry.ts'
import * as reading from '../src/reading.ts'
import * as interact from '../src/interact.ts'
import * as capture from '../src/capture.ts'
import * as observatoryFamily from '../src/observatory.family.ts'
import * as session from '../src/session.ts'
import { ChromeRuntime } from '../src/service.ts'
import { settingsFrom, analysisRouteFrom, assertPositiveInteger, SETTING_DEFAULTS, type ResolvedChromeConfig } from '../src/settings.ts'
import { Observatory } from '../src/observatory.ts'

/** The shared-symbol write protocol from `@deepseek-ai/cosmokit`: how a runtime commits a new snapshot into a stable reference. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Commit `value` into a resolved volatile reference, as the loader does on an accepted settings edit. */
function commit(ref: { get(): unknown }, value: unknown): void {
  ;(ref as unknown as Record<symbol, (value: unknown) => void>)[VOLATILE_WRITE](value)
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeExecutor)
  return ctx
}

/** Registered chrome tool names, as the registry sees them. */
function registeredTools(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name)
}

/** Core row + every family row, on one context. */
function applyAll(ctx: Context): void {
  apply(ctx, Config({}))
  for (const family of [reading, interact, capture, observatoryFamily, session]) {
    family.apply(ctx)
  }
}

describe('volatile config resolution', () => {
  it('resolves live fields as stable references with schema defaults', () => {
    const config = Config({}) as unknown as ResolvedChromeConfig
    expect(config.reuseExisting.get()).toBe(true)
    expect(config.operationTimeoutMs.get()).toBe(SETTING_DEFAULTS.operationTimeoutMs)
    expect(config.connectTimeoutMs.get()).toBe(SETTING_DEFAULTS.connectTimeoutMs)
    expect(config.networkIdleMs.get()).toBe(SETTING_DEFAULTS.networkIdleMs)
    expect(config.snapshotMaxChars.get()).toBe(SETTING_DEFAULTS.snapshotMaxChars)
    expect(config.pageSnapshotMaxNodes.get()).toBe(SETTING_DEFAULTS.pageSnapshotMaxNodes)
    expect(config.dialogPolicy.get()).toBe('accept')
    expect(config.dialogPromptText.get()).toBeUndefined()
    expect(config.downloadDir.get()).toBeUndefined()
    expect(config.screenshotAnalysis.get()).toEqual({})
    expect(config.occupiedPortPolicy.get()).toBe('reuse')
    // Static launch fields stay plain values.
    expect(config.port).toBe(SETTING_DEFAULTS.port)
    expect(config.launch).toBe(true)
    expect(config.extraArgs).toEqual([])
  })

  it('settingsFrom reads the live snapshot at each call', () => {
    const config = Config({ reuseExisting: false }) as unknown as ResolvedChromeConfig
    const settings = settingsFrom(config)
    expect(settings.reuseExisting()).toBe(false)
    // A settings edit commits into the same reference; the next read sees it.
    commit(config.reuseExisting, true)
    expect(settings.reuseExisting()).toBe(true)
  })

  it('rejects partial screenshotAnalysis sections, on load and on live edits', () => {
    expect(() => analysisRouteFrom(Config({ screenshotAnalysis: { provider: 'openai' } }).screenshotAnalysis.get())).toThrow(/provider.*model/)
    expect(analysisRouteFrom(Config({}).screenshotAnalysis.get())).toBeUndefined()
    const route = analysisRouteFrom(Config({ screenshotAnalysis: { provider: 'p', model: 'm', maxTokens: 100 } }).screenshotAnalysis.get())
    expect(route).toEqual({ provider: 'p', model: 'm', maxTokens: 100 })
  })

  it('live numeric reads enforce the plugin-level positive-integer invariant', () => {
    const config = Config({}) as unknown as ResolvedChromeConfig
    const settings = settingsFrom(config)
    commit(config.operationTimeoutMs, 0)
    expect(() => settings.operationTimeoutMs()).toThrow(/operationTimeoutMs must be a positive integer/)
  })
})

describe('live tool-surface reconcile on loader/volatile-update', () => {
  it('refreshes the declared timeoutMs of every tool on a timeout edit', async () => {
    const ctx = await setup()
    const config = Config({}) as unknown as ResolvedChromeConfig
    // Apply with THIS resolution so the reconcile listener closes over the
    // same volatile references the test commits into.
    apply(ctx, config)
    for (const family of [reading, interact, capture, observatoryFamily, session]) {
      family.apply(ctx)
    }
    expect(ctx.tools.get('chrome_connect')?.timeoutMs).toBe(SETTING_DEFAULTS.connectTimeoutMs)
    expect(ctx.tools.get('chrome_navigate')?.timeoutMs).toBe(SETTING_DEFAULTS.operationTimeoutMs)

    commit(config.operationTimeoutMs, 45_000)
    commit(config.connectTimeoutMs, 60_000)
    ctx.emit('loader/volatile-update', [['operationTimeoutMs'], ['connectTimeoutMs']])
    // The core row re-registers its own lifecycle tools...
    expect(ctx.tools.get('chrome_connect')?.timeoutMs).toBe(60_000)
    expect(ctx.tools.get('chrome_close')?.timeoutMs).toBe(45_000)
    // ...and the broadcast refreshes the family rows too.
    expect(ctx.tools.get('chrome_navigate')?.timeoutMs).toBe(45_000)
    // Other live fields (read at use time) also reflect the edit.
    expect(ctx.chrome.settings.operationTimeoutMs()).toBe(45_000)
  })

  it('a volatile-update touching only use-time fields does not re-register', async () => {
    const ctx = await setup()
    const config = Config({}) as unknown as ResolvedChromeConfig
    applyAll(ctx)
    const definition = ctx.tools.get('chrome_snapshot')
    const snapshotDefaults = definition?.parameters.properties.maxChars.description

    commit(config.snapshotMaxChars, 1000)
    ctx.emit('loader/volatile-update', [['snapshotMaxChars']])
    // Registration-time metadata (descriptions) is untouched — the value is
    // read live per call instead — but the surface stays registered.
    expect(ctx.tools.get('chrome_snapshot')).toBe(definition)
    expect(ctx.tools.get('chrome_snapshot')?.parameters.properties.maxChars.description).toBe(snapshotDefaults)
  })

  it('family rows cover every family key exactly once', () => {
    // The five family rows partition the family key set; the lifecycle tools
    // (connect/close) live on the core row and are not family keys.
    const familyKeys = Object.keys(FAMILY_REGISTERERS)
    expect(familyKeys.sort()).toEqual([...TOOL_KEYS].filter(key => key !== 'connect' && key !== 'close').sort())
  })
})

describe('service live reads', () => {
  it('applyLiveSettings is a no-op while idle', async () => {
    const ctx = new Context()
    const config = Config({}) as unknown as ResolvedChromeConfig
    const settings = settingsFrom(config)
    const chrome = new ChromeRuntime(ctx, {
      launch: true, port: 1, host: '127.0.0.1', headless: 'new', extraArgs: [],
      reuseExisting: settings.reuseExisting,
      operationTimeoutMs: settings.operationTimeoutMs,
      connectTimeoutMs: settings.connectTimeoutMs,
      networkIdleMs: settings.networkIdleMs,
      observatoryMaxEntries: settings.observatoryMaxEntries,
      dialogPolicy: settings.dialogPolicy,
      dialogPromptText: settings.dialogPromptText,
      downloadDir: settings.downloadDir,
      occupiedPortPolicy: settings.occupiedPortPolicy,
    }, settings)
    try {
      expect(() => chrome.applyLiveSettings()).not.toThrow()
    } finally {
      await chrome.dispose()
    }
  })

  it('Observatory.resize trims overflow and follows the new capacity', () => {
    const ring = new Observatory(3)
    for (let i = 0; i < 3; i++) ring.recordBrowserLog({ level: 'log', text: String(i), timestamp: i })
    expect(ring.size.console).toBe(3)
    ring.resize(2)
    expect(ring.size.console).toBe(2)
    ring.recordBrowserLog({ level: 'log', text: 'new', timestamp: 9 })
    const read = ring.consoleSince({}, 0)
    // Capacity 2 is enforced after the resize: '1' evicts when 'new' arrives.
    expect(read.entries.map(entry => entry.text)).toEqual(['2', 'new'])
    expect(() => ring.resize(0)).toThrow(/positive integer/)
  })
})
