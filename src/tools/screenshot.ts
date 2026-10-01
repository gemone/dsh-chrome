/**
 * The model-facing `chrome_screenshot` tool. Captures a screenshot over CDP
 * (`Page.captureScreenshot`), durably commits the bytes through the attachment
 * service (the same lifecycle as a user-uploaded image, mirrored from the
 * `read_image` tool), and then delivers it to the agent by one of two paths:
 *
 * - **Image-capable route** (unchanged behavior): the tool result carries an
 *   image block so the capture enters model context from the next request on.
 *   A tool result is durable session history, so emitting an image on a route
 *   that cannot carry it would break that route's continuation.
 * - **Text-only route**: when a `screenshotAnalysis` provider/model is
 *   configured, the saved image is described by that image-capable model in a
 *   one-shot call and the description is returned as plain text. Without an
 *   analysis model the tool refuses *before capturing*, with an error that
 *   redirects the model to the text-first interface tools
 *   (`chrome_page_snapshot`, `chrome_snapshot`, `chrome_evaluate`).
 * @module dsh-chrome/tools/screenshot
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'
import {
  analyzeScreenshot,
  assertAnalysisRouteAcceptsImages,
  type ScreenshotAnalysisRoute,
} from '../analysis.ts'

/** Canonical `chrome_screenshot` outcome. */
export interface ChromeScreenshotValue {
  image: {
    attachmentId: string
    mediaType: ScreenshotMediaType
    bytes: number
    width: number
    height: number
    name?: string
    /** Present when the attachment store normalized (downscaled) the capture. */
    originalDimensions?: { width: number; height: number }
  }
  /** Present when the capture itself was scaled to fit admission limits. */
  capture?: {
    sourceWidth: number
    sourceHeight: number
    scale: number
  }
  /** Present when the description path served a text-only route. */
  analysis?: {
    provider: string
    model: string
    text: string
  }
}

/** Media types a screenshot can produce (CDP capture formats exclude GIF). */
export type ScreenshotMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

/** Map a screenshot format to its declared image media type. */
export function mediaTypeForFormat(format: 'png' | 'jpeg' | 'webp'): ScreenshotMediaType {
  return `image/${format}` as ScreenshotMediaType
}

/** Guidance shared by every refusal on non-image routes. */
export const NO_IMAGE_ROUTE_GUIDANCE = 'to read the interface without images use chrome_page_snapshot (structured element tree whose [ref=eN] ids work with chrome_click/chrome_type/chrome_scroll), chrome_snapshot (visible text), or chrome_evaluate (DOM queries); to get image descriptions, configure the chrome-tool "screenshotAnalysis" option (an image-capable provider/model pair)'

/**
 * Enforce the image-capability gate for the calling route, mirroring
 * {@link read_image}'s gate. Resolves the session's latest routed provider/model
 * and requires the resolved route to declare `image` input explicitly.
 */
export async function assertImageCapableRoute(ctx: Context, exec: ToolExecution): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot capture a screenshot: the current model route could not be resolved; ${NO_IMAGE_ROUTE_GUIDANCE}`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot capture a screenshot: model "${model}" does not declare image input; ${NO_IMAGE_ROUTE_GUIDANCE}`)
  }
}

