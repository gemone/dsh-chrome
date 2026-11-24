/**
 * The reading family component row: `chrome_navigate`, `chrome_evaluate`,
 * `chrome_snapshot`, `chrome_page_snapshot` — open URLs, run JavaScript, and
 * read pages as text or as a structured element tree. Injects the core row's
 * `chrome` service; enabling this row without the core row leaves it stopped.
 * @module dsh-chrome/reading
 */

import { applyFamily } from './family.ts'

export const name = 'chrome-tool-reading'
export const inject = ['chrome', 'tools', 'systemPrompt']

/** Register the reading family's tools and prompt guidance. */
export function apply(ctx: Parameters<typeof applyFamily>[0]): void {
  applyFamily(ctx, ['navigate', 'evaluate', 'snapshot', 'pageSnapshot'])
}
