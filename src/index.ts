/**
 * `dsh-chrome`: a DeepSeek Harness plugin bundle that gives the agent
 * model-facing tools to drive a real Chrome browser over the Chrome DevTools
 * Protocol (CDP).
 *
 * The plugin registers a {@link ChromeRuntime} service as `ctx.chrome` (owning
 * the Chrome process and CDP connection lifecycle) and a family of
 * `defineTool` consumers over it: `chrome_navigate`, `chrome_evaluate`,
 * `chrome_snapshot`, `chrome_page_snapshot`, `chrome_click`,
 * `chrome_screenshot`, `chrome_scroll`, `chrome_type`, `chrome_press_key`,
 * `chrome_close`, and `chrome_connect` (choose reuse-vs-fresh-launch).
 *
 * Settings declared `.volatile()` are real-time: editing them revalidates and
 * commits into the running plugin without a restart (DSH ≥0.2.2 volatile
 * config), and a `loader/volatile-update` listener reconciles the tool
 * registrations and re-applies connection-scoped behavior. Launch-shape
 * fields (port, host, headless, executablePath, userDataDir, extraArgs,
 * launch, cdpUrl) keep the default restart lifecycle.
 *
 * Install into a profile with `dsh plugin --profile <name> add ./dsh-chrome`
 * (or `github:.../dsh-chrome`, a tarball, or the published package). See
 * README.md for configuration and the full tool reference.
 * @module dsh-chrome
 */

import type { Context } from '@deepseek-ai/cordis'
// Loader event types (`loader/volatile-update`): the augmentation ships with
// every DSH installation's plugin loader.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { ChromeRuntime, type ChromeRuntimeConfig } from './service.ts'
import { CORE_REGISTERERS } from './registry.ts'
import { REGISTRATIONS_CHANGED } from './family.ts'
import {
  settingsFrom,
  assertPositiveInteger as assertLivePositiveInteger,
  SETTING_DEFAULTS,
  type ChromeSettings,
  type ResolvedChromeConfig,
  type ScreenshotAnalysisConfig,
} from './settings.ts'
import { DEFAULT_PAGE_SNAPSHOT_MAX_NODES } from './page-walker.ts'
import { DEFAULT_OBSERVATORY_MAX_ENTRIES } from './observatory.ts'
import { urlMatchesGlob } from './url-glob.ts'
import { DEFAULT_SCREENSHOT_ANALYSIS_PROMPT, analyzeScreenshot, assertAnalysisRouteAcceptsImages } from './analysis.ts'
import type { ScreenshotAnalysisRoute } from './analysis.ts'
import { applyChromeCloseTool } from './tools/close.ts'
import { applyChromeConnectTool } from './tools/connect.ts'

export { ChromeError, computeCaptureScale } from './types.ts'
export type {
  ChromeErrorCode,
  WaitUntil,
  ScreenshotFormat,
  MouseButton,
  PageTreeSnapshotResult,
} from './types.ts'
export { ChromeRuntime, parseJsonString } from './service.ts'
export { urlMatchesGlob }
export type { ChromeRuntimeConfig, ChromeConnectMode, ChromeConnectionInfo } from './service.ts'
export {
  DEFAULT_PAGE_SNAPSHOT_MAX_NODES,
  normalizePageRef,
  pageSnapshotExpression,
  formatPageSnapshot,
} from './page-walker.ts'
export type { ChromePageSnapshotValue, RawPageSnapshot } from './page-walker.ts'
export {
  DEFAULT_SCREENSHOT_ANALYSIS_PROMPT,
  analyzeScreenshot,
  assertAnalysisRouteAcceptsImages,
} from './analysis.ts'
export type { ScreenshotAnalysisRoute } from './analysis.ts'
export {
  applyChromeNavigateTool,
  applyChromeEvaluateTool,
  applyChromeSnapshotTool,
  applyChromePageSnapshotTool,
  applyChromeClickTool,
  applyChromeScreenshotTool,
  applyChromeScrollTool,
  applyChromeTypeTool,
  applyChromePressKeyTool,
  applyChromeCloseTool,
  applyChromeConnectTool,
  applyChromeNetTools,
  applyChromeConsoleTool,
  applyChromeEmulateTool,
  applyChromePdfTool,
  applyChromeStorageTool,
  applyChromeUploadTool,
  applyChromeTabTool,
  applyChromeMhtmlTool,
  applyChromeNetMockTool,
} from './tools/index.ts'
export { CORE_REGISTERERS, FAMILY_REGISTERERS, type FamilyRegistrar } from './registry.ts'
export { applyFamily, REGISTRATIONS_CHANGED } from './family.ts'
export {
  analysisRouteFrom,
  settingsFrom,
  SETTING_DEFAULTS,
  TOOL_KEYS,
} from './settings.ts'
export type {
  ChromeSettings,
  ResolvedChromeConfig,
  ScreenshotAnalysisConfig,
  ToolKey,
} from './settings.ts'

