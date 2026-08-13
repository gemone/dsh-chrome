/**
 * The model-facing `chrome_navigate` tool over {@link ChromeRuntime.navigate}.
 * @module dsh-chrome/tools/navigate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import type { WaitUntil } from '../types.ts'

/** Canonical `chrome_navigate` outcome. */
export interface ChromeNavigateValue {
  url: string
  finalUrl: string
  title: string
}

/** Register `chrome_navigate` and its prompt guidance. */
export function applyChromeNavigateTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_navigate',
    order: 110,
    text: 'Use the chrome_navigate tool to open a URL in the controlled Chrome browser and wait for it to load. It returns the final URL and the page title. Prefer it over web_fetch when you need to run JavaScript, click, or capture what the user would see.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_navigate',
    description: 'Open a URL in the controlled Chrome browser (over the DevTools Protocol) and wait for it to load. Returns the final URL and page title.',
    parameters: {
      url: { type: 'string', required: true, description: 'The absolute http(s) URL to navigate to.' },
      waitUntil: {
        type: 'string',
        description: 'Lifecycle to wait for: "load" (default), "domcontentloaded", "networkidle0", or "networkidle2".',
        enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          finalUrl: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: `Navigated to ${value.finalUrl}\nTitle: ${value.title || '(none)'}` },
      ],
    },
    timeoutMs,
    async execute(args, exec) {
      if (args.url.trim().length === 0) throw new Error('url must be a non-empty string')
      const waitUntil = (args.waitUntil ?? 'load') as WaitUntil
      const result = await chrome.navigate(args.url, waitUntil, exec.signal)
      return { url: result.url, finalUrl: result.finalUrl, title: result.title }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: args.url, kind: 'fetch', rawInput: args.url }
    },
  }))
}
