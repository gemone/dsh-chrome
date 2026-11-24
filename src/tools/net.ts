/**
 * The model-facing `chrome_net_list` and `chrome_net_body` tools over the
 * runtime's observatory: what the page requested on its own, and what came
 * back — the missing "why did this page fail" half of browser automation.
 * @module dsh-chrome/tools/net
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { formatNetList } from '../observatory.ts'
import type { ChromeRuntime } from '../service.ts'
import type { ChromeSettings } from '../settings.ts'

/** Canonical `chrome_net_list` outcome. */
export interface ChromeNetListValue {
  text: string
  count: number
}

/** Canonical `chrome_net_body` outcome. */
export interface ChromeNetBodyValue {
  body: string
  truncated: boolean
  requestId: string
  mimeType?: string
  status?: number
}

/** Register `chrome_net_list` and `chrome_net_body` with their guidance. */
export function applyChromeNetTools(ctx: Context, chrome: ChromeRuntime, settings: ChromeSettings): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:chrome_net_list',
    order: 113,
    text: 'Use the chrome_net_list tool to see the network requests the controlled Chrome page made (URL, method, status, resource type, failures). Use chrome_net_body with a requestId to read one response body. When a page misbehaves, check chrome_net_list({ failedOnly: true }) before guessing.',
  })

  const disposeTool1 = ctx.tools.register(defineTool({
    name: 'chrome_net_list',
    description: 'List the network requests the controlled Chrome page has made since the session connected (URL, method, status, type, failures). failedOnly filters to failed/canceled requests. Use chrome_net_body with a requestId to read one response body.',
    parameters: {
      failedOnly: { type: 'boolean', description: 'Only show failed or canceled requests (default false).' },
      maxEntries: { type: 'integer', description: 'Maximum entries to return (most recent win, default 100).' },
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
      const result = await chrome.netList({
        ...args.failedOnly === true ? { failedOnly: true } : {},
        maxEntries: Math.max(1, Math.min(args.maxEntries ?? 100, 500)),
        signal: exec.signal,
      })
      return { text: formatNetList(result, args.failedOnly === true), count: result.entries.length }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: args.failedOnly === true ? 'Network requests (failed only)' : 'Network requests', kind: 'read' }
    },
  }))

  const disposeTool2 = ctx.tools.register(defineTool({
    name: 'chrome_net_body',
    description: 'Read the response body of one network request captured by chrome_net_list. Pass the requestId from chrome_net_list. Bodies may be evicted by Chrome once the page proceeds — fetch promptly.',
    parameters: {
      requestId: { type: 'string', required: true, description: 'The requestId from chrome_net_list.' },
      maxChars: { type: 'integer', description: 'Maximum characters to return (default 100000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          body: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          requestId: { type: 'string', required: true },
          mimeType: { type: 'string' },
          status: { type: 'number' },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: formatNetBody(value) }],
    },
    timeoutMs: settings.operationTimeoutMs(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.requestId.trim().length === 0) throw new Error('requestId must be a non-empty string')
      const result = await chrome.netBody(args.requestId, {
        ...args.maxChars !== undefined ? { maxChars: args.maxChars } : {},
        signal: exec.signal,
      })
      return {
        body: result.body,
        truncated: result.truncated,
        requestId: args.requestId,
        ...result.mimeType !== undefined ? { mimeType: result.mimeType } : {},
        ...result.status !== undefined ? { status: result.status } : {},
      }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Response body (${args.requestId.slice(0, 12)}…)`, kind: 'read' }
    },
  }))
  return () => {
    disposeTool1()
    disposeTool2()
    disposeSection()
  }
}

/** Model-facing text for one `chrome_net_body` outcome. */
export function formatNetBody(value: ChromeNetBodyValue): string {
  const header = `Request ${value.requestId}`
    + (value.status !== undefined ? ` — HTTP ${value.status}` : '')
    + (value.mimeType !== undefined ? ` — ${value.mimeType}` : '')
    + (value.truncated ? ` — truncated at ${value.body.length} chars` : '')
    + '\n\n'
  return header + value.body
}
