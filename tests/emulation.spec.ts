import { describe, expect, it } from 'vitest'
import { networkConditions, paperFormatError, PAPER_FORMATS } from '../src/emulation.ts'

describe('networkConditions presets', () => {
  it('matches the Chrome DevTools preset shapes', () => {
    expect(networkConditions('offline')).toEqual({ offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    expect(networkConditions('none')).toEqual({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    const slow = networkConditions('slow3G')
    expect(slow.offline).toBe(false)
    expect(slow.latency).toBe(400)
    expect(slow.downloadThroughput).toBeCloseTo(50 * 1024, 0)
    const fast = networkConditions('fast3G')
    expect(fast.latency).toBe(150)
    expect(fast.downloadThroughput).toBeGreaterThan(slow.downloadThroughput)
    expect(fast.uploadThroughput).toBeGreaterThan(slow.uploadThroughput)
  })
})

describe('paper formats', () => {
  it('accepts every listed format and rejects unknown ones', () => {
    for (const format of PAPER_FORMATS) {
      expect(paperFormatError(format)).toBeUndefined()
    }
    expect(paperFormatError('B5')).toMatch(/paperFormat must be one of/)
  })
})
