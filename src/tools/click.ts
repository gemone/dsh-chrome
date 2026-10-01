/**
 * The model-facing `chrome_click` tool over {@link ChromeRuntime.click}. The
 * target is either a CSS selector or a `[ref=eN]` id from
 * `chrome_page_snapshot` (the use-browser flow).
 * @module dsh-chrome/tools/click
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import type { MouseButton } from '../types.ts'
import { resolveTargetSelector } from './ref-target.ts'

/** Canonical `chrome_click` outcome. */
export interface ChromeClickValue {
  clicked: boolean
  selector: string
  ref?: string
  /** Present when another element (e.g. an overlay) intercepted the click point. */
  coveredBy?: string
}

/** Register `chrome_click` and its prompt guidance. */
export function applyChromeClickTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_click',
    order: 113,
    text: 'Use the chrome_click tool to click the center of an element in the controlled Chrome page. Pass either a CSS selector or, preferably, a ref id ("e12") copied from chrome_page_snapshot. Returns whether an element was found and clicked.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_click',
    description: 'Click the center of an element in the controlled Chrome page. Dispatches a real mouse event. Target it by CSS selector or by the [ref=eN] id from chrome_page_snapshot.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector for the element to click. Provide this or "ref".' },
      ref: { type: 'string', description: 'Element id from chrome_page_snapshot (e.g. "e12"). Takes precedence over "selector".' },
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
          ref: { type: 'string' },
          coveredBy: { type: 'string', description: 'Element sitting on top of the click point (e.g. a banner overlay); the click likely hit it instead.' },
        },
      },
      render: (_args, value): ContentBlock[] => [
        {
          type: 'text',
          text: value.clicked
            ? `Clicked "${value.selector}".${value.coveredBy !== undefined ? ` Note: "${value.coveredBy}" covers the click point — the click may have hit that overlay instead; dismiss it (or scroll past it) and retry if nothing happened.` : ''}`
            : `No element matched "${value.selector}". Take a chrome_page_snapshot and retry by ref.`,
        },
      ],
    },
    timeoutMs,
    async execute(args, exec) {
      const selector = resolveTargetSelector(chrome, args)
      const button = (args.button ?? 'left') as MouseButton
      const result = await chrome.click(selector, button, exec.signal)
      return {
        clicked: result.clicked,
        selector: result.selector,
        ...args.ref !== undefined && args.ref.trim().length > 0 ? { ref: args.ref.trim() } : {},
        ...result.coveredBy !== undefined ? { coveredBy: result.coveredBy } : {},
      }
    },
    presentCall(args): GenericCallView {
      const target = args.ref !== undefined && args.ref.trim().length > 0
        ? `ref ${args.ref.trim()}`
        : args.selector ?? '(unresolved)'
      return { card: 'generic', title: `Click ${target}`, kind: 'execute', rawInput: target }
    },
  }))
}
