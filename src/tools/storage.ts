/**
 * The model-facing `chrome_storage` tool: one parameterized tool over browser
 * cookies (Network domain) and the current origin's localStorage /
 * sessionStorage — login-state injection, state inspection, cleanup.
 * @module dsh-chrome/tools/storage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import type { ChromeSettings } from '../settings.ts'

/** Canonical `chrome_storage` outcome. */
export interface ChromeStorageValue {
  text: string
}

/** Register `chrome_storage` with its prompt guidance. */
export function applyChromeStorageTool(ctx: Context, chrome: ChromeRuntime, settings: ChromeSettings): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:chrome_storage',
    order: 117,
    text: 'Use the chrome_storage tool to inspect or change the controlled Chrome page\'s state: cookies (kind "cookies", scoped to the current page URL) and localStorage/sessionStorage (kinds "local"/"session", current origin). Operations: get, set, remove, clear. Cookie and storage values are sensitive — echo them only when the task needs them.',
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: 'chrome_storage',
    description: 'Inspect or change the controlled Chrome page\'s state: cookies (kind "cookies"; get/set/remove/clear, scoped to the current page URL unless url is given) and localStorage/sessionStorage (kinds "local"/"session", current origin). Values are sensitive — do not echo them unnecessarily.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        description: 'Which store: "cookies", "local" (localStorage), or "session" (sessionStorage).',
        enum: ['cookies', 'local', 'session'],
      },
      operation: {
        type: 'string',
        description: 'Operation: "get" (default), "set", "remove", or "clear".',
        enum: ['get', 'set', 'remove', 'clear'],
      },
      key: { type: 'string', description: 'Cookie name or storage key (required for set/remove).' },
      value: { type: 'string', description: 'Value to store (required for set).' },
      url: { type: 'string', description: 'Scope cookies to this URL instead of the current page.' },
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
    timeoutMs: settings.operationTimeoutMs(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await chrome.storage({
        kind: args.kind,
        operation: args.operation ?? 'get',
        ...args.key !== undefined ? { key: args.key } : {},
        ...args.value !== undefined ? { value: args.value } : {},
        ...args.url !== undefined ? { url: args.url } : {},
        signal: exec.signal,
      })
      let text: string
      if (args.kind === 'cookies' && (args.operation ?? 'get') === 'get' && Array.isArray(result.result)) {
        text = result.result.length === 0
          ? 'No cookies for the current page.'
          : `${result.result.length} cookie(s):\n${JSON.stringify(result.result, null, 1)}`
      } else {
        text = JSON.stringify(result.result, null, 1)
      }
      return { text }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Storage ${args.operation ?? 'get'} (${args.kind})`, kind: args.operation === undefined || args.operation === 'get' ? 'read' : 'edit' }
    },
  }))
  return () => {
    disposeTool()
    disposeSection()
  }
}
