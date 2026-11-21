import { describe, expect, it } from 'vitest'
import { urlMatchesGlob } from '../src/url-glob.ts'

describe('urlMatchesGlob', () => {
  it('matches CDP-style URL globs', () => {
    expect(urlMatchesGlob('https://api.example.com/v1/users', 'https://api.example.com/*')).toBe(true)
    expect(urlMatchesGlob('https://api.example.com/v1/users/7', 'https://api.example.com/v1/users')).toBe(false)
    expect(urlMatchesGlob('http://x/a?b=1', 'http://x/a?b=1')).toBe(true)
    expect(urlMatchesGlob('http://x/a/b', 'http://x/a?b')).toBe(true)
    // Dots in hosts must not act as regex wildcards.
    expect(urlMatchesGlob('https://apixexample.com/v1', 'https://api.example.com/*')).toBe(false)
  })
})
