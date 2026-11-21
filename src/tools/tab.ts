/**
 * The model-facing `chrome_tab` tool: list the browser's tabs, open a new
 * one, or switch which tab the chrome_* tools drive. One parameterized tool
 * over {@link ChromeRuntime.listTabs}/{@link ChromeRuntime.openTab}/
 * {@link ChromeRuntime.switchTab}.
 * @module dsh-chrome/tools/tab
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'

/** Canonical `chrome_tab` outcome. */
export interface ChromeTabValue {
  text: string
}

/** Register `chrome_tab` with its prompt guidance. */
export function applyChromeTabTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_tab',
    order: 122,
    text: 'Use the chrome_tab tool to manage the controlled Chrome browser\'s tabs: action "list" shows all page tabs (attached marks the one the tools drive), "new" opens a tab and switches to it, "switch" moves the tools to another tab by index or targetId. The previously driven tab stays alive; observatory counts are per-tab and reset on switch.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_tab',
    description: 'Manage the controlled Chrome browser\'s tabs: "list" shows all page tabs, "new" opens a tab (and switches to it), "switch" moves the tools to another tab by zero-based index or targetId. The previous tab stays alive.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'Tab operation.',
        enum: ['list', 'new', 'switch'],
      },
      url: { type: 'string', description: 'URL for action "new" (default about:blank).' },
      index: { type: 'integer', description: 'Zero-based tab index for action "switch" (as "list" reports).' },
      targetId: { type: 'string', description: 'Target id for action "switch" (alternative to index).' },
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
    // Switching mutates which tab the runtime drives; keep it exclusive.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      switch (args.action) {
        case 'list': {
          const tabs = await chrome.listTabs(exec.signal)
          const text = tabs.length === 0
            ? 'No page tabs open.'
            : `${tabs.length} tab(s):\n` + tabs.map(t =>
              `${t.index}. ${t.url}${t.title.length > 0 ? ` — ${t.title}` : ''}${t.attached ? ' [attached]' : ''}`,
            ).join('\n')
          return { text }
        }
        case 'new': {
          const opened = await chrome.openTab(args.url, exec.signal)
          return { text: `Opened tab ${opened.targetId} at ${opened.url}${opened.title.length > 0 ? ` — ${opened.title}` : ''}. The tools now drive it.` }
        }
        case 'switch': {
          const switched = await chrome.switchTab({
            ...args.index !== undefined ? { index: args.index } : {},
            ...args.targetId !== undefined ? { targetId: args.targetId } : {},
            signal: exec.signal,
          })
          return { text: `Now driving tab ${switched.targetId} at ${switched.url}${switched.title.length > 0 ? ` — ${switched.title}` : ''}. Observatory counters are per-tab and reset.` }
        }
      }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Tab ${args.action}${args.url !== undefined ? ` → ${args.url}` : ''}`, kind: args.action === 'list' ? 'read' : 'edit' }
    },
  }))
}
