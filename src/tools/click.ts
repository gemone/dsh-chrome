/**
 * The model-facing `chrome_click` tool over {@link ChromeRuntime.click}.
 * @module dsh-chrome/tools/click
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import type { MouseButton } from '../types.ts'

/** Canonical `chrome_click` outcome. */
export interface ChromeClickValue {
  clicked: boolean
  selector: string
}

/** Register `chrome_click` and its prompt guidance. */
export function applyChromeClickTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_click',
    order: 113,
    text: 'Use the chrome_click tool to click the center of the first element matching a CSS selector in the controlled Chrome page. Returns whether an element was found and clicked.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_click',
    description: 'Click the center of the first element matching a CSS selector in the controlled Chrome page. Dispatches a real mouse event.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector for the element to click.' },
      button: {
        type: 'string',
        description: 'Mouse button: "left" (default), "right", or "middle".',
        enum: ['left', 'right', 'middle'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clicked: { type: 'boolean', required: true },
          selector: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: value.clicked ? `Clicked "${value.selector}".` : `No element matched "${value.selector}".` },
      ],
    },
    timeoutMs,
    async execute(args, exec) {
      if (args.selector.trim().length === 0) throw new Error('selector must be a non-empty string')
      const button = (args.button ?? 'left') as MouseButton
      const result = await chrome.click(args.selector, button, exec.signal)
      return { clicked: result.clicked, selector: result.selector }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Click ${args.selector}`, kind: 'execute', rawInput: args.selector }
    },
  }))
}
