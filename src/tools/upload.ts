/**
 * The model-facing `chrome_upload` tool: set local file paths on a
 * `<input type="file">` — the one form interaction `chrome_type` cannot do.
 * @module dsh-chrome/tools/upload
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { resolveTargetSelector } from './ref-target.ts'
import type { ChromeRuntime } from '../service.ts'
import type { ChromeSettings } from '../settings.ts'

/** Canonical `chrome_upload` outcome. */
export interface ChromeUploadValue {
  uploaded: boolean
  selector: string
  fileCount?: number
  coveredBy?: string
}

/** Register `chrome_upload` with its prompt guidance. */
export function applyChromeUploadTool(ctx: Context, chrome: ChromeRuntime, settings: ChromeSettings): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:chrome_upload',
    order: 121,
    text: 'Use the chrome_upload tool to set local file paths on a file input (<input type="file">) — the one form interaction chrome_type cannot do. Target it by CSS selector or by the [ref=eN] id from chrome_page_snapshot. Every path must exist and be readable; absolute paths are safest.',
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: 'chrome_upload',
    description: 'Set local file paths on a file input (<input type="file">) in the controlled Chrome page, by CSS selector or [ref=eN] id. Every path must exist and be readable. Absolute paths are safest.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector of the file input. Takes precedence over "ref".' },
      ref: { type: 'string', description: 'Element id from chrome_page_snapshot (file input).' },
      paths: {
        type: 'array',
        required: true,
        description: 'Absolute paths of the files to select.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uploaded: { type: 'boolean', required: true },
          selector: { type: 'string', required: true },
          fileCount: { type: 'integer' },
          coveredBy: { type: 'string' },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: formatUpload(value) },
      ],
    },
    timeoutMs: settings.operationTimeoutMs(),
    // Mutates the page's file input DOM; keep it exclusive.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const selector = resolveTargetSelector(chrome, args)
      return await chrome.upload({
        selector,
        paths: args.paths,
        signal: exec.signal,
      })
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Upload ${args.paths.length} file(s) → ${args.selector ?? args.ref ?? ''}`, kind: 'edit' }
    },
  }))
  return () => {
    disposeTool()
    disposeSection()
  }
}

/** Model-facing text for one upload outcome. */
export function formatUpload(value: ChromeUploadValue): string {
  if (!value.uploaded) {
    return `No element matching ${value.selector} was found; nothing was uploaded. Take a chrome_page_snapshot to find the file input's ref.`
  }
  let text = `Set ${value.fileCount ?? '?'} file(s) on ${value.selector}.`
  if (value.coveredBy !== undefined) {
    text += ` Warning: the input is visually covered by <${value.coveredBy}> — the files are set regardless, but a click would hit the overlay.`
  }
  return text
}
