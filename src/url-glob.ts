/**
 * URL matching for network mocks: CDP `Fetch`-style glob patterns. Pure, so
 * it is unit-testable without a browser.
 * @module dsh-chrome/url-glob
 */

/**
 * Test a URL against a CDP `Fetch`-style glob pattern (`*` matches any
 * character run, `?` a single character; other characters literal). Pure.
 */
export function urlMatchesGlob(url: string, pattern: string): boolean {
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return regex.test(url)
}
