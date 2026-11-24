/**
 * Live settings view over the plugin's volatile config fields.
 *
 * DSH ≥0.2.2 resolves schema fields declared `.volatile()` as stable
 * references (`Volatile<T>`): editing the setting revalidates the candidate
 * and commits a fresh immutable snapshot into the same reference **without
 * restarting the plugin** (cordis loader `_commitVolatile`), then emits
 * `loader/volatile-update`. Everything the plugin should retune at runtime —
 * timeout budgets, output caps, observatory capacity, dialog/download
 * behavior, the screenshot-analysis route, and the capability surface — reads
 * through this module at use time, so an edit applies to the next operation.
 *
 * Launch-shape fields (`port`, `host`, `headless`, `executablePath`,
 * `userDataDir`, `extraArgs`, `launch`, `cdpUrl`) deliberately stay ordinary:
 * they describe the Chrome process itself, and the default restart lifecycle
 * is the correct way to apply them.
 * @module dsh-chrome/settings
 */

import type { Volatile } from '@deepseek-ai/cordis'
import type { ScreenshotAnalysisRoute } from './analysis.ts'
import { DEFAULT_PAGE_SNAPSHOT_MAX_NODES } from './page-walker.ts'
import { DEFAULT_OBSERVATORY_MAX_ENTRIES } from './observatory.ts'

/** Default remote debugging port for a launched Chrome. */
export const DEFAULT_CHROME_PORT = 9222

/** Default cooperative per-operation timeout (ms). */
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000

/** Default budget for `chrome_connect`, which may wait for the user to approve Chrome's connection authorization prompt. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 300_000

/** Default quiet window before `networkidle*` is declared. */
export const DEFAULT_NETWORK_IDLE_MS = 500

/** Default cap on `chrome_snapshot` output characters. */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 200_000

/** Every capability key the config can toggle, in schema order. */
export const TOOL_KEYS = [
  'navigate', 'evaluate', 'snapshot', 'pageSnapshot', 'click', 'screenshot', 'scroll', 'type', 'pressKey',
  'close', 'connect', 'netLog', 'consoleLog', 'emulate', 'pdf', 'storage', 'upload', 'tab', 'mhtml', 'netMock',
] as const

/** One capability key. */
export type ToolKey = typeof TOOL_KEYS[number]

/** Raw shape of the optional `screenshotAnalysis` config section. */
export interface ScreenshotAnalysisConfig {
  /** Registered provider route owning the analysis model. */
  provider?: string
  /** Exact model id that accepts image input. */
  model?: string
  /** Base instruction for the analysis call; a sensible default when omitted. */
  prompt?: string
  /** Output cap for the analysis call. */
  maxTokens?: number
}

/**
 * The resolved plugin config as schemastery delivers it to `apply()`: the
 * volatile fields arrive as stable {@link Volatile} references, the launch
 * fields as plain values.
 */
export interface ResolvedChromeConfig {
  // — live (volatile) fields —
  observatoryMaxEntries: Volatile<number>
  reuseExisting: Volatile<boolean>
  dialogPolicy: Volatile<'accept' | 'dismiss'>
  dialogPromptText: Volatile<string | undefined>
  downloadDir: Volatile<string | undefined>
  operationTimeoutMs: Volatile<number>
  connectTimeoutMs: Volatile<number>
  networkIdleMs: Volatile<number>
  snapshotMaxChars: Volatile<number>
  pageSnapshotMaxNodes: Volatile<number>
  screenshotAnalysis: Volatile<ScreenshotAnalysisConfig>
  occupiedPortPolicy: Volatile<'reuse' | 'refuse'>
  // — static (restart-bound) fields —
  executablePath: string | undefined
  launch: boolean
  cdpUrl: string | undefined
  port: number
  host: string
  headless: boolean | 'new'
  userDataDir: string | undefined
  extraArgs: string[]
}

