/**
 * The model-facing `chrome_snapshot` tool over {@link ChromeRuntime.snapshot}
 * and {@link ChromeRuntime.markdown}. Two formats: `"text"` (the rendered
 * body innerText, what a screen reader would read) and `"markdown"` (the page
 * converted to GitHub-flavored Markdown — headings, links, lists, tables,
 * code blocks — ideal for archiving or answering "what does this page say").
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
  readyState: string
  text: string
  truncated: boolean
  format: 'text' | 'markdown'
}

/** Register `chrome_snapshot` and its prompt guidance. */
export function applyChromeSnapshotTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number, maxChars: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_snapshot',
    order: 112,
    text: 'Use the chrome_snapshot tool to read the controlled Chrome page (bounded): format "text" returns the rendered visible text, format "markdown" converts the page to Markdown (headings, links, lists, tables, code). Use it to understand a page after chrome_navigate, especially when content is rendered by JavaScript.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_snapshot',
    description: 'Read the controlled Chrome page (bounded). format "text" (default) returns the rendered body innerText; format "markdown" returns the page converted to GitHub-flavored Markdown. truncated flag indicates more content exists.',
    parameters: {
      maxChars: { type: 'integer', description: `Maximum characters to return (default ${maxChars}).` },
      format: {
        type: 'string',
        description: 'Output format: "text" (default, rendered visible text) or "markdown" (GitHub-flavored Markdown conversion).',
        enum: ['text', 'markdown'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          readyState: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          format: { type: 'string', enum: ['text', 'markdown'], required: true },
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
      const format = args.format ?? 'text'
      const result = format === 'markdown'
        ? await chrome.markdown(args.maxChars ?? maxChars, exec.signal)
        : await chrome.snapshot(args.maxChars ?? maxChars, exec.signal)
      return {
        url: result.url,
        title: result.title,
        readyState: result.readyState,
        text: result.text,
        truncated: result.truncated,
        format,
      }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Snapshot page (${args.format ?? 'text'})`, kind: 'read' }
    },
  }))
}

/** Model-facing text for one snapshot outcome. */
export function formatSnapshot(value: ChromeSnapshotValue): string {
  const header = `URL: ${value.url}\nTitle: ${value.title || '(none)'}\nReady: ${value.readyState || 'unknown'}\nFormat: ${value.format}\n\n`
  let footer = value.truncated ? '\n\n(Content truncated. Narrow the page section or evaluate a selector for the full text.)' : ''
  if (value.text.trim().length === 0) {
    footer += `\n\n(The page has no readable ${value.format === 'markdown' ? 'content' : 'body text'}${value.readyState !== '' && value.readyState !== 'complete' ? ` — readyState is "${value.readyState}", it may still be loading; retry after it settles` : ' — it may be a non-HTML document, or the content may live inside an iframe; try chrome_page_snapshot or chrome_evaluate to probe further'}.)`
  }
  return `${header}${value.text}${footer}`
}
