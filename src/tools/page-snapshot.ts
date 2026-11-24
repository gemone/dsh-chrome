/**
 * The model-facing `chrome_page_snapshot` tool: a `use-browser`-style
 * structured page read. Where `chrome_snapshot` returns flat text and
 * `chrome_screenshot` needs an image-capable route, this tool returns an
 * element tree (role, name, state) in which every interactive element carries
 * a `[ref=eN]` id that `chrome_click` / `chrome_type` / `chrome_scroll` accept
 * directly — no CSS selector authoring, no images required.
 *
 * @module dsh-chrome/tools/page-snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import type { ChromeSettings } from '../settings.ts'
import { formatPageSnapshot } from '../page-walker.ts'

/** Register `chrome_page_snapshot` and its prompt guidance. */
export function applyChromePageSnapshotTool(ctx: Context, chrome: ChromeRuntime, settings: ChromeSettings): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:chrome_page_snapshot',
    order: 119,
    text: 'Use the chrome_page_snapshot tool to read the controlled page as a structured element tree: roles, names, and states, with every interactive element carrying a [ref=eN] id. Pass that ref to chrome_click / chrome_type / chrome_scroll instead of writing CSS selectors. Refs are invalidated by navigation — take a fresh snapshot after navigating. Prefer this over chrome_screenshot whenever the current model cannot see images.',
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: 'chrome_page_snapshot',
    description: 'Read the controlled Chrome page as a structured element tree (roles, names, states) with [ref=eN] ids usable by chrome_click/chrome_type/chrome_scroll. format "a11y" reads the accessibility tree instead (semantic roles/states, no refs). Works without image support; bounded by the node budget.',
    parameters: {
      maxNodes: { type: 'integer', description: `Maximum tree nodes to emit (default ${settings.pageSnapshotMaxNodes()}).` },
      format: {
        type: 'string',
        description: 'Tree flavor: "dom" (default, [ref=eN] actionable) or "a11y" (accessibility tree, semantic read).',
        enum: ['dom', 'a11y'],
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
          tree: { type: 'string', required: true },
          refCount: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: `${formatPageSnapshot(value)}${chrome.activityHint()}` },
      ],
    },
    timeoutMs: settings.operationTimeoutMs(),
    // Mutates the runtime's page-ref map, so overlapping calls could swap the
    // map under a concurrently-acting sibling; keep it exclusive.
    async execute(args, exec) {
      const budget = args.maxNodes ?? settings.pageSnapshotMaxNodes()
      if (!Number.isInteger(budget) || budget < 1) throw new Error('maxNodes must be a positive integer')
      if (args.format === 'a11y') {
        const ax = await chrome.a11ySnapshot(budget, exec.signal)
        return {
          url: ax.url,
          title: ax.title,
          readyState: ax.readyState,
          tree: ax.tree,
          refCount: 0,
          truncated: ax.truncated,
        }
      }
      const result = await chrome.pageSnapshot(budget, exec.signal)
      return {
        url: result.url,
        title: result.title,
        readyState: result.readyState,
        tree: result.tree,
        refCount: result.refCount,
        truncated: result.truncated,
      }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: args.format === 'a11y' ? 'Snapshot accessibility tree' : 'Snapshot page structure', kind: 'read' }
    },
  }))
  return () => {
    disposeTool()
    disposeSection()
  }
}
