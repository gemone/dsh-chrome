/**
 * The model-facing `chrome_scroll` tool: scroll the page or a specific element.
 * @module dsh-chrome/tools/scroll
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import { resolveTargetSelector } from './ref-target.ts'

/** Canonical `chrome_scroll` outcome. */
export interface ChromeScrollValue {
  scrollY: number
  scrollX: number
  scrollHeight: number
  clientHeight: number
  scrolledTo: 'page' | string
}

/** Register `chrome_scroll` and its prompt guidance. */
export function applyChromeScrollTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_scroll',
    order: 115,
    text: 'Use the chrome_scroll tool to scroll the page or a specific element. Supports vertical and horizontal scrolling by pixel amount, or scrolling an element into view by CSS selector or chrome_page_snapshot ref.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_scroll',
    description: 'Scroll the page or a specific element into view. Supports up/down/left/right by pixel amount, or scroll to a CSS selector or chrome_page_snapshot ref.',
    parameters: {
      direction: {
        type: 'string',
        description: 'Scroll direction: "down" (default), "up", "left", or "right".',
        enum: ['down', 'up', 'left', 'right'],
      },
      pixels: { type: 'integer', description: 'Number of pixels to scroll (default 500 for vertical, 300 for horizontal).' },
      selector: { type: 'string', description: 'CSS selector of an element to scroll into view. When set, direction/pixels are ignored.' },
      ref: { type: 'string', description: 'Element id from chrome_page_snapshot (e.g. "e12") to scroll into view. Takes precedence over "selector".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scrollY: { type: 'integer', required: true },
          scrollX: { type: 'integer', required: true },
          scrollHeight: { type: 'integer', required: true },
          clientHeight: { type: 'integer', required: true },
          scrolledTo: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const at = value.scrolledTo === 'page' ? `page (${value.scrollY}px from top)` : `element "${value.scrolledTo}"`
        return [{ type: 'text', text: `Scrolled to ${at}. Position: (${value.scrollX}, ${value.scrollY}). Page height: ${value.scrollHeight}px.` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const direction = args.direction ?? 'down'
      const pixels = args.pixels ?? (direction === 'up' || direction === 'down' ? 500 : 300)
      const hasElementTarget = (args.ref !== undefined && args.ref.trim().length > 0) || (args.selector !== undefined && args.selector.trim().length > 0)
      let expression: string
      if (hasElementTarget) {
        const selector = resolveTargetSelector(chrome, args)
        expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify({error:'not found'}); el.scrollIntoView({ block:'center', inline:'center', behavior:'instant' }); const r = el.getBoundingClientRect(); return JSON.stringify({ scrollY: window.scrollY, scrollX: window.scrollX, scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, scrolledTo: ${JSON.stringify(selector)} }); })()`
      } else {
        const dx = direction === 'right' ? pixels : direction === 'left' ? -pixels : 0
        const dy = direction === 'down' ? pixels : direction === 'up' ? -pixels : 0
        expression = `(() => { window.scrollBy(${dx}, ${dy}); return JSON.stringify({ scrollY: window.scrollY, scrollX: window.scrollX, scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, scrolledTo: 'page' }); })()`
      }
      const result = await chrome.evaluate(expression, { awaitPromise: false, returnByValue: true, signal: exec.signal })
      const parsed = (typeof result.result === 'string' ? JSON.parse(result.result as string) : result.result) as ChromeScrollValue & { error?: string }
      if (parsed.error === 'not found') {
        throw new Error(`no element matched the target (${args.ref !== undefined ? `ref ${JSON.stringify(args.ref)}` : `selector ${JSON.stringify(args.selector)}`}); take a fresh chrome_page_snapshot if the page has changed`)
      }
      return { scrollY: parsed.scrollY, scrollX: parsed.scrollX, scrollHeight: parsed.scrollHeight, clientHeight: parsed.clientHeight, scrolledTo: parsed.scrolledTo }
    },
    presentCall(args): GenericCallView {
      const target = args.ref !== undefined && args.ref.trim().length > 0
        ? `ref ${args.ref.trim()}`
        : args.selector ?? `${args.direction ?? 'down'} ${args.pixels ?? 500}px`
      return { card: 'generic', title: `Scroll: ${target}`, kind: 'read', rawInput: target }
    },
  }))
}
