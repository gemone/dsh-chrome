import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_SCREENSHOT_ANALYSIS_PROMPT,
  analyzeScreenshot,
  assertAnalysisRouteAcceptsImages,
} from '../src/analysis.ts'

const IMAGE: ImageAttachmentRef = {
  attachmentId: 'att-1' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  bytes: 100,
  width: 10,
  height: 20,
  name: 'chrome-screenshot.png',
}

/** Minimal LlmRuntime stand-in: records the call and streams fixed chunks. */
function stubLlm(chunks: StreamChunk[], capture?: { options?: GenerateOptions }): LlmRuntime {
  return {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (capture !== undefined) capture.options = options
      for (const chunk of chunks) yield chunk
    },
  } as unknown as LlmRuntime
}

describe('analyzeScreenshot', () => {
  it('collects text deltas into the description', async () => {
    const captured: { options?: GenerateOptions } = {}
    const llm = stubLlm([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'A login form ' },
      { type: 'text-delta', index: 0, text: 'with one button.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'A login form with one button.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ], captured)
    const text = await analyzeScreenshot(llm, { provider: 'acme', model: 'vision-1' }, IMAGE, undefined)
    expect(text).toBe('A login form with one button.')
    // The one-shot call routes to the configured analysis model.
    expect(captured.options?.provider).toBe('acme')
    expect(captured.options?.model).toBe('vision-1')
    expect(captured.options?.maxTokens).toBeUndefined()
    // The user message carries the default prompt and the image attachment.
    const message = captured.options?.messages[0]!
    expect(message.role).toBe('user')
    const blocks = message.content as Array<Record<string, unknown>>
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain(DEFAULT_SCREENSHOT_ANALYSIS_PROMPT.slice(0, 40))
    expect(blocks[1]?.type).toBe('image')
  })

  it('appends the caller question and forwards maxTokens', async () => {
    const captured: { options?: GenerateOptions } = {}
    const llm = stubLlm([
      { type: 'text-delta', index: 0, text: 'the total is 42' },
      { type: 'finish', reason: { kind: 'stop' } },
    ], captured)
    const text = await analyzeScreenshot(llm, { provider: 'p', model: 'm', maxTokens: 512 }, IMAGE, 'What is the total?')
    expect(text).toBe('the total is 42')
    expect(captured.options?.maxTokens).toBe(512)
    const blocks = captured.options?.messages[0]!.content as Array<Record<string, unknown>>
    expect(String(blocks[0]?.text)).toContain('What is the total?')
  })

  it('keeps partial text on a max-tokens finish', async () => {
    const llm = stubLlm([
      { type: 'text-delta', index: 0, text: 'partial ' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    await expect(analyzeScreenshot(llm, { provider: 'p', model: 'm' }, IMAGE, undefined)).resolves.toBe('partial')
  })

  it('throws on an error finish', async () => {
    const llm = stubLlm([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'PROVIDER' } } },
    ])
    await expect(analyzeScreenshot(llm, { provider: 'p', model: 'm' }, IMAGE, undefined)).rejects.toThrow(/p\/m.*failed: boom/)
  })

  it('throws when no text comes back', async () => {
    const llm = stubLlm([{ type: 'finish', reason: { kind: 'stop' } }])
    await expect(analyzeScreenshot(llm, { provider: 'p', model: 'm' }, IMAGE, undefined)).rejects.toThrow(/returned no text/)
  })
})

describe('assertAnalysisRouteAcceptsImages', () => {
  const route = { provider: 'p', model: 'm' }

  it('accepts a route declaring image input', async () => {
    const llm = {
      async resolveModelInfo() {
        return { provider: 'p', id: 'm', name: 'M', inputModalities: ['text', 'image'] }
      },
    } as unknown as LlmRuntime
    await expect(assertAnalysisRouteAcceptsImages(llm, route)).resolves.toBeUndefined()
  })

  it('refuses a route without declared image input', async () => {
    const llm = {
      async resolveModelInfo() {
        return { provider: 'p', id: 'm', name: 'M', inputModalities: ['text'] }
      },
    } as unknown as LlmRuntime
    await expect(assertAnalysisRouteAcceptsImages(llm, route)).rejects.toThrow(/does not declare image input/)
  })

  it('refuses a route with unknown modalities', async () => {
    const llm = {
      async resolveModelInfo() {
        return { provider: 'p', id: 'm', name: 'M' }
      },
    } as unknown as LlmRuntime
    await expect(assertAnalysisRouteAcceptsImages(llm, route)).rejects.toThrow(/does not declare image input/)
  })
})
