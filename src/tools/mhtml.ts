/**
 * The model-facing `chrome_mhtml` tool: archive the whole page (layout +
 * inline resources) as a single MHTML file.
 * @module dsh-chrome/tools/mhtml
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'

/** Canonical `chrome_mhtml` outcome. */
export interface ChromeMhtmlValue {
  path: string
  bytes: number
}

/** Register `chrome_mhtml` with its prompt guidance. */
export function applyChromeMhtmlTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_mhtml',
    order: 123,
    text: 'Use the chrome_mhtml tool to archive the whole page (layout + inline resources, images included) as a single MHTML file at an absolute path. Use it for complete page archives; use chrome_pdf for printable documents and chrome_screenshot for images.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_mhtml',
    description: 'Archive the whole controlled Chrome page (layout + inline resources) as a single MHTML file at an absolute path (created recursively). Complete offline copy of the page; use chrome_pdf for printable documents and chrome_screenshot for images.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the MHTML file to write (should end with .mhtml).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: `MHTML archive written to ${value.path} (${value.bytes} bytes).` },
      ],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      if (!args.path.endsWith('.mhtml') && !args.path.endsWith('.mht')) {
        throw new Error('path should end with .mhtml (or .mht)')
      }
      return await chrome.mhtml({ path: args.path, signal: exec.signal })
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Archive MHTML → ${args.path}`, kind: 'edit' }
    },
  }))
}
