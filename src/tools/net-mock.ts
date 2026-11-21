/**
 * The model-facing `chrome_net_mock` tool: answer matching requests with a
 * canned response via CDP Fetch interception — mock third-party APIs, test
 * error paths, or unblock a page whose dependency is unreachable.
 * @module dsh-chrome/tools/net-mock
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'

/** Canonical `chrome_net_mock` outcome. */
export interface ChromeNetMockValue {
  text: string
}

/** Register `chrome_net_mock` with its prompt guidance. */
export function applyChromeNetMockTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_net_mock',
    order: 124,
    text: 'Use the chrome_net_mock tool to answer requests matching a URL glob pattern (e.g. "https://api.example.com/v1/*") with a canned response — mock third-party dependencies, test error paths, or unblock a page. action "clear" removes all mocks and stops interception. Mocks live per connection; they do not survive a browser restart.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_net_mock',
    description: 'Answer network requests matching a URL glob pattern (* wildcards, e.g. "https://api.example.com/v1/*") with a canned response in the controlled Chrome page. action "set" (default) adds/overwrites one mock; "clear" removes all mocks and stops interception. Mocks live per connection.',
    parameters: {
      action: {
        type: 'string',
        description: '"set" adds/overwrites one mock; "clear" removes all mocks and stops interception.',
        enum: ['set', 'clear'],
      },
      pattern: { type: 'string', description: 'URL glob pattern for action "set" ("*" wildcards, e.g. "https://api.example.com/*").' },
      status: { type: 'integer', description: 'Response status code (default 200).' },
      body: { type: 'string', description: 'Response body (default empty).' },
      contentType: { type: 'string', description: 'Content-Type response header (default "text/plain").' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: value.text }],
    },
    timeoutMs,
    async execute(args, exec) {
      if (args.action === 'clear') {
        const { cleared } = await chrome.netMockClear(exec.signal)
        return { text: `Cleared ${cleared} mock(s); interception stopped.` }
      }
      if (args.pattern === undefined || args.pattern.trim().length === 0) {
        throw new Error('action "set" requires a non-empty pattern')
      }
      const result = await chrome.netMock({
        pattern: args.pattern,
        ...args.status !== undefined ? { status: args.status } : {},
        ...args.body !== undefined ? { body: args.body } : {},
        ...args.contentType !== undefined ? { contentType: args.contentType } : {},
        signal: exec.signal,
      })
      return { text: `Mock set for ${result.pattern} → HTTP ${result.status}. ${result.mocks} mock(s) active; matching requests are answered without touching the network. Use action "clear" to remove.` }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Net mock ${args.action}${args.pattern !== undefined ? ` → ${args.pattern}` : ''}`, kind: 'edit' }
    },
  }))
}