/** Back-compat aliases: the defaults now live in {@link SETTING_DEFAULTS}. */
export const DEFAULT_CHROME_PORT = SETTING_DEFAULTS.port
export const DEFAULT_OPERATION_TIMEOUT_MS = SETTING_DEFAULTS.operationTimeoutMs
export const DEFAULT_CONNECT_TIMEOUT_MS = SETTING_DEFAULTS.connectTimeoutMs
export const DEFAULT_NETWORK_IDLE_MS = SETTING_DEFAULTS.networkIdleMs
export const DEFAULT_SNAPSHOT_MAX_CHARS = SETTING_DEFAULTS.snapshotMaxChars

/**
 * Plugin configuration as the user writes it. Fields marked live below are
 * declared `.volatile()` in the schema: editing them applies in place (no
 * plugin restart); the launch-shape fields restart the plugin so `apply`
 * rebuilds the Chrome runtime config.
 */
export interface Config {
  /** Ring-buffer capacity per observatory stream (network / console) (live). Defaults to 500. */
  observatoryMaxEntries?: number
  /** Explicit Chrome executable path; omitted = discover. (Restart to apply.) */
  executablePath?: string
  /** Launch a managed Chrome. False = attach to `cdpUrl`. (Restart to apply.) */
  launch?: boolean
  /** Existing CDP endpoint to attach to when `launch` is false (`ws://` or `http(s)://`). (Restart to apply.) */
  cdpUrl?: string
  /**
   * Before launching on `port`, probe the debugger endpoint and reuse the
   * instance already listening there instead of spawning a second Chrome over
   * the same port. `false` = always launch fresh (the port must be free).
   * Defaults to true. The agent can override per call via `chrome_connect`.
   * (Live.)
   */
  reuseExisting?: boolean
  /** Remote debugging port for a launched Chrome. Defaults to 9222. (Restart to apply.) */
  port?: number
  /** Host a launched Chrome binds its endpoint on. Defaults to 127.0.0.1. (Restart to apply.) */
  host?: string
  /** Headless mode for a launched Chrome. Defaults to "new". (Restart to apply.) */
  headless?: boolean | 'new'
  /** Persistent profile directory; fresh temp dir when omitted. (Restart to apply.) */
  userDataDir?: string
  /** Extra raw Chrome CLI flags. (Restart to apply.) */
  extraArgs?: string[]
  /** Per-operation timeout in ms (live). Defaults to 30000. */
  operationTimeoutMs?: number
  /**
   * Timeout for `chrome_connect` specifically in ms (live). Attaching to a
   * Chrome that authorizes debugging connections waits for the user to
   * approve the in-browser prompt, and a fresh launch onto an occupied port
   * may wait for the user's reuse-or-launch answer, so this budget is far
   * larger than the per-operation one. Defaults to 300000 (5 minutes).
   */
  connectTimeoutMs?: number
  /** Quiet window before `networkidle*` is declared, in ms (live). Defaults to 500. */
  networkIdleMs?: number
  /** How to answer JS dialogs (alert/confirm/prompt/beforeunload): "accept" (default) or "dismiss". (Live.) */
  dialogPolicy?: 'accept' | 'dismiss'
  /** Prompt text sent when answering a `prompt` dialog under "accept". (Live.) */
  dialogPromptText?: string
  /** Directory downloads are redirected into (absolute path). Unset = browser default handling. (Live.) */
  downloadDir?: string
  /** What a fresh launch (`chrome_connect mode "launch"`) does when the configured port is already served: "reuse" attaches to the served instance, "refuse" fails with `CHROME_LAUNCH_FAILED`. (Live.) Defaults to "reuse". */
  occupiedPortPolicy?: 'reuse' | 'refuse'
  /** Cap on `chrome_snapshot` output characters (live). Defaults to 200000. */
  snapshotMaxChars?: number
  /** Cap on `chrome_page_snapshot` tree nodes (live). Defaults to 500. */
  pageSnapshotMaxNodes?: number
  /** Image-capable provider/model that describes screenshots on text-only routes. (Live.) */
  screenshotAnalysis?: ScreenshotAnalysisConfig
}

