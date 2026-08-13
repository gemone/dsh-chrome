/**
 * The model-facing `chrome_snapshot` tool over {@link ChromeRuntime.snapshot}.
 * @module dsh-chrome/tools/snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'

/** Canonical `chrome_snapshot` outcome. */
export interface ChromeSnapshotValue {
  url: string
  title: string
  text: string
  truncated: boolean
}

/** Register `chrome_snapshot` and its prompt guidance. */
export function applyChromeSnapshotTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number, maxChars: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_snapshot',
    order: 112,
    text: 'Use the chrome_snapshot tool to read the visible text content of the controlled Chrome page (bounded). Use it to understand a page after chrome_navigate, especially when content is rendered by JavaScript.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_snapshot',
    description: 'Read the visible text content of the controlled Chrome page (the rendered body innerText). Bounded; truncated flag indicates more text exists.',
    parameters: {
      maxChars: { type: 'integer', description: `Maximum characters to return (default ${maxChars}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: formatSnapshot(value) },
      ],
    },
    timeoutMs,
    // Reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await chrome.snapshot(args.maxChars ?? maxChars, exec.signal)
      return { url: result.url, title: result.title, text: result.text, truncated: result.truncated }
    },
    presentCall(): GenericCallView {
      return { card: 'generic', title: 'Snapshot page text', kind: 'read' }
    },
  }))
}

/** Model-facing text for one snapshot outcome. */
export function formatSnapshot(value: ChromeSnapshotValue): string {
  const header = `URL: ${value.url}\nTitle: ${value.title || '(none)'}\n\n`
  const footer = value.truncated ? '\n\n(Content truncated. Narrow the page section or evaluate a selector for the full text.)' : ''
  return `${header}${value.text}${footer}`
}
