/**
 * Shared selector/ref target resolution for the acting tools. Tools accept
 * either a CSS `selector` or a `[ref=eN]` id from `chrome_page_snapshot`; this
 * module resolves the pair into exactly one CSS selector with actionable
 * errors that teach the model the use-browser flow.
 * @module dsh-chrome/tools/ref-target
 */

import type { ChromeRuntime } from '../service.ts'
import { normalizePageRef } from '../page-walker.ts'

/** Tool arguments carrying a target, in either form. */
export interface TargetArgs {
  readonly selector?: string
  readonly ref?: string
}

/** Resolve one `[ref=eN]` id against the runtime's latest page snapshot. */
export function resolveRefSelector(chrome: ChromeRuntime, ref: string): string {
  const normalized = normalizePageRef(ref)
  if (normalized === undefined) {
    throw new Error(`invalid ref ${JSON.stringify(ref)}: expected the "eN" form chrome_page_snapshot prints, e.g. "e12"`)
  }
  const selector = chrome.resolvePageRef(normalized)
  if (selector === undefined) {
    throw new Error(
      `ref "${normalized}" is unknown — page refs are invalidated by navigation and reconnection; take a fresh chrome_page_snapshot and pass a ref from it`,
    )
  }
  return selector
}

/**
 * Resolve a tool's target arguments to one CSS selector. `ref` wins when both
 * are given (it pins the exact element the snapshot showed).
 *
 * @param chrome - the runtime holding the latest page-snapshot refs.
 * @param args - the tool's `selector`/`ref` arguments.
 * @returns the CSS selector to act on.
 * @throws when neither form is supplied or the ref is stale/invalid.
 */
export function resolveTargetSelector(chrome: ChromeRuntime, args: TargetArgs): string {
  if (args.ref !== undefined && args.ref.trim().length > 0) return resolveRefSelector(chrome, args.ref)
  if (args.selector !== undefined && args.selector.trim().length > 0) return args.selector
  throw new Error('provide either "selector" (a CSS selector) or "ref" (an id like "e12" from chrome_page_snapshot)')
}
