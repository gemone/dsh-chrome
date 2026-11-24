/**
 * The observatory family component row: `chrome_net_list`, `chrome_net_body`,
 * `chrome_console_read` — the network and console observatory. Injects the core
 * row's `chrome` service; enabling this row without the core row leaves it
 * stopped.
 * @module dsh-chrome/observatory-family
 */

import { applyFamily } from './family.ts'

export const name = 'chrome-tool-observatory'
export const inject = ['chrome', 'tools', 'systemPrompt']

/** Register the observatory family's tools and prompt guidance. */
export function apply(ctx: Parameters<typeof applyFamily>[0]): void {
  applyFamily(ctx, ['netLog', 'consoleLog'])
}