/** The user-facing config schema. Live fields are `.volatile()` references after resolution. */
export const Config: z<Config, ResolvedChromeConfig> = z.object({
  observatoryMaxEntries: z.number().default(DEFAULT_OBSERVATORY_MAX_ENTRIES).volatile(),
  executablePath: z.string(),
  launch: z.boolean().default(true),
  cdpUrl: z.string(),
  reuseExisting: z.boolean().default(true).volatile(),
  dialogPolicy: z.union([z.const('accept'), z.const('dismiss')]).default('accept').volatile(),
  dialogPromptText: z.string().volatile(),
  downloadDir: z.string().volatile(),
  occupiedPortPolicy: z.union([z.const('reuse'), z.const('refuse')]).default('reuse').volatile(),
  port: z.number().default(SETTING_DEFAULTS.port),
  host: z.string().default('127.0.0.1'),
  headless: z.union([z.boolean(), z.const('new')]).default('new'),
  userDataDir: z.string(),
  extraArgs: z.array(z.string()).default([]),
  operationTimeoutMs: z.number().default(SETTING_DEFAULTS.operationTimeoutMs).volatile(),
  connectTimeoutMs: z.number().default(SETTING_DEFAULTS.connectTimeoutMs).volatile(),
  networkIdleMs: z.number().default(SETTING_DEFAULTS.networkIdleMs).volatile(),
  snapshotMaxChars: z.number().default(SETTING_DEFAULTS.snapshotMaxChars).volatile(),
  pageSnapshotMaxNodes: z.number().default(SETTING_DEFAULTS.pageSnapshotMaxNodes).volatile(),
  screenshotAnalysis: z.object({
    provider: z.string(),
    model: z.string(),
    prompt: z.string(),
    maxTokens: z.number(),
  }).default({}).volatile(),
})

/** Services required before the tools register. */
export const inject = ['tools', 'systemPrompt']

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chrome-tool'

/** Stable identity of the declared per-call timeout budgets (core tools + family broadcast trigger). */
function timeoutKey(settings: ChromeSettings): string {
  return `${settings.operationTimeoutMs()}/${settings.connectTimeoutMs()}`
}

