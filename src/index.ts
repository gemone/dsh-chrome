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
 * Install into a profile with `dsh plugin --profile <name> add ./dsh-chrome`
 * (or `github:.../dsh-chrome`, a tarball, or the published package). See
 * README.md for configuration and the full tool reference.
 * @module dsh-chrome
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ChromeRuntime, type ChromeRuntimeConfig } from './service.ts'
import { DEFAULT_PAGE_SNAPSHOT_MAX_NODES } from './page-walker.ts'
import { DEFAULT_OBSERVATORY_MAX_ENTRIES } from './observatory.ts'
import type { ScreenshotAnalysisRoute } from './analysis.ts'
import { applyChromeNavigateTool } from './tools/navigate.ts'
import { applyChromeEvaluateTool } from './tools/evaluate.ts'
import { applyChromeSnapshotTool } from './tools/snapshot.ts'
import { applyChromePageSnapshotTool } from './tools/page-snapshot.ts'
import { applyChromeClickTool } from './tools/click.ts'
import { applyChromeScreenshotTool } from './tools/screenshot.ts'
import { applyChromeScrollTool } from './tools/scroll.ts'
import { applyChromeTypeTool } from './tools/type.ts'
import { applyChromePressKeyTool } from './tools/press-key.ts'
import { applyChromeCloseTool } from './tools/close.ts'
import { applyChromeConnectTool } from './tools/connect.ts'
import { applyChromeNetTools } from './tools/net.ts'
import { applyChromeConsoleTool } from './tools/console.ts'
import { applyChromeEmulateTool } from './tools/emulate.ts'
import { applyChromePdfTool } from './tools/pdf.ts'
import { applyChromeStorageTool } from './tools/storage.ts'
import { applyChromeUploadTool } from './tools/upload.ts'
import { applyChromeTabTool } from './tools/tab.ts'

export { ChromeError, computeCaptureScale } from './types.ts'
export type {
  ChromeErrorCode,
  WaitUntil,
  ScreenshotFormat,
  MouseButton,
  PageTreeSnapshotResult,
} from './types.ts'
export { ChromeRuntime, parseJsonString } from './service.ts'
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
} from './tools/index.ts'

/** Default remote debugging port for a launched Chrome. */
export const DEFAULT_CHROME_PORT = 9222

/** Default cooperative per-operation timeout (ms). */
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000

/** Default quiet window before `networkidle*` is declared. */
export const DEFAULT_NETWORK_IDLE_MS = 500

/** Default cap on `chrome_snapshot` output characters. */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 200_000

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

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chrome-tool'

/** Services required before the tools register. */
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration (every field has a schemastery default). */
export interface Config {
  /** Register `chrome_navigate`. Defaults to true. */
  navigate?: boolean
  /** Register `chrome_evaluate`. Defaults to true. */
  evaluate?: boolean
  /** Register `chrome_snapshot`. Defaults to true. */
  snapshot?: boolean
  /** Register `chrome_page_snapshot` (structured element tree with refs). Defaults to true. */
  pageSnapshot?: boolean
  /** Register `chrome_click`. Defaults to true. */
  click?: boolean
  /** Register `chrome_screenshot`. Defaults to true. */
  screenshot?: boolean
  /** Register `chrome_scroll`. Defaults to true. */
  scroll?: boolean
  /** Register `chrome_type`. Defaults to true. */
  type?: boolean
  /** Register `chrome_press_key`. Defaults to true. */
  pressKey?: boolean
  /** Register `chrome_close`. Defaults to true. */
  close?: boolean
  /** Register `chrome_connect` (choose reuse vs. fresh launch). Defaults to true. */
  connect?: boolean
  /** Register `chrome_net_list` / `chrome_net_body` (network observatory). Defaults to true. */
  netLog?: boolean
  /** Register `chrome_console_read` (console + exception capture). Defaults to true. */
  consoleLog?: boolean
  /** Register `chrome_emulate` (environment emulation). Defaults to true. */
  emulate?: boolean
  /** Register `chrome_pdf` (print to PDF). Defaults to true. */
  pdf?: boolean
  /** Register `chrome_storage` (cookies + web storage). Defaults to true. */
  storage?: boolean
  /** Register `chrome_upload` (file inputs). Defaults to true. */
  upload?: boolean
  /** Register `chrome_tab` (tab management). Defaults to true. */
  tab?: boolean
  /** Ring-buffer capacity per observatory stream (network / console). Defaults to 500. */
  observatoryMaxEntries?: number
  /** Explicit Chrome executable path; omitted = discover. */
  executablePath?: string
  /** Launch a managed Chrome. False = attach to `cdpUrl`. Defaults to true. */
  launch?: boolean
  /** Existing CDP endpoint to attach to when `launch` is false (`ws://` or `http(s)://`). */
  cdpUrl?: string
  /**
   * Before launching on `port`, probe the debugger endpoint and reuse the
   * instance already listening there instead of spawning a second Chrome over
   * the same port. `false` = always launch fresh (the port must be free).
   * Defaults to true. The agent can override per call via `chrome_connect`.
   */
  reuseExisting?: boolean
  /** Remote debugging port for a launched Chrome. Defaults to 9222. */
  port?: number
  /** Host a launched Chrome binds its endpoint on. Defaults to 127.0.0.1. */
  host?: string
  /** Headless mode for a launched Chrome. Defaults to "new". */
  headless?: boolean | 'new'
  /** Persistent profile directory; fresh temp dir when omitted. */
  userDataDir?: string
  /** Extra raw Chrome CLI flags. */
  extraArgs?: string[]
  /** Per-operation timeout (ms). Defaults to 30000. */
  operationTimeoutMs?: number
  /** Quiet window before `networkidle*` is declared (ms). Defaults to 500. */
  networkIdleMs?: number
  /** How to answer JS dialogs (alert/confirm/prompt/beforeunload): "accept" (default) or "dismiss". */
  dialogPolicy?: 'accept' | 'dismiss'
  /** Prompt text sent when answering a `prompt` dialog under "accept". */
  dialogPromptText?: string
  /** Directory downloads are redirected into (absolute path). Unset = browser default handling. */
  downloadDir?: string
  /** Cap on `chrome_snapshot` output characters. Defaults to 200000. */
  snapshotMaxChars?: number
  /** Cap on `chrome_page_snapshot` tree nodes. Defaults to 500. */
  pageSnapshotMaxNodes?: number
  /** Image-capable provider/model that describes screenshots on text-only routes. */
  screenshotAnalysis?: ScreenshotAnalysisConfig
}

