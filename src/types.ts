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
  /** Intrinsic width of the produced raster, when decoded. */
  readonly width?: number
  /** Intrinsic height of the produced raster, when decoded. */
  readonly height?: number
  /** Page-content width the capture covers, when known. */
  readonly sourceWidth?: number
  /** Page-content height the capture covers, when known. */
  readonly sourceHeight?: number
  /**
   * Scale applied to fit admission limits, when the raw page exceeded them
   * (1 = unclamped). A 1280×20000 page captured at scale 0.4 yields 512×8000.
   */
  readonly scale?: number
}

/**
 * Compute the capture scale that fits a page rectangle inside the attachment
 * admission limits. Pure so it is unit-testable.
 *
 * @param width - page content width (px).
 * @param height - page content height (px).
 * @param limits - admission caps; absent fields are not constrained.
 * @returns a scale in (0, 1] — 1 when the raw size already fits.
 */
export function computeCaptureScale(
  width: number,
  height: number,
  limits: { readonly maxDimension?: number; readonly maxPixels?: number },
): number {
  if (!(width > 0) || !(height > 0)) return 1
  let scale = 1
  const longEdge = Math.max(width, height)
  if (limits.maxDimension !== undefined && limits.maxDimension > 0 && longEdge > limits.maxDimension) {
    scale = Math.min(scale, limits.maxDimension / longEdge)
  }
  if (limits.maxPixels !== undefined && limits.maxPixels > 0 && width * height > limits.maxPixels) {
    scale = Math.min(scale, Math.sqrt(limits.maxPixels / (width * height)))
  }
  return scale
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
  /** `document.readyState` at snapshot time — distinguishes "still loading" from "no text". */
  readonly readyState: string
  /** Bounded visible text content of the page body (or the converted Markdown). */
  readonly text: string
  /** Whether `text` was cut at `maxChars`. */
  readonly truncated: boolean
}

/** Result of the structured (use-browser style) page snapshot. */
export interface PageTreeSnapshotResult {
  /** The page URL at snapshot time. */
  readonly url: string
  /** The page title at snapshot time. */
  readonly title: string
  /** `document.readyState` at snapshot time. */
  readonly readyState: string
  /** Indented element tree with `[ref=eN]` ids. */
  readonly tree: string
  /** Number of actionable refs registered for click/type/scroll. */
  readonly refCount: number
  /** Whether the node budget cut the walk short. */
  readonly truncated: boolean
}

/** Result of clicking an element. */
export interface ClickResult {
  /** Whether a matching element was found and clicked. */
  readonly clicked: boolean
  /** The selector that was resolved. */
  readonly selector: string
  /**
   * Description of the element actually sitting on top of the click point
   * (e.g. a cookie banner overlay), when it is not the target or one of its
   * ancestors/descendants. The click is still dispatched, but it likely hit
   * the overlay — dismiss it first.
   */
  readonly coveredBy?: string
}

/** Low-level CDP passthrough request. */
export interface CdpRequest {
  /** Fully-qualified CDP method, e.g. `Page.reload`. */
  readonly method: string
  /** Method parameters (any lossless JSON object). */
  readonly params?: Record<string, unknown>
}
