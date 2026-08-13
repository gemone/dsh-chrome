/**
 * The model-facing `chrome_screenshot` tool. Captures a screenshot over CDP
 * (`Page.captureScreenshot`), durably commits the bytes through the attachment
 * service (the same lifecycle as a user-uploaded image, mirrored from the
 * `read_image` tool), and returns an image block so the capture enters model
 * context from the next request onward.
 *
 * The tool requires an image-capable model route and a mounted attachment
 * service, exactly like `read_image`: a tool result is durable session history,
 * so emitting an image on a route that cannot carry it would break that route's
 * continuation.
 * @module dsh-chrome/tools/screenshot
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'

/** Canonical `chrome_screenshot` outcome. */
export interface ChromeScreenshotValue {
  image: {
    attachmentId: string
    mediaType: ScreenshotMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
}

/** Media types a screenshot can produce (CDP capture formats exclude GIF). */
export type ScreenshotMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

/** Map a screenshot format to its declared image media type. */
export function mediaTypeForFormat(format: 'png' | 'jpeg' | 'webp'): ScreenshotMediaType {
  return `image/${format}` as ScreenshotMediaType
}

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
    throw new Error('cannot capture a screenshot: the current model route could not be resolved')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot capture a screenshot: model "${model}" does not declare image input; switch to an image-capable model to read screenshots`)
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
export function formatScreenshotOutput(image: ChromeScreenshotValue['image']): string {
  return `<screenshot>\n${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes\n</screenshot>`
}

/** Project the canonical value into its envelope + image content blocks. */
function screenshotContent(value: ChromeScreenshotValue): ContentBlock[] {
  return [
    { type: 'text', text: formatScreenshotOutput(value.image) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

/** Register `chrome_screenshot` and its prompt guidance. */
export function applyChromeScreenshotTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_screenshot',
    order: 114,
    text: 'Use the chrome_screenshot tool to capture what the controlled Chrome page currently shows and return the image. Requires an image-capable model. Useful when text alone cannot convey layout or a visual failure.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_screenshot',
    description: 'Capture a screenshot of the controlled Chrome page and return the image. Requires the current model to accept image input.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default) rather than only the viewport.' },
      format: {
        type: 'string',
        description: 'Image format: "png" (default), "jpeg", or "webp".',
        enum: ['png', 'jpeg', 'webp'],
      },
      quality: { type: 'integer', description: 'JPEG quality 0–100 (only applies to "jpeg").' },
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
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => screenshotContent(value),
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
      await assertImageCapableRoute(ctx, exec)

      const captured = await chrome.screenshot({
        format,
        ...args.fullPage !== undefined ? { fullPage: args.fullPage } : {},
        ...args.quality !== undefined ? { quality: args.quality } : {},
        signal: exec.signal,
      })

      // Persist before returning: the image block must reference a durably
      // committed object by the time the tool/result event is appended.
      const ref = await attachments.saveImage({ data: captured.data, mediaType, name: `chrome-screenshot-${Date.now()}.${format}` })
      const value: ChromeScreenshotValue = {
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType as ScreenshotMediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: screenshotContent(value),
          source: { kind: 'plugin', plugin: 'chrome-tool' },
        }))
      }
      return value
    },
    presentCall(): GenericCallView {
      return { card: 'generic', title: 'Capture screenshot', kind: 'read' }
    },
  }))
}