export const Config: z<Config> = z.object({
  navigate: z.boolean().default(true),
  evaluate: z.boolean().default(true),
  snapshot: z.boolean().default(true),
  pageSnapshot: z.boolean().default(true),
  click: z.boolean().default(true),
  screenshot: z.boolean().default(true),
  scroll: z.boolean().default(true),
  type: z.boolean().default(true),
  pressKey: z.boolean().default(true),
  close: z.boolean().default(true),
  connect: z.boolean().default(true),
  netLog: z.boolean().default(true),
  consoleLog: z.boolean().default(true),
  emulate: z.boolean().default(true),
  pdf: z.boolean().default(true),
  storage: z.boolean().default(true),
  upload: z.boolean().default(true),
  tab: z.boolean().default(true),
  observatoryMaxEntries: z.number().default(DEFAULT_OBSERVATORY_MAX_ENTRIES),
  executablePath: z.string(),
  launch: z.boolean().default(true),
  cdpUrl: z.string(),
  reuseExisting: z.boolean().default(true),
  dialogPolicy: z.union([z.const('accept'), z.const('dismiss')]).default('accept'),
  dialogPromptText: z.string(),
  downloadDir: z.string(),
  port: z.number().default(DEFAULT_CHROME_PORT),
  host: z.string().default('127.0.0.1'),
  headless: z.union([z.boolean(), z.const('new')]).default('new'),
  userDataDir: z.string(),
  extraArgs: z.array(z.string()).default([]),
  operationTimeoutMs: z.number().default(DEFAULT_OPERATION_TIMEOUT_MS),
  networkIdleMs: z.number().default(DEFAULT_NETWORK_IDLE_MS),
  snapshotMaxChars: z.number().default(DEFAULT_SNAPSHOT_MAX_CHARS),
  pageSnapshotMaxNodes: z.number().default(DEFAULT_PAGE_SNAPSHOT_MAX_NODES),
  screenshotAnalysis: z.object({
    provider: z.string(),
    model: z.string(),
    prompt: z.string(),
    maxTokens: z.number(),
  }),
})

/** Config with schemastery defaults applied. */
type ResolvedConfig = {
  navigate: boolean
  evaluate: boolean
  snapshot: boolean
  pageSnapshot: boolean
  click: boolean
  screenshot: boolean
  scroll: boolean
  type: boolean
  pressKey: boolean
  close: boolean
  connect: boolean
  netLog: boolean
  consoleLog: boolean
  emulate: boolean
  pdf: boolean
  storage: boolean
  upload: boolean
  tab: boolean
  observatoryMaxEntries: number
  executablePath: string | undefined
  launch: boolean
  cdpUrl: string | undefined
  reuseExisting: boolean
  dialogPolicy: 'accept' | 'dismiss'
  dialogPromptText: string | undefined
  downloadDir: string | undefined
  port: number
  host: string
  headless: boolean | 'new'
  userDataDir: string | undefined
  extraArgs: string[]
  operationTimeoutMs: number
  networkIdleMs: number
  snapshotMaxChars: number
  pageSnapshotMaxNodes: number
  screenshotAnalysis: ScreenshotAnalysisConfig | undefined
}

