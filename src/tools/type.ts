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
import { ChromeError } from '../types.ts'

/** Canonical `chrome_type` outcome. */
export interface ChromeTypeValue {
  typed: boolean
  selector: string | null
  valueAfter: string
}

/** Register `chrome_type` and its prompt guidance. */
export function applyChromeTypeTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_type',
    order: 116,
    text: 'Use the chrome_type tool to type text into a focused element via real keyboard events. It triggers native input events that React/Vue/Angular frameworks handle correctly. Prefer this over evaluate+setter for form input.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_type',
    description: 'Type text into a focused element using real keyboard events. Triggers native input events that frameworks handle correctly.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to type.' },
      selector: { type: 'string', description: 'CSS selector to focus before typing. If omitted, types into the currently focused element.' },
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
    timeoutMs,
    async execute(args, exec) {
      if (args.text.length === 0) throw new Error('text must be a non-empty string')

      // Optionally focus a target element first.
      if (args.selector) {
        const focusResult = await chrome.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return 'not_found'; el.focus(); return 'ok'; })()`,
          { awaitPromise: false, returnByValue: true, signal: exec.signal },
        )
        if (focusResult.result === 'not_found') {
          throw new ChromeError(`no element matched selector "${args.selector}"`, 'CHROME_CDP_ERROR')
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
        ...args.selector !== undefined ? { selector: args.selector } : {},
        valueAfter: String(valueResult.result ?? ''),
      }
    },
    presentCall(args): GenericCallView {
      const target = args.selector ?? 'focused element'
      return { card: 'generic', title: `Type into ${target}`, kind: 'edit', rawInput: args.text }
    },
  }))
}
