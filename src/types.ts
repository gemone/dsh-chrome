/**
 * Stable error codes and shared types for the Chrome CDP tool family.
 * @module dsh-chrome/types
 */

/** One stable error category raised by the Chrome tool family. */
export type ChromeErrorCode =
  | 'CHROME_NOT_FOUND'
  | 'CHROME_LAUNCH_FAILED'
  | 'CHROME_ENDPOINT_UNREACHABLE'
  | 'CHROME_CDP_ERROR'
  | 'CHROME_TIMEOUT'
  | 'CHROME_ABORTED'

/** Framework error carrying a stable machine-readable code. */
export class ChromeError extends Error {
  readonly code: ChromeErrorCode

  constructor(message: string, code: ChromeErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ChromeError'
    this.code = code
  }
}

/** Navigation lifecycle the agent can wait for. */
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'

/** Raster format accepted by `Page.captureScreenshot`. */
export type ScreenshotFormat = 'png' | 'jpeg' | 'webp'

/** Mouse button for `chrome_click`. */
export type MouseButton = 'left' | 'right' | 'middle'

/** One captured screenshot before it is durably committed. */
export interface CapturedScreenshot {
  /** Decoded image bytes. */
  readonly data: Uint8Array
  /** Verified media type matching the bytes. */
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
}

/** Result of navigating a target to a URL. */
export interface NavigationResult {
  /** The URL requested. */
  readonly url: string
  /** The final URL after any redirects. */
  readonly finalUrl: string
  /** The page title after navigation settled. */
  readonly title: string
  /** Frame navigation loader id, when CDP returned one. */
  readonly loaderId?: string
}

/** Result of evaluating a JS expression. */
export interface EvaluationResult {
  /** The serialized return value (when `returnByValue` and no exception). */
  readonly result: unknown
  /** CDP exception details when the expression threw. */
  readonly exceptionDetails?: {
    readonly text: string
    readonly exception?: { readonly description?: string }
  }
}

/** Result of reading bounded page text. */
export interface SnapshotResult {
  /** The page URL after the snapshot. */
  readonly url: string
  /** The page title. */
  readonly title: string
  /** Bounded visible text content of the page body. */
  readonly text: string
  /** Whether `text` was cut at `maxChars`. */
  readonly truncated: boolean
}

/** Result of clicking an element. */
export interface ClickResult {
  /** Whether a matching element was found and clicked. */
  readonly clicked: boolean
  /** The selector that was resolved. */
  readonly selector: string
}

/** Low-level CDP passthrough request. */
export interface CdpRequest {
  /** Fully-qualified CDP method, e.g. `Page.reload`. */
  readonly method: string
  /** Method parameters (any lossless JSON object). */
  readonly params?: Record<string, unknown>
}