/** Resolve the tool-family config into the service's runtime config. */
function runtimeConfig(config: ResolvedConfig): ChromeRuntimeConfig {
  return {
    ...config.executablePath !== undefined && config.executablePath.length > 0 ? { executablePath: config.executablePath } : {},
    launch: config.launch,
    ...config.cdpUrl !== undefined && config.cdpUrl.length > 0 ? { cdpUrl: config.cdpUrl } : {},
    reuseExisting: config.reuseExisting,
    ...config.dialogPolicy !== undefined ? { dialogPolicy: config.dialogPolicy } : {},
    ...config.dialogPromptText !== undefined && config.dialogPromptText.length > 0 ? { dialogPromptText: config.dialogPromptText } : {},
    ...config.downloadDir !== undefined && config.downloadDir.length > 0 ? { downloadDir: config.downloadDir } : {},
    port: config.port,
    host: config.host,
    headless: config.headless,
    ...config.userDataDir !== undefined && config.userDataDir.length > 0 ? { userDataDir: config.userDataDir } : {},
    extraArgs: config.extraArgs,
    operationTimeoutMs: config.operationTimeoutMs,
    networkIdleMs: config.networkIdleMs,
  }
}

/** Validate that integer configs are positive. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-chrome: ${name} must be a positive integer`)
  }
}

/**
 * Normalize the raw `screenshotAnalysis` section (schemastery materializes an
 * absent object as `{}`) into a route, rejecting partial configuration.
 */
function analysisRouteFrom(raw: ScreenshotAnalysisConfig | undefined): ScreenshotAnalysisRoute | undefined {
  const provider = typeof raw?.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw?.model === 'string' ? raw.model.trim() : ''
  if (provider.length === 0 && model.length === 0) return undefined
  if (provider.length === 0 || model.length === 0) {
    throw new Error('dsh-chrome: "screenshotAnalysis" requires both "provider" and "model" (an image-capable provider/model pair); remove the section to disable analysis')
  }
  const prompt = typeof raw?.prompt === 'string' && raw.prompt.trim().length > 0 ? raw.prompt : undefined
  const maxTokens = typeof raw?.maxTokens === 'number' ? raw.maxTokens : undefined
  if (maxTokens !== undefined) assertPositiveInteger('screenshotAnalysis.maxTokens', maxTokens)
  return { provider, model, ...prompt !== undefined ? { prompt } : {}, ...maxTokens !== undefined ? { maxTokens } : {} }
}

/**
 * Register the Chrome service and the enabled model-facing tools. Schemastery
 * has already filled every defaulted field.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('port', resolved.port)
  assertPositiveInteger('operationTimeoutMs', resolved.operationTimeoutMs)
  assertPositiveInteger('networkIdleMs', resolved.networkIdleMs)
  assertPositiveInteger('snapshotMaxChars', resolved.snapshotMaxChars)
  assertPositiveInteger('pageSnapshotMaxNodes', resolved.pageSnapshotMaxNodes)
  if (!resolved.launch && (resolved.cdpUrl === undefined || resolved.cdpUrl.length === 0)) {
    throw new Error('dsh-chrome: "cdpUrl" is required when "launch" is false')
  }
  const analysisRoute = analysisRouteFrom(resolved.screenshotAnalysis)

  const chrome = new ChromeRuntime(ctx, runtimeConfig(resolved))
  chrome.observatoryCapacity = resolved.observatoryMaxEntries

  ctx.systemPrompt.section({
    name: 'chrome:overview',
    order: 109,
    text: 'The chrome_* tools drive a real Chrome browser over the DevTools Protocol. They can run arbitrary JavaScript, read rendered content, click elements, and capture screenshots in the controlled page. Treat them like shell access: they reach the network and run untrusted page code. To understand a page, prefer chrome_page_snapshot (structured element tree with [ref=eN] ids you can act on) or chrome_snapshot (visible text); chrome_screenshot needs an image-capable route or a configured screenshotAnalysis model. Before launching, an instance already listening on the debugger port is reused; chrome_connect switches explicitly between reuse ("reuse"/"auto") and a fresh managed instance ("launch").',
  })

  if (resolved.navigate) applyChromeNavigateTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.evaluate) applyChromeEvaluateTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.snapshot) applyChromeSnapshotTool(ctx, chrome, resolved.operationTimeoutMs, resolved.snapshotMaxChars)
  if (resolved.pageSnapshot) applyChromePageSnapshotTool(ctx, chrome, resolved.operationTimeoutMs, resolved.pageSnapshotMaxNodes)
  if (resolved.click) applyChromeClickTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.screenshot) applyChromeScreenshotTool(ctx, chrome, resolved.operationTimeoutMs, analysisRoute)
  if (resolved.scroll) applyChromeScrollTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.type) applyChromeTypeTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.pressKey) applyChromePressKeyTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.close) applyChromeCloseTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.connect) applyChromeConnectTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.netLog) applyChromeNetTools(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.consoleLog) applyChromeConsoleTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.emulate) applyChromeEmulateTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.pdf) applyChromePdfTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.storage) applyChromeStorageTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.upload) applyChromeUploadTool(ctx, chrome, resolved.operationTimeoutMs)
  if (resolved.tab) applyChromeTabTool(ctx, chrome, resolved.operationTimeoutMs)
}
