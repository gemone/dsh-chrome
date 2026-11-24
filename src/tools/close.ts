/**
 * The model-facing `chrome_close` tool: close the current tab or the entire
 * browser. Closing a tab keeps the browser alive and auto-creates a new tab on
 * next tool call. Closing the browser closes the connection and kills the
 * Chrome process the plugin launched; a reused (attached) instance is only
 * detached.
 * @module dsh-chrome/tools/close
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import type { ChromeSettings } from '../settings.ts'

/** Canonical `chrome_close` outcome. */
export interface ChromeCloseValue {
  closed: 'tab' | 'browser'
}

/** Register `chrome_close` and its prompt guidance. */
export function applyChromeCloseTool(ctx: Context, chrome: ChromeRuntime, settings: ChromeSettings): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:chrome_close',
    order: 118,
    text: 'Use the chrome_close tool to close the current Chrome tab or the entire browser. Closing a tab keeps the browser alive and auto-creates a new tab on next tool call. Closing the browser kills the managed Chrome process; a reused (attached) instance is only detached and keeps running.',
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: 'chrome_close',
    description: 'Close the current Chrome tab or the entire browser. "tab" keeps the browser alive and auto-creates a new tab on next tool call; "browser" closes the connection and kills the Chrome process when the plugin launched it — a reused (attached) instance is only detached and stays running.',
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
      // Ownership-neutral on purpose: by render time the connection is already
      // closed, so asking the runtime who owned it would always answer "not
      // me". Both outcomes share one accurate sentence.
      render: (_args, value): ContentBlock[] => [
        {
          type: 'text',
          text: value.closed === 'tab'
            ? 'Closed the current tab. A new tab will open on next tool call.'
            : 'Closed the browser connection. A managed Chrome relaunches on next tool call; a reused instance stays running and is re-attached.',
        },
      ],
    },
    timeoutMs: settings.operationTimeoutMs(),
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
  return () => {
    disposeTool()
    disposeSection()
  }
}
