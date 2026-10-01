import { describe, expect, it } from 'vitest'
import { headlessFlag, normalizeDebugEndpoint } from '../src/launcher.ts'
import { parseJsonString } from '../src/service.ts'
import { formatEvaluate } from '../src/tools/evaluate.ts'
import { formatSnapshot } from '../src/tools/snapshot.ts'
import { formatScreenshotAnalysisOutput, formatScreenshotOutput, mediaTypeForFormat } from '../src/tools/screenshot.ts'
import { formatPageSnapshot, normalizePageRef, pageSnapshotExpression } from '../src/page-walker.ts'
import { markdownExpression } from '../src/markdown.ts'
import { computeCaptureScale } from '../src/types.ts'

describe('headlessFlag', () => {
  it('maps the three headless modes', () => {
    expect(headlessFlag(false)).toBe('')
    expect(headlessFlag('new')).toBe('--headless=new')
    expect(headlessFlag(true)).toBe('--headless')
  })
})

describe('normalizeDebugEndpoint', () => {
  it('rewrites a localhost debug endpoint to the loopback IP', () => {
    expect(normalizeDebugEndpoint('http://localhost:9222')).toBe('http://127.0.0.1:9222')
    expect(normalizeDebugEndpoint('http://localhost:9222/')).toBe('http://127.0.0.1:9222/')
  })
  it('leaves IP and named hosts alone', () => {
    expect(normalizeDebugEndpoint('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222')
    expect(normalizeDebugEndpoint('http://chrome.internal:9222')).toBe('http://chrome.internal:9222')
  })

  it('also normalizes ws://localhost (same HTTP handshake rule)', () => {
    expect(normalizeDebugEndpoint('ws://localhost:9222/devtools/browser/x')).toBe('ws://127.0.0.1:9222/devtools/browser/x')
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
  it('hints the JSON.stringify idiom when the expression returned undefined', () => {
    const text = formatEvaluate({ result: (undefined as unknown) as never })
    expect(text).toContain('undefined')
    expect(text).toContain('JSON.stringify')
  })
})

describe('formatSnapshot', () => {
  it('includes the url, title, readyState, format, and text', () => {
    const text = formatSnapshot({ url: 'https://example.com', title: 'Example', readyState: 'complete', text: 'hello', truncated: false, format: 'text' })
    expect(text).toContain('https://example.com')
    expect(text).toContain('Example')
    expect(text).toContain('Ready: complete')
    expect(text).toContain('Format: text')
    expect(text).toContain('hello')
    expect(text).not.toContain('truncated')
  })
  it('appends a truncation notice', () => {
    const text = formatSnapshot({ url: 'u', title: 't', readyState: 'complete', text: 'ab', truncated: true, format: 'text' })
    expect(text).toContain('Content truncated')
  })
  it('explains empty text and points at the alternatives', () => {
    const loading = formatSnapshot({ url: 'u', title: 't', readyState: 'loading', text: '', truncated: false, format: 'text' })
    expect(loading).toContain('readyState is "loading"')
    const nonHtml = formatSnapshot({ url: 'u', title: 't', readyState: 'complete', text: '', truncated: false, format: 'markdown' })
    expect(nonHtml).toContain('chrome_page_snapshot')
  })
})

describe('markdownExpression', () => {
  it('embeds the character budget and the converter scaffolding', () => {
    const expression = markdownExpression(4321)
    expect(expression).toContain('MAX_CHARS = 4321')
    expect(expression).toContain('renderChildren')
    expect(expression).toContain('renderTable')
    expect(expression).toContain('renderList')
    expect(expression).toContain('```')
  })
  it('clamps the budget to a sane minimum', () => {
    expect(markdownExpression(1)).toContain('MAX_CHARS = 100')
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
    expect(text).not.toContain('normalized')
    expect(text).not.toContain('scale')
  })
  it('notes store normalization and capture clamping in the envelope', () => {
    const text = formatScreenshotOutput(
      { attachmentId: 'a', mediaType: 'image/jpeg', bytes: 12, width: 512, height: 8000, originalDimensions: { width: 1280, height: 20000 } },
      { sourceWidth: 1280, sourceHeight: 20000, scale: 0.4 },
    )
    expect(text).toContain('normalized from 1280x20000')
    expect(text).toContain('scale 0.400')
    expect(text).toContain('admission limits')
  })
  it('formats the analysis envelope as text-only output', () => {
    const text = formatScreenshotAnalysisOutput({
      image: { attachmentId: 'a', mediaType: 'image/png', bytes: 12, width: 10, height: 20 },
      analysis: { provider: 'p', model: 'vision-1', text: 'A login form with a disabled submit button.' },
    })
    expect(text).toContain('screenshot-analyzed')
    expect(text).toContain('A login form with a disabled submit button.')
    expect(text).toContain('p/vision-1')
  })
})

describe('computeCaptureScale', () => {
  const DIM = 8192
  const PIXELS = 64_000_000

  it('returns 1 when the page fits', () => {
    expect(computeCaptureScale(1280, 800, { maxDimension: DIM, maxPixels: PIXELS })).toBe(1)
    expect(computeCaptureScale(1280, 8192, { maxDimension: DIM, maxPixels: PIXELS })).toBe(1)
    expect(computeCaptureScale(1280, 8000, {})).toBe(1)
  })

  it('clamps by the long edge', () => {
    // 1280×16384 → scale 0.5 → 640×8192
    expect(computeCaptureScale(1280, 16384, { maxDimension: DIM })).toBeCloseTo(0.5)
  })

  it('clamps by total pixels', () => {
    expect(computeCaptureScale(8000, 8000, { maxPixels: PIXELS })).toBe(1)
    expect(computeCaptureScale(8000, 16000, { maxPixels: PIXELS })).toBeCloseTo(Math.sqrt(0.5))
  })

  it('takes the tighter of both caps', () => {
    expect(computeCaptureScale(4096, 32768, { maxDimension: DIM, maxPixels: PIXELS })).toBeCloseTo(0.25)
  })

  it('ignores degenerate inputs', () => {
    expect(computeCaptureScale(0, 100, { maxDimension: DIM })).toBe(1)
    expect(computeCaptureScale(-5, 100, { maxDimension: DIM })).toBe(1)
    expect(computeCaptureScale(100, 100, { maxDimension: 0, maxPixels: 0 })).toBe(1)
  })

  it('produces in-budget rasters', () => {
    const cases = [[1280, 20000], [6000, 6000], [1024, 100000]] as const
    for (const [w, h] of cases) {
      const scale = computeCaptureScale(w, h, { maxDimension: DIM, maxPixels: PIXELS })
      expect(Math.max(w, h) * scale).toBeLessThanOrEqual(DIM + 1e-6)
      expect(w * h * scale * scale).toBeLessThanOrEqual(PIXELS + 1)
    }
  })
})

describe('page-walker helpers', () => {
  it('normalizes the ref shapes a model may copy', () => {
    expect(normalizePageRef('e12')).toBe('e12')
    expect(normalizePageRef(' E12 ')).toBe('e12')
    expect(normalizePageRef('[e12]')).toBe('e12')
    expect(normalizePageRef('ref=e12')).toBe('e12')
    expect(normalizePageRef('[ref=e12]')).toBe('e12')
    expect(normalizePageRef('[REF=e12]')).toBe('e12')
  })
  it('rejects non-ref strings', () => {
    expect(normalizePageRef('#submit')).toBeUndefined()
    expect(normalizePageRef('button')).toBeUndefined()
    expect(normalizePageRef('')).toBeUndefined()
    expect(normalizePageRef('e')).toBeUndefined()
  })
  it('embeds the node budget and ref emission into the expression', () => {
    const expression = pageSnapshotExpression(123)
    expect(expression).toContain('MAX_NODES = 123')
    expect(expression).toContain('[ref=')
    expect(expression).toContain('refs[ref]')
    expect(expression.trim().startsWith('(() =>')).toBe(true)
  })
  it('clamps the node budget to a sane minimum', () => {
    expect(pageSnapshotExpression(0)).toContain('MAX_NODES = 10')
  })
  it('formats the structured snapshot with header, hint, and truncation notice', () => {
    const text = formatPageSnapshot({ url: 'https://example.com', title: 'Example', readyState: 'complete', tree: '- button "Go" [ref=e1]', refCount: 1, truncated: false })
    expect(text).toContain('https://example.com')
    expect(text).toContain('- button "Go" [ref=e1]')
    expect(text).toContain('chrome_click')
    expect(text).not.toContain('truncated')
    const cut = formatPageSnapshot({ url: 'u', title: 't', readyState: 'complete', tree: 'x', refCount: 0, truncated: true })
    expect(cut).toContain('truncated')
  })
})
