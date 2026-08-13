/**
 * The model-facing `chrome_close` tool: close the current tab or the entire
 * browser. Closing a tab keeps the browser alive and auto-creates a new tab on
 * next tool call. Closing the browser kills the Chrome process entirely.
 * @module dsh-chrome/tools/close
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'

/** Canonical `chrome_close` outcome. */
export interface ChromeCloseValue {
  closed: 'tab' | 'browser'
}

/** Register `chrome_close` and its prompt guidance. */
export function applyChromeCloseTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_close',
    order: 118,
    text: 'Use the chrome_close tool to close the current Chrome tab or the entire browser. Closing a tab keeps the browser alive and auto-creates a new tab on next tool call.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_close',
    description: 'Close the current Chrome tab or the entire browser. "tab" keeps the browser alive and auto-creates a new tab on next tool call; "browser" kills the Chrome process.',
    parameters: {
      what: {
        type: 'string',
        description: 'Close the current "tab" (default) or the entire "browser".',
        enum: ['tab', 'browser'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'string', required: true, enum: ['tab', 'browser'] },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: value.closed === 'tab' ? 'Closed the current tab. A new tab will open on next tool call.' : 'Closed the Chrome browser. A new Chrome will launch on next tool call.' },
      ],
    },
    timeoutMs,
    async execute(args, exec) {
      const what = args.what ?? 'tab'
      if (what === 'tab') {
        await chrome.closeTab(exec.signal)
      } else {
        await chrome.closeBrowser()
      }
      return { closed: what }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Close ${args.what ?? 'tab'}`, kind: 'delete', rawInput: args.what ?? 'tab' }
    },
  }))
}