/** Re-brand the canonical image metadata into the durable attachment reference an image block carries. */
export function imageRefFromValue(image: ChromeScreenshotValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/** Model-facing envelope text beside the image block. */
export function formatScreenshotOutput(image: ChromeScreenshotValue['image'], capture?: ChromeScreenshotValue['capture']): string {
  const normalized = image.originalDimensions !== undefined
    ? ` (normalized from ${image.originalDimensions.width}x${image.originalDimensions.height})`
    : ''
  const clamped = capture !== undefined && capture.scale < 1
    ? ` (page is ${capture.sourceWidth}x${capture.sourceHeight} px; captured at scale ${capture.scale.toFixed(3)} to fit admission limits)`
    : ''
  return `<screenshot>\n${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${normalized}${clamped}\n</screenshot>`
}

/** Model-facing envelope for a screenshot described by the analysis model. */
export function formatScreenshotAnalysisOutput(value: ChromeScreenshotValue): string {
  const analysis = value.analysis!
  return `<screenshot-analyzed>\n${value.image.mediaType} image, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes (saved as attachment ${value.image.attachmentId})\ndescribed by ${analysis.provider}/${analysis.model}:\n<description>\n${analysis.text}\n</description>\n</screenshot-analyzed>`
}

/** Project the canonical value into its model-facing content blocks. */
function screenshotContent(value: ChromeScreenshotValue): ContentBlock[] {
  if (value.analysis !== undefined) {
    // Text-only route: the image must NOT enter content the route cannot carry.
    return [{ type: 'text', text: formatScreenshotAnalysisOutput(value) }]
  }
  return [
    { type: 'text', text: formatScreenshotOutput(value.image, value.capture) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

/** Register `chrome_screenshot` and its prompt guidance. */
export function applyChromeScreenshotTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number, analysisRoute?: ScreenshotAnalysisRoute): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_screenshot',
    order: 114,
    text: analysisRoute === undefined
      ? 'Use the chrome_screenshot tool to capture what the controlled Chrome page currently shows. It requires an image-capable model route; on a text-only route it refuses — use chrome_page_snapshot or chrome_snapshot to read the interface as text instead.'
      : `Use the chrome_screenshot tool to capture what the controlled Chrome page currently shows. On an image-capable route the capture enters context as an image. On a text-only route the capture is described in text by the configured analysis model (${analysisRoute.provider}/${analysisRoute.model}); pass "prompt" to steer that description. For structured reading without any model call, prefer chrome_page_snapshot.`,
  })

  ctx.tools.register(defineTool({
    name: 'chrome_screenshot',
    description: 'Capture a screenshot of the controlled Chrome page. On an image-capable route the image itself is returned; otherwise the configured screenshotAnalysis model describes it as text (when configured), or the tool refuses with text-only alternatives.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default) rather than only the viewport.' },
      format: {
        type: 'string',
        description: 'Image format: "png" (default), "jpeg", or "webp".',
        enum: ['png', 'jpeg', 'webp'],
      },
      quality: { type: 'integer', description: 'JPEG quality 0–100 (only applies to "jpeg").' },
      prompt: { type: 'string', description: 'Optional question or instruction for the configured screenshot-analysis model (used only on text-only routes).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
              originalDimensions: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: { type: 'integer', required: true },
                  height: { type: 'integer', required: true },
                },
              },
            },
          },
          capture: {
            type: 'object',
            additionalProperties: false,
            description: 'Present when the capture was scaled to fit the attachment admission limits.',
            properties: {
              sourceWidth: { type: 'integer', required: true },
              sourceHeight: { type: 'integer', required: true },
              scale: { type: 'number', required: true },
            },
          },
          analysis: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => screenshotContent(value),
      // The UI card follows the durable attachment, not envelope text.
      presentationMeta: (_args, value) => ({ attachmentId: value.image.attachmentId }),
    },
    timeoutMs,
    async execute(args, exec) {
      const format = args.format ?? 'png'
      const mediaType = mediaTypeForFormat(format)

      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('cannot capture a screenshot: no attachment service is mounted')
      }
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`cannot capture a screenshot: ${mediaType} images are not accepted by this deployment`)
      }

      // Decide how the capture can be consumed before doing any work.
      const llm = ctx.get('llm')
      const routed = exec.agent?.session.requestHeader()?.config
      const routeProvider = routed?.provider ?? exec.agent?.options.provider
      const routeModel = routed?.model ?? exec.agent?.options.model
      let routeAcceptsImages = false
      if (routeProvider !== undefined && routeModel !== undefined && llm !== undefined) {
        const info = await llm.resolveModelInfo(routeProvider, routeModel, exec.signal)
        routeAcceptsImages = info.inputModalities?.includes('image') ?? false
      }
      if (!routeAcceptsImages && analysisRoute === undefined) {
        throw new Error(
          routeProvider === undefined || routeModel === undefined || llm === undefined
            ? `cannot capture a screenshot: the current model route could not be resolved; ${NO_IMAGE_ROUTE_GUIDANCE}`
            : `cannot capture a screenshot: model "${routeModel}" does not declare image input; ${NO_IMAGE_ROUTE_GUIDANCE}`,
        )
      }
      if (!routeAcceptsImages && llm === undefined) {
        throw new Error('cannot capture a screenshot: screenshot analysis requires the llm service, which is not mounted')
      }
      // Preflight the analysis route before capturing so a misconfigured
      // vision model costs nothing.
      if (!routeAcceptsImages) {
        await assertAnalysisRouteAcceptsImages(llm!, analysisRoute!, exec.signal)
      }

      // Capture within the deployment's admission budget (DSH 0.1.7 refuses
      // images over maxDimension per side or maxPixels total), so tall
      // full-page shots are scaled at capture time instead of failing at
      // commit time.
      const captured = await chrome.screenshot({
        format,
        ...args.fullPage !== undefined ? { fullPage: args.fullPage } : {},
        ...args.quality !== undefined ? { quality: args.quality } : {},
        signal: exec.signal,
        limits: {
          maxDimension: attachments.imageLimits.maxImageDimension,
          maxPixels: attachments.imageLimits.maxImagePixels,
        },
      })

      // Persist before returning: the image block must reference a durably
      // committed object by the time the tool/result event is appended.
      // Dimension refusals stay recoverable tool errors: an oversized image
      // must never enter durable history (mirrors upstream read_image).
      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({ data: captured.data, mediaType, name: `chrome-screenshot-${Date.now()}.${format}` })
      } catch (error: unknown) {
        if (!(error instanceof AttachmentError)) throw error
        if (error.code === 'IMAGE_DIMENSION_TOO_LARGE') {
          throw new Error(
            `cannot capture a screenshot: at least one image side exceeds the ${attachments.imageLimits.maxImageDimension}px limit; retry with fullPage: false or a narrower viewport`,
            { cause: error },
          )
        }
        if (error.code === 'IMAGE_TOO_MANY_PIXELS') {
          throw new Error(
            `cannot capture a screenshot: the image exceeds the ${attachments.imageLimits.maxImagePixels}-pixel decoded-size limit; retry with fullPage: false`,
            { cause: error },
          )
        }
        if (error.code === 'IMAGE_TOO_LARGE') {
          throw new Error(
            'cannot capture a screenshot: the image cannot be stored within the deployment byte limits; use format "jpeg" with a lower quality, or fullPage: false',
            { cause: error },
          )
        }
        throw error
      }
      const image = {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType as ScreenshotMediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...ref.name === undefined ? {} : { name: ref.name },
        ...ref.originalDimensions !== undefined ? { originalDimensions: ref.originalDimensions } : {},
      }
      const capture = captured.scale !== undefined && captured.sourceWidth !== undefined && captured.sourceHeight !== undefined
        ? { sourceWidth: captured.sourceWidth, sourceHeight: captured.sourceHeight, scale: captured.scale }
        : undefined

      if (routeAcceptsImages) {
        // The image block rides this tool result's own rendered content into
        // model context (the upstream `read_image` flow); no deferred context
        // message is appended.
        return { image, ...capture !== undefined ? { capture } : {} }
      }

      // Text-only route: describe the capture through the analysis model.
      const text = await analyzeScreenshot(llm!, analysisRoute!, ref, args.prompt, exec.signal)
      const value: ChromeScreenshotValue = { image, analysis: { provider: analysisRoute!.provider, model: analysisRoute!.model, text } }
      return value
    },
    presentCall(): GenericCallView {
      return { card: 'generic', title: 'Capture screenshot', kind: 'read' }
    },
  }))
}
