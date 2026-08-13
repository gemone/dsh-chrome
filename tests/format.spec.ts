import { describe, expect, it } from 'vitest'
import { headlessFlag } from '../src/launcher.ts'
import { parseJsonString } from '../src/service.ts'
import { formatEvaluate } from '../src/tools/evaluate.ts'
import { formatSnapshot } from '../src/tools/snapshot.ts'
import { formatScreenshotOutput, mediaTypeForFormat } from '../src/tools/screenshot.ts'

describe('headlessFlag', () => {
  it('maps the three headless modes', () => {
    expect(headlessFlag(false)).toBe('')
    expect(headlessFlag('new')).toBe('--headless=new')
    expect(headlessFlag(true)).toBe('--headless')
  })
})

describe('parseJsonString', () => {
  it('parses valid JSON', () => {
    expect(parseJsonString('{"a":1}')).toEqual({ a: 1 })
  })
  it('returns undefined for invalid JSON', () => {
    expect(parseJsonString('nope')).toBeUndefined()
  })
  it('returns undefined for non-string input', () => {
    expect(parseJsonString(undefined)).toBeUndefined()
    expect(parseJsonString(42)).toBeUndefined()
  })
})

describe('formatEvaluate', () => {
  it('renders a value result as JSON', () => {
    expect(formatEvaluate({ result: { ok: true } })).toContain('"ok": true')
    expect(formatEvaluate({ result: { ok: true } })).toMatch(/^<result>/)
  })
  it('renders an exception result with its text', () => {
    const text = formatEvaluate({ result: null, exceptionDetails: { text: 'ReferenceError: x is not defined' } })
    expect(text).toContain('exception')
    expect(text).toContain('ReferenceError')
  })
})

describe('formatSnapshot', () => {
  it('includes the url, title, and text', () => {
    const text = formatSnapshot({ url: 'https://example.com', title: 'Example', text: 'hello', truncated: false })
    expect(text).toContain('https://example.com')
    expect(text).toContain('Example')
    expect(text).toContain('hello')
    expect(text).not.toContain('truncated')
  })
  it('appends a truncation notice', () => {
    const text = formatSnapshot({ url: 'u', title: 't', text: 'ab', truncated: true })
    expect(text).toContain('Content truncated')
  })
})

describe('screenshot helpers', () => {
  it('maps formats to media types', () => {
    expect(mediaTypeForFormat('png')).toBe('image/png')
    expect(mediaTypeForFormat('jpeg')).toBe('image/jpeg')
    expect(mediaTypeForFormat('webp')).toBe('image/webp')
  })
  it('formats the envelope text', () => {
    const text = formatScreenshotOutput({ attachmentId: 'a', mediaType: 'image/png', bytes: 12, width: 10, height: 20 })
    expect(text).toContain('image/png')
    expect(text).toContain('10x20')
    expect(text).toContain('12 bytes')
  })
})
