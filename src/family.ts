/**
 * Shared plumbing for the family component rows: each row injects the core
 * row's `chrome` service and registers its own tool slice. A live
 * `operationTimeoutMs` edit on the core row changes the declared `timeoutMs`
 * of every family tool, so families listen for the core's
 * `chrome/registrations-changed` notification and re-register.
 * @module dsh-chrome/family
 */

import type { Context } from '@deepseek-ai/cordis'
import { FAMILY_REGISTERERS, type FamilyRegistrar } from './registry.ts'
import type { FamilyKey } from './registry.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** The core component row refreshed its declared timeout budgets; family rows re-register their tools. */
    'chrome/registrations-changed': () => void
  }
}

/** The event the core row broadcasts when declared timeout budgets change. */
export const REGISTRATIONS_CHANGED = 'chrome/registrations-changed'

/**
 * Register one family's tools over the injected service and re-register them
 * whenever the core row reports a timeout-budget change. Registration is
 * synchronous; the first `chrome` read happens after the inject resolved.
 * @param ctx - the family row's plugin context (`chrome`, `tools`, `systemPrompt` injected).
 * @param keys - the family's tool keys, in registration order.
 */
export function applyFamily(ctx: Context, keys: readonly FamilyKey[]): void {
    const chrome = ctx.chrome
  const settings = chrome.settings
  let disposers: (() => void)[] = []
  const register = (): void => {
    for (const key of keys) {
      const registrar: FamilyRegistrar = FAMILY_REGISTERERS[key]
      disposers.push(registrar(ctx, chrome, settings))
    }
  }
  register()
  ctx.on(REGISTRATIONS_CHANGED, () => {
    for (const dispose of disposers) dispose()
    disposers = []
    register()
  })
}
