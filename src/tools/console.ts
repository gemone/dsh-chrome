/**
 * The model-facing `chrome_console_read` tool over the runtime's observatory:
 * console API output, uncaught page exceptions, and browser-side log entries
 * (CSP violations, failed loads) — what the page said about itself.
 * @module dsh-chrome/tools/console
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { formatConsoleRead, type ConsoleLevel } from '../observatory.ts'
import type { ChromeRuntime } from '../service.ts'
import type { ChromeSettings } from '../settings.ts'

/** Canonical `chrome_console_read` outcome. */
export interface ChromeConsoleValue {
  text: string
  count: number
}

/** Register `chrome_console_read` with its prompt guidance. */
export function applyChromeConsoleTool(ctx: Context, chrome: ChromeRuntime, settings: ChromeSettings): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:chrome_console_read',
    order: 114,
    text: 'Use the chrome_console_read tool to read the controlled Chrome page\'s console output: console.log/info/warn/error calls, uncaught exceptions, and browser log entries. Level "error" (default) shows only errors; pass all: true to dump everything. Other chrome_* tools append a [page activity: …] hint when new errors appear — follow it here.',
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: 'chrome_console_read',
    description: 'Read the controlled Chrome page\'s console output: console API messages, uncaught exceptions, and browser log entries. level filters by minimum severity (default "error"); all: true reads the entire buffer instead of only unread entries.',
    parameters: {
      level: {
        type: 'string',
        description: 'Minimum severity: "error" (default), "warning", "info", "log", or "debug".',
        enum: ['error', 'warning', 'info', 'log', 'debug'],
      },
      maxEntries: { type: 'integer', description: 'Maximum entries to return (default 100).' },
      all: { type: 'boolean', description: 'Read the entire buffer, not just entries since the last read (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          count: { type: 'number', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: value.text }],
    },
    timeoutMs: settings.operationTimeoutMs(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await chrome.consoleRead({
        ...(args.level !== undefined ? { minLevel: args.level as ConsoleLevel } : {}),
        maxEntries: Math.max(1, Math.min(args.maxEntries ?? 100, 500)),
        ...(args.all === true ? { all: true } : {}),
        signal: exec.signal,
      })
      return { text: formatConsoleRead(result), count: result.entries.length }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Console (${args.level ?? 'error'})`, kind: 'read' }
    },
  }))
  return () => {
    disposeTool()
    disposeSection()
  }
}
