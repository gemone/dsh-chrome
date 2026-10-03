/**
 * Environment emulation over the CDP `Emulation` and `Network` domains:
 * viewport/DPR/mobile, network throttling presets, CPU throttling,
 * geolocation, timezone, locale, and user-agent — plus a one-shot reset.
 * @module dsh-chrome/tools/emulate (service side in service.ts)
 */

/** Network throttling preset names accepted by `chrome_emulate`. */
export type NetworkPreset = 'none' | 'offline' | 'slow3G' | 'fast3G'

/** CDP `Network.emulateNetworkConditions` parameters for one preset. Pure. */
export function networkConditions(preset: NetworkPreset): {
  offline: boolean
  latency: number
  downloadThroughput: number
  uploadThroughput: number
} {
  switch (preset) {
    case 'offline':
      return { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
    case 'slow3G':
      // Chrome DevTools "Slow 3G" preset.
      return { offline: false, latency: 400, downloadThroughput: 400 * 1024 / 8, uploadThroughput: 400 * 1024 / 8 }
    case 'fast3G':
      // Chrome DevTools "Fast 3G" preset.
      return { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 }
    case 'none':
      return { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
  }
}

/** Paper formats accepted by `Page.printToPDF`. */
export const PAPER_FORMATS = ['Letter', 'Legal', 'Tabloid', 'Ledger', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const

/** One paper format name. */
export type PaperFormat = typeof PAPER_FORMATS[number]

/** Validate a paper format name; returns an error message when invalid. Pure. */
export function paperFormatError(format: string): string | undefined {
  if (!(PAPER_FORMATS as readonly string[]).includes(format)) {
    return `paperFormat must be one of: ${PAPER_FORMATS.join(', ')}`
  }
  return undefined
}
