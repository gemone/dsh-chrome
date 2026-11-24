/**
 * The model-facing `chrome_pdf` tool: print the current page to a PDF file
 * via `Page.printToPDF` and write it to a filesystem path.
 * @module dsh-chrome/tools/pdf
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { paperFormatError } from '../emulation.ts'
import type { ChromeRuntime } from '../service.ts'
import type { ChromeSettings } from '../settings.ts'

/** Canonical `chrome_pdf` outcome. */
export interface ChromePdfValue {
  path: string
  bytes: number
}

/** Register `chrome_pdf` with its prompt guidance. */
export function applyChromePdfTool(ctx: Context, chrome: ChromeRuntime, settings: ChromeSettings): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:chrome_pdf',
    order: 116,
    text: 'Use the chrome_pdf tool to print the controlled Chrome page to a PDF file at an absolute path (created recursively). Supports landscape, printBackground, paperFormat (Letter/Legal/Tabloid/Ledger/A0–A6), scale, and pageRanges. Good for full-page archives; prefer chrome_screenshot for images.',
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: 'chrome_pdf',
    description: 'Print the controlled Chrome page to a PDF file. path is the absolute destination path (created recursively). Options: landscape, printBackground (default true), paperFormat (Letter/Legal/Tabloid/Ledger/A0-A6), scale (0.1-2), pageRanges (e.g. "1-3, 5").',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the PDF file to write.' },
      landscape: { type: 'boolean', description: 'Landscape orientation (default false).' },
      printBackground: { type: 'boolean', description: 'Print background graphics (default true).' },
      paperFormat: { type: 'string', description: 'Paper format: Letter, Legal, Tabloid, Ledger, or A0-A6 (default Letter).' },
      scale: { type: 'number', description: 'Page scale 0.1-2 (default 1).' },
      pageRanges: { type: 'string', description: 'Paper ranges to print, e.g. "1-3, 5".' },
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
        { type: 'text', text: `PDF written to ${value.path} (${value.bytes} bytes).` },
      ],
    },
    timeoutMs: settings.operationTimeoutMs(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      if (!args.path.endsWith('.pdf')) throw new Error('path must end with .pdf')
      if (args.paperFormat !== undefined) {
        const error = paperFormatError(args.paperFormat)
        if (error !== undefined) throw new Error(error)
      }
      if (args.scale !== undefined && !(args.scale >= 0.1 && args.scale <= 2)) {
        throw new Error('scale must be between 0.1 and 2')
      }
      const result = await chrome.pdf({
        path: args.path,
        ...args.landscape !== undefined ? { landscape: args.landscape } : {},
        ...args.printBackground !== undefined ? { printBackground: args.printBackground } : {},
        ...args.paperFormat !== undefined ? { paperFormat: args.paperFormat } : {},
        ...args.scale !== undefined ? { scale: args.scale } : {},
        ...args.pageRanges !== undefined ? { pageRanges: args.pageRanges } : {},
        signal: exec.signal,
      })
      return { path: result.path, bytes: result.bytes }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Print to PDF → ${args.path}`, kind: 'edit' }
    },
  }))
  return () => {
    disposeTool()
    disposeSection()
  }
}
