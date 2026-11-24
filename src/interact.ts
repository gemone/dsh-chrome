/**
 * The interact family component row: chrome_click, chrome_type, chrome_scroll, chrome_press_key — click, type, scroll, and send keys. Injects the core row's
 * `chrome` service; enabling this row without the core row leaves it stopped.
 * @module dsh-chrome/interact
 */

import { applyFamily } from './family.ts'

export const name = 'chrome-tool-interact'
export const inject = ['chrome', 'tools', 'systemPrompt']

/** Register the interact family's tools and prompt guidance. */
export function apply(ctx: Parameters<typeof applyFamily>[0]): void {
  applyFamily(ctx, ['click', 'scroll', 'type', 'pressKey'])
}
