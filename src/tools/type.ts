/**
 * The model-facing `chrome_type` tool: type text into a focused element via real
 * CDP keyboard events (`Input.insertText`), triggering native input events that
 * frameworks (React, Vue, Angular) properly handle — unlike the evaluate+setter
 * workaround.
 * @module dsh-chrome/tools/type
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import type { ChromeSettings } from '../settings.ts'
import { ChromeError } from '../types.ts'
import { normalizePageRef } from '../page-walker.ts'
import { resolveRefSelector } from './ref-target.ts'

/** Canonical `chrome_type` outcome. */
export interface ChromeTypeValue {
  typed: boolean
  selector: string | null
  valueAfter: string
}

/** Register `chrome_type` and its prompt guidance. */
export function applyChromeTypeTool(ctx: Context, chrome: ChromeRuntime, settings: ChromeSettings): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:chrome_type',
    order: 116,
    text: 'Use the chrome_type tool to type text into a focused element via real keyboard events. Target the input by CSS selector or by a chrome_page_snapshot ref; with neither it types into whatever is focused. It triggers native input events that React/Vue/Angular frameworks handle correctly. Prefer this over evaluate+setter for form input.',
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: 'chrome_type',
    description: 'Type text into a focused element using real keyboard events. Triggers native input events that frameworks handle correctly. Optionally focus a target first by CSS selector or chrome_page_snapshot ref.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to type.' },
      selector: { type: 'string', description: 'CSS selector to focus before typing. If omitted (with no ref), types into the currently focused element.' },
      ref: { type: 'string', description: 'Element id from chrome_page_snapshot (e.g. "e12") to focus before typing. Takes precedence over "selector".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          typed: { type: 'boolean', required: true },
          selector: { type: 'string' },
          valueAfter: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: value.typed ? `Typed into ${value.selector ?? 'focused element'}. Value: "${value.valueAfter}"` : `Failed to type into ${value.selector ?? 'focused element'}.` },
      ],
    },
    timeoutMs: settings.operationTimeoutMs(),
    async execute(args, exec) {
      if (args.text.length === 0) throw new Error('text must be a non-empty string')

      // Optionally focus a target element first (ref wins over selector).
      let focusSelector: string | undefined
      if (args.ref !== undefined && args.ref.trim().length > 0) {
        focusSelector = resolveRefSelector(chrome, args.ref)
      } else if (args.selector !== undefined && args.selector.trim().length > 0) {
        focusSelector = args.selector
      }
      if (focusSelector !== undefined) {
        const focusResult = await chrome.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(focusSelector)}); if (!el) return 'not_found'; el.focus(); return 'ok'; })()`,
          { awaitPromise: false, returnByValue: true, signal: exec.signal },
        )
        if (focusResult.result === 'not_found') {
          const via = args.ref !== undefined && args.ref.trim().length > 0 && normalizePageRef(args.ref) !== undefined
            ? `ref "${normalizePageRef(args.ref)}" (selector "${focusSelector}")`
            : `selector "${focusSelector}"`
          throw new ChromeError(`no element matched ${via}; take a fresh chrome_page_snapshot if the page has changed`, 'CHROME_CDP_ERROR')
        }
      }

      // Use CDP Input.insertText — sends native input events that frameworks
      // handle, unlike Runtime.evaluate + value setter.
      await chrome.cdp({ method: 'Input.insertText', params: { text: args.text } }, exec.signal)

      // Read back the value from the focused element to confirm.
      const valueResult = await chrome.evaluate(
        `(() => { const el = document.activeElement; if (!el) return ''; if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return el.value; return el.textContent || ''; })()`,
        { awaitPromise: false, returnByValue: true, signal: exec.signal },
      )

      return {
        typed: true,
        ...focusSelector !== undefined ? { selector: focusSelector } : {},
        valueAfter: String(valueResult.result ?? ''),
      }
    },
    presentCall(args): GenericCallView {
      const target = args.ref !== undefined && args.ref.trim().length > 0
        ? `ref ${args.ref.trim()}`
        : args.selector ?? 'focused element'
      return { card: 'generic', title: `Type into ${target}`, kind: 'edit', rawInput: args.text }
    },
  }))
  return () => {
    disposeTool()
    disposeSection()
  }
}
