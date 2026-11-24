/**
 * Registration seam shared by the core component row and the family component
 * rows: maps each tool family key to the applier that registers its tool(s)
 * and prompt guidance, returning the combined disposer.
 *
 * The core row registers `chrome_connect` / `chrome_close` (lifecycle tools
 * that belong to the browser service); the family rows
 * (`@gemone/dsh-chrome/reading`, `/interact`, `/capture`, `/observatory`,
 * `/session`) register their own slices over the injected `chrome` service.
 * @module dsh-chrome/registry
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ChromeRuntime } from './service.ts'
import type { ToolKey } from './settings.ts'
import { applyChromeCloseTool } from './tools/close.ts'
import { applyChromeConnectTool } from './tools/connect.ts'
import { applyChromeNavigateTool } from './tools/navigate.ts'
import { applyChromeEvaluateTool } from './tools/evaluate.ts'
import { applyChromeSnapshotTool } from './tools/snapshot.ts'
import { applyChromePageSnapshotTool } from './tools/page-snapshot.ts'
import { applyChromeClickTool } from './tools/click.ts'
import { applyChromeScreenshotTool } from './tools/screenshot.ts'
import { applyChromeScrollTool } from './tools/scroll.ts'
import { applyChromeTypeTool } from './tools/type.ts'
import { applyChromePressKeyTool } from './tools/press-key.ts'
import { applyChromeNetTools } from './tools/net.ts'
import { applyChromeConsoleTool } from './tools/console.ts'
import { applyChromeEmulateTool } from './tools/emulate.ts'
import { applyChromePdfTool } from './tools/pdf.ts'
import { applyChromeStorageTool } from './tools/storage.ts'
import { applyChromeUploadTool } from './tools/upload.ts'
import { applyChromeTabTool } from './tools/tab.ts'
import { applyChromeMhtmlTool } from './tools/mhtml.ts'
import { applyChromeNetMockTool } from './tools/net-mock.ts'

/** One family applier: registers its tool(s) and prompt guidance, returning the combined disposer. */
export type FamilyRegistrar = (ctx: Context, chrome: ChromeRuntime, settings: ChromeRuntime['settings']) => () => void

/** Lifecycle tools owned by the core component row (the browser service lives there). */
export const CORE_REGISTERERS: Record<'connect' | 'close', FamilyRegistrar> = {
  connect: applyChromeConnectTool,
  close: applyChromeCloseTool,
}

/** Family keys: every tool family except the core row's lifecycle tools. */
export type FamilyKey = Exclude<ToolKey, 'connect' | 'close'>

/** Tool-family registrars, keyed by capability key (one Plugins-page component row each). */
export const FAMILY_REGISTERERS: Record<FamilyKey, FamilyRegistrar> = {
  navigate: applyChromeNavigateTool,
  evaluate: applyChromeEvaluateTool,
  snapshot: applyChromeSnapshotTool,
  pageSnapshot: applyChromePageSnapshotTool,
  click: applyChromeClickTool,
  screenshot: applyChromeScreenshotTool,
  scroll: applyChromeScrollTool,
  type: applyChromeTypeTool,
  pressKey: applyChromePressKeyTool,
  netLog: applyChromeNetTools,
  consoleLog: applyChromeConsoleTool,
  emulate: applyChromeEmulateTool,
  pdf: applyChromePdfTool,
  storage: applyChromeStorageTool,
  upload: applyChromeUploadTool,
  tab: applyChromeTabTool,
  mhtml: applyChromeMhtmlTool,
  netMock: applyChromeNetMockTool,
}
