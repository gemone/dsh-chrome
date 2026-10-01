/**
 * Screenshot analysis through a configured image-capable model route. When
 * the agent's own route cannot carry images, `chrome_screenshot` can still
 * capture the page and have a dedicated vision model describe it: the capture
 * is durably saved as an attachment (the same lifecycle as any user-uploaded
 * image), then one hand-built one-shot `llm.stream()` call sends that image
 * plus the analysis prompt to the configured provider/model, and the tool
 * returns the description as plain text the calling route can always carry.
 * @module dsh-chrome/analysis
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSourceMap, StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * The message source of one screenshot-analysis call. `MessageSourceMap` is
 * merge-extensible (compaction registers `compact-checkpoint` the same way),
 * so the transient analysis request carries an honest, distinguishable kind
 * rather than masquerading as user input.
 */
export interface ChromeAnalysisSource {
  kind: 'chrome-analysis'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'chrome-analysis': ChromeAnalysisSource
  }
}

/** A configured analysis route; `provider`/`model` name an image-capable model. */
export interface ScreenshotAnalysisRoute {
  /** Registered provider route that owns the analysis model. */
  readonly provider: string
  /** Exact model id that accepts image input. */
  readonly model: string
  /** Base instruction for the analysis call; a sensible default when omitted. */
  readonly prompt?: string
  /** Output cap for the analysis call, when set. */
  readonly maxTokens?: number
}

/** Default instruction sent with every screenshot the analysis model describes. */
export const DEFAULT_SCREENSHOT_ANALYSIS_PROMPT = [
  'You are analyzing a screenshot of a web page captured by a browser automation tool.',
  'The requesting agent cannot see images, so your text description is its only view of the page.',
  'Describe: the overall layout and purpose; every interactive control worth acting on (buttons, links, inputs) with their visible labels and current values;',
  'any dialog, banner, error message, or empty state; and anything visually broken.',
  'Be factual and concise. Do not speculate beyond what is visible.',
].join(' ')

/**
 * Require one provider/model route to declare image input, with an error that
 * names the misconfigured route (mirrors the agent-route gate's strictness:
 * absent modality info is a refusal, since the call would only fail later).
 */
export async function assertAnalysisRouteAcceptsImages(llm: LlmRuntime, route: ScreenshotAnalysisRoute, signal?: AbortSignal): Promise<void> {
  const active = await llm.resolveModelInfo(route.provider, route.model, signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `the configured screenshotAnalysis model "${route.provider}/${route.model}" does not declare image input; `
      + 'point screenshotAnalysis at a vision-capable provider/model pair, or remove it to fall back to text-only page tools',
    )
  }
}

/**
 * Describe one saved screenshot through the configured analysis model.
 *
 * @param llm - the LLM runtime to place the one-shot call through.
 * @param route - the configured analysis provider/model.
 * @param image - the durably saved screenshot reference.
 * @param question - optional caller question appended to the base prompt.
 * @param signal - caller cancellation for the model call.
 * @returns the analysis text (trimmed).
 * @throws when the model call fails, aborts, or returns no text.
 */
export async function analyzeScreenshot(
  llm: LlmRuntime,
  route: ScreenshotAnalysisRoute,
  image: ImageAttachmentRef,
  question: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const instruction = [route.prompt !== undefined && route.prompt.trim().length > 0 ? route.prompt.trim() : DEFAULT_SCREENSHOT_ANALYSIS_PROMPT]
  if (question !== undefined && question.trim().length > 0) instruction.push(`The requesting agent asks: ${question.trim()}`)

  const message = createUserMessage({
    content: [
      { type: 'text', text: instruction.join('\n\n') },
      { type: 'image', attachment: image },
    ],
    source: { kind: 'chrome-analysis' },
  })

  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [message],
    ...route.maxTokens !== undefined ? { maxTokens: route.maxTokens } : {},
    signal,
  })

  let text = ''
  for await (const chunk of stream as AsyncIterable<StreamChunk>) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error') {
        throw new Error(`screenshot analysis by "${route.provider}/${route.model}" failed: ${chunk.reason.failure.message}`)
      }
      if (chunk.reason.kind === 'aborted') {
        throw new Error(`screenshot analysis by "${route.provider}/${route.model}" was aborted: ${chunk.reason.failure.message}`)
      }
      // 'stop', 'max-tokens' (keep any partial text), and 'tool-calls' (a
      // tools-free call cannot produce tool calls; treat like stop).
    }
  }
  if (text.trim().length === 0) {
    throw new Error(`screenshot analysis by "${route.provider}/${route.model}" returned no text`)
  }
  return text.trim()
}
