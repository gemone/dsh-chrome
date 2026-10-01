/**
 * The model-facing `chrome_evaluate` tool over {@link ChromeRuntime.evaluate}.
 * @module dsh-chrome/tools/evaluate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ChromeRuntime } from '../service.ts'

/** Canonical `chrome_evaluate` outcome. */
export interface ChromeEvaluateValue {
  /** Serialized return value (null when the expression returned undefined). */
  result: JsonValue
  /** Present and describes the thrown exception, when the expression threw. */
  exceptionDetails?: { text: string; exception?: { description?: string } }
}

/** Register `chrome_evaluate` and its prompt guidance. */
export function applyChromeEvaluateTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_evaluate',
    order: 111,
    text: 'Use the chrome_evaluate tool to run JavaScript in the controlled Chrome page and read its JSON return value. A thrown exception is returned as exceptionDetails (a successful tool result), not an error. Use the DOM to extract data the page renders with JavaScript.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_evaluate',
    description: 'Evaluate a JavaScript expression in the controlled Chrome page and return its JSON value. A thrown exception is returned as exceptionDetails.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression to evaluate in the page. The value is JSON-serialized, so prefer returning plain data.' },
      awaitPromise: { type: 'boolean', description: 'Await a Promise result before returning. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'json', required: true },
          exceptionDetails: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              exception: {
                type: 'object',
                additionalProperties: false,
                properties: { description: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: formatEvaluate(value) },
      ],
    },
    timeoutMs,
    async execute(args, exec) {
      if (args.expression.trim().length === 0) throw new Error('expression must be a non-empty string')
      const result = await chrome.evaluate(args.expression, {
        awaitPromise: args.awaitPromise ?? true,
        returnByValue: true,
        signal: exec.signal,
      })
      return {
        result: (result.result ?? null) as JsonValue,
        ...result.exceptionDetails !== undefined ? { exceptionDetails: result.exceptionDetails } : {},
      }
    },
    presentCall(args): GenericCallView {
      const expr = args.expression.length > 80 ? `${args.expression.slice(0, 77)}...` : args.expression
      return { card: 'generic', title: `Evaluate JS`, kind: 'execute', rawInput: expr }
    },
  }))
}

/** Model-facing text for one evaluation outcome. */
export function formatEvaluate(value: ChromeEvaluateValue): string {
  if (value.exceptionDetails !== undefined) {
    const desc = value.exceptionDetails.exception?.description
    return `<result type="exception">\n${value.exceptionDetails.text}${desc !== undefined ? `\n${desc}` : ''}\n</result>`
  }
  // `returnByValue` yields undefined for values JSON cannot carry (DOM nodes,
  // functions); teach the model the JSON.stringify idiom instead of letting
  // it conclude the page returned "null".
  if (value.result === undefined) {
    return '<result>\nnull\n</result>\n<hint>the expression returned undefined — DOM nodes, functions, and other non-JSON values serialize to undefined; wrap them inside the expression, e.g. `JSON.stringify(el.outerHTML)` or return plain data</hint>'
  }
  return `<result>\n${JSON.stringify(value.result, null, 2)}\n</result>`
}
