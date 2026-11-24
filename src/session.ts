/**
 * The session family component row: chrome_tab, chrome_storage, chrome_upload, chrome_emulate, chrome_net_mock — tabs, storage, uploads, emulation, mocks. Injects the core row's
 * `chrome` service; enabling this row without the core row leaves it stopped.
 * @module dsh-chrome/session
 */

import { applyFamily } from './family.ts'

export const name = 'chrome-tool-session'
export const inject = ['chrome', 'tools', 'systemPrompt']

/** Register the session family's tools and prompt guidance. */
export function apply(ctx: Parameters<typeof applyFamily>[0]): void {
  applyFamily(ctx, ['tab', 'storage', 'upload', 'emulate', 'netMock'])
}
