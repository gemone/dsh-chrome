/**
 * The capture family component row: chrome_screenshot, chrome_pdf, chrome_mhtml — captures and document exports. Injects the core row's
 * `chrome` service; enabling this row without the core row leaves it stopped.
 * @module dsh-chrome/capture
 */

import { applyFamily } from './family.ts'

export const name = 'chrome-tool-capture'
export const inject = ['chrome', 'tools', 'systemPrompt']

/** Register the capture family's tools and prompt guidance. */
export function apply(ctx: Parameters<typeof applyFamily>[0]): void {
  applyFamily(ctx, ['screenshot', 'pdf', 'mhtml'])
}
