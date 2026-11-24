/**
 * The model-facing `chrome_press_key` tool: dispatch a single keyboard event
 * via CDP `Input.dispatchKeyEvent` — Enter, Tab, Escape, arrows, function keys,
 * etc. This is the proper way to trigger keyboard interactions that DOM events
 * and frameworks respond to.
 * @module dsh-chrome/tools/press-key
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import type { ChromeSettings } from '../settings.ts'

/** Canonical `chrome_press_key` outcome. */
export interface ChromePressKeyValue {
  key: string
  code: string
  pressed: boolean
}

/** CDP virtual-key code for common named keys. */
const KEY_CODES: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32 },
}

// F1–F12
for (let i = 1; i <= 12; i++) KEY_CODES[`F${i}`] = { code: `F${i}`, keyCode: 111 + i }

/** Resolve a key name to its CDP code + keyCode. */
function resolveKey(key: string): { code: string; keyCode: number } {
  const mapped = KEY_CODES[key]
  if (mapped !== undefined) return mapped
  // Single character keys: derive code from the character.
  if (key.length === 1) {
    const upper = key.toUpperCase()
    return { code: upper >= 'A' && upper <= 'Z' ? `Key${upper}` : upper, keyCode: key.charCodeAt(0) }
  }
  // Fallback: use key name as code, 0 for keyCode.
  return { code: key, keyCode: 0 }
}

/** Register `chrome_press_key` and its prompt guidance. */
export function applyChromePressKeyTool(ctx: Context, chrome: ChromeRuntime, settings: ChromeSettings): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:chrome_press_key',
    order: 117,
    text: 'Use the chrome_press_key tool to press a single keyboard key: Enter, Tab, Escape, Backspace, arrows, F-keys, etc. Dispatches real keyboard events via the DevTools Protocol.',
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: 'chrome_press_key',
    description: 'Press a single keyboard key (Enter, Tab, Escape, Backspace, arrows, F-keys, etc.) via real keyboard events.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key name: "Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Delete", "F1"–"F12", "Space", or a single character.' },
      selector: { type: 'string', description: 'CSS selector to focus before pressing. If omitted, uses the currently focused element.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          code: { type: 'string', required: true },
          pressed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: value.pressed ? `Pressed ${value.key} (${value.code}).` : `Failed to press ${value.key}.` },
      ],
    },
    timeoutMs: settings.operationTimeoutMs(),
    async execute(args, exec) {
      if (args.key.length === 0) throw new Error('key must be a non-empty string')

      // Optionally focus a target element first.
      if (args.selector) {
        await chrome.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (el) el.focus(); })()`,
          { awaitPromise: false, returnByValue: true, signal: exec.signal },
        )
      }

      const { code, keyCode } = resolveKey(args.key)

      // keyDown — the actual key event
      await chrome.cdp({
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          key: args.key,
          code,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
          ...args.key.length === 1 ? { text: args.key } : {},
        },
      }, exec.signal)

      // keyUp
      await chrome.cdp({
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyUp',
          key: args.key,
          code,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
        },
      }, exec.signal)

      return { key: args.key, code, pressed: true }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Press ${args.key}`, kind: 'execute', rawInput: args.key }
    },
  }))
  return () => {
    disposeTool()
    disposeSection()
  }
}