/**
 * Register the Chrome service and the enabled model-facing tools. Schemastery
 * has already filled every defaulted field; live fields arrive as volatile
 * references and are read at use time.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as unknown as ResolvedChromeConfig
  assertPositiveInteger('port', resolved.port)
  // Fail fast on the live invariants too, so a bad initial config refuses the
  // plugin load instead of surfacing per call.
  assertLivePositiveInteger('operationTimeoutMs', resolved.operationTimeoutMs.get())
  assertLivePositiveInteger('connectTimeoutMs', resolved.connectTimeoutMs.get())
  assertLivePositiveInteger('networkIdleMs', resolved.networkIdleMs.get())
  assertLivePositiveInteger('snapshotMaxChars', resolved.snapshotMaxChars.get())
  assertLivePositiveInteger('pageSnapshotMaxNodes', resolved.pageSnapshotMaxNodes.get())
  assertLivePositiveInteger('observatoryMaxEntries', resolved.observatoryMaxEntries.get())
  settingsFrom(resolved).analysisRoute()
  if (!resolved.launch && (resolved.cdpUrl === undefined || resolved.cdpUrl.length === 0)) {
    throw new Error('dsh-chrome: "cdpUrl" is required when "launch" is false')
  }

  const settings = settingsFrom(resolved)
  const chrome = new ChromeRuntime(ctx, runtimeConfig(resolved, settings), settings)

  ctx.systemPrompt.section({
    name: 'chrome:overview',
    order: 109,
    text: 'The chrome_* tools drive a real Chrome browser over the DevTools Protocol. They can run arbitrary JavaScript, read rendered content, click elements, and capture screenshots in the controlled page. Treat them like shell access: they reach the network and run untrusted page code. To understand a page, prefer chrome_page_snapshot (structured element tree with [ref=eN] ids you can act on) or chrome_snapshot (visible text); chrome_screenshot needs an image-capable route or a configured screenshotAnalysis model. Before launching, an instance already listening on the debugger port is reused; chrome_connect switches explicitly between reuse ("reuse"/"auto") and a fresh managed instance ("launch"). Attaching to a Chrome whose debug mode authorizes connections may wait while the user approves an in-browser prompt; when a fresh launch finds the configured port already served, occupiedPortPolicy decides: reuse (default) attaches to the served instance, refuse fails with a clear error. chrome_connect carries a much longer budget than other tools for exactly those waits.',
  })

  // Lifecycle tool registration is synchronous (tests and hosts read the
  // registries right after apply) and tracked so a live reconcile can retire
  // and re-register them when a declared timeout budget changes. The service
  // stays put; the family component rows re-register through the broadcast.
  let disposers: (() => void)[] = []
  const registerSurface = (): void => {
    disposers = [CORE_REGISTERERS.connect(ctx, chrome, settings), CORE_REGISTERERS.close(ctx, chrome, settings)]
  }
  const disposeSurface = (): void => {
    for (const dispose of disposers) dispose()
    disposers = []
  }
  registerSurface()

  // Live settings: `loader/volatile-update` fires on the plugin's own fiber
  // after DSH committed new volatile values into the running references. A
  // timeout-budget change reshapes the registered tool surface (declared
  // timeoutMs is registration-time metadata), so the core reconciles its own
  // lifecycle tools AND broadcasts to the family component rows; everything
  // else is read at use time and needs nothing here.
  let lastTimeouts = timeoutKey(settings)
  ctx.on('loader/volatile-update', () => {
    try {
      const nextTimeouts = timeoutKey(settings)
      if (nextTimeouts !== lastTimeouts) {
        disposeSurface()
        registerSurface()
        lastTimeouts = nextTimeouts
        // Family rows key their declared timeoutMs off the same live values;
        // tell them to re-register.
        ctx.emit(REGISTRATIONS_CHANGED)
      }
      // Connection-scoped behavior (download redirect, observatory
      // capacity) reaches the running browser immediately.
      chrome.applyLiveSettings()
    } catch (error: unknown) {
      ctx.logger.warn('dsh-chrome: live settings reconcile failed; keeping the previous tool surface: %s', error instanceof Error ? error.message : String(error))
    }
  })
}

/** Resolve the tool-family config into the service's runtime config. */
function runtimeConfig(config: ResolvedChromeConfig, settings: ChromeSettings): ChromeRuntimeConfig {
  return {
    ...config.executablePath !== undefined && config.executablePath.length > 0 ? { executablePath: config.executablePath } : {},
    launch: config.launch,
    ...config.cdpUrl !== undefined && config.cdpUrl.length > 0 ? { cdpUrl: config.cdpUrl } : {},
    reuseExisting: settings.reuseExisting,
    port: config.port,
    host: config.host,
    headless: config.headless,
    ...config.userDataDir !== undefined && config.userDataDir.length > 0 ? { userDataDir: config.userDataDir } : {},
    extraArgs: config.extraArgs,
    operationTimeoutMs: settings.operationTimeoutMs,
    networkIdleMs: settings.networkIdleMs,
    observatoryMaxEntries: settings.observatoryMaxEntries,
    dialogPolicy: settings.dialogPolicy,
    dialogPromptText: settings.dialogPromptText,
    downloadDir: settings.downloadDir,
    occupiedPortPolicy: settings.occupiedPortPolicy,
    connectTimeoutMs: settings.connectTimeoutMs,
  }
}

/** Validate that integer configs are positive (apply-time fast fail). */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-chrome: ${name} must be a positive integer`)
  }
}