/** Live accessor set shared by the service and every tool. */
export interface ChromeSettings {
  /** Whether an implicit connect probes for a running instance first. */
  readonly reuseExisting: () => boolean
  /** Cooperative per-operation timeout (ms). */
  readonly operationTimeoutMs: () => number
  /** `chrome_connect` budget (ms); covers user approval waits. */
  readonly connectTimeoutMs: () => number
  /** Quiet window before `networkidle*` is declared (ms). */
  readonly networkIdleMs: () => number
  /** Cap on `chrome_snapshot` output characters. */
  readonly snapshotMaxChars: () => number
  /** Cap on `chrome_page_snapshot` tree nodes. */
  readonly pageSnapshotMaxNodes: () => number
  /** Ring-buffer capacity per observatory stream (network / console). */
  readonly observatoryMaxEntries: () => number
  /** How to answer JS dialogs (alert/confirm/prompt/beforeunload). */
  readonly dialogPolicy: () => 'accept' | 'dismiss'
  /** Prompt text sent when answering a `prompt` dialog under "accept". */
  readonly dialogPromptText: () => string | undefined
  /** Directory downloads are redirected into; unset = browser default handling. */
  readonly downloadDir: () => string | undefined
  /** Image-capable route that describes screenshots on text-only routes. */
  readonly analysisRoute: () => ScreenshotAnalysisRoute | undefined
  /** What a fresh launch does when the configured port is already served. */
  readonly occupiedPortPolicy: () => 'reuse' | 'refuse'
}

/** Validate that an integer live value stayed positive. */
export function assertPositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-chrome: ${name} must be a positive integer`)
  }
  return value
}

/**
 * Normalize a raw `screenshotAnalysis` snapshot (an absent section
 * materializes as `{}`) into a route, rejecting partial configuration.
 */
export function analysisRouteFrom(raw: ScreenshotAnalysisConfig | undefined | null): ScreenshotAnalysisRoute | undefined {
  const provider = typeof raw?.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw?.model === 'string' ? raw.model.trim() : ''
  if (provider.length === 0 && model.length === 0) return undefined
  if (provider.length === 0 || model.length === 0) {
    throw new Error('dsh-chrome: "screenshotAnalysis" requires both "provider" and "model" (an image-capable provider/model pair); remove the section to disable analysis')
  }
  const prompt = typeof raw?.prompt === 'string' && raw.prompt.trim().length > 0 ? raw.prompt : undefined
  const rawMaxTokens = typeof raw?.maxTokens === 'number' ? raw.maxTokens : undefined
  const maxTokens = rawMaxTokens !== undefined ? assertPositiveInteger('screenshotAnalysis.maxTokens', rawMaxTokens) : undefined
  return { provider, model, ...prompt !== undefined ? { prompt } : {}, ...maxTokens !== undefined ? { maxTokens } : {} }
}

/**
 * Build the live accessor set over the resolved config's volatile references.
 * Every read resolves the current committed snapshot; numeric reads re-check
 * the plugin-level invariants schemastery cannot express, so a bad live edit
 * surfaces at the point of use instead of corrupting behavior silently.
 */
export function settingsFrom(config: ResolvedChromeConfig): ChromeSettings {
  return {
    reuseExisting: () => config.reuseExisting.get(),
    operationTimeoutMs: () => assertPositiveInteger('operationTimeoutMs', config.operationTimeoutMs.get()),
    connectTimeoutMs: () => assertPositiveInteger('connectTimeoutMs', config.connectTimeoutMs.get()),
    networkIdleMs: () => assertPositiveInteger('networkIdleMs', config.networkIdleMs.get()),
    snapshotMaxChars: () => assertPositiveInteger('snapshotMaxChars', config.snapshotMaxChars.get()),
    pageSnapshotMaxNodes: () => assertPositiveInteger('pageSnapshotMaxNodes', config.pageSnapshotMaxNodes.get()),
    observatoryMaxEntries: () => assertPositiveInteger('observatoryMaxEntries', config.observatoryMaxEntries.get()),
    dialogPolicy: () => config.dialogPolicy.get(),
    dialogPromptText: () => {
      const text = config.dialogPromptText.get()
      return text !== undefined && text.length > 0 ? text : undefined
    },
    downloadDir: () => {
      const dir = config.downloadDir.get()
      return dir !== undefined && dir.length > 0 ? dir : undefined
    },
    analysisRoute: () => analysisRouteFrom(config.screenshotAnalysis.get()),
    occupiedPortPolicy: () => config.occupiedPortPolicy.get(),
  }
}

/** Schema-default values, used when describing tools before any override. */
export const SETTING_DEFAULTS = {
  port: DEFAULT_CHROME_PORT,
  operationTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
  connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
  networkIdleMs: DEFAULT_NETWORK_IDLE_MS,
  snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS,
  pageSnapshotMaxNodes: DEFAULT_PAGE_SNAPSHOT_MAX_NODES,
  observatoryMaxEntries: DEFAULT_OBSERVATORY_MAX_ENTRIES,
} as const
