/**
 * The model-facing `chrome_connect` tool: let the agent choose how the
 * chrome_* family obtains its browser — reuse the instance already listening
 * on the debugger port, or force a fresh managed launch. Connection is
 * otherwise implicit on first tool call; this tool makes the choice explicit
 * and reports which instance is in use.
 * @module dsh-chrome/tools/connect
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeConnectMode, ChromeConnectionInfo, ChromeRuntime } from '../service.ts'

/** Canonical `chrome_connect` outcome: the connection snapshot `ensureConnection` reports. */
export type ChromeConnectValue = ChromeConnectionInfo

/** Register `chrome_connect` and its prompt guidance. */
export function applyChromeConnectTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_connect',
    order: 120,
    text: 'Use the chrome_connect tool to control how the chrome_* tools obtain their Chrome instance. mode "auto" (default) reuses an instance already listening on the debugger port and launches a fresh managed Chrome only when none is; mode "reuse" attaches only to an existing instance (fails when none is listening); mode "launch" forces a fresh managed instance, closing the current connection first (a managed Chrome is killed; a reused instance stays running) and failing when the port is still served by an instance the plugin does not own. Other chrome_* calls connect implicitly with "auto" behavior.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_connect',
    description: 'Ensure the chrome_* tools are connected to a Chrome instance and report which one. "auto" (default) reuses an existing instance already listening on the debugger port, launching a fresh managed Chrome only when none is; "reuse" attaches only to an existing instance (fails when none is listening); "launch" forces a fresh managed instance, replacing the current connection (fails when the port is still served by an instance the plugin does not own).',
    parameters: {
      mode: {
        type: 'string',
        description: 'Connect strategy: "auto" (default) reuses the instance on the debugger port when present, "reuse" attaches to an existing instance only, "launch" replaces the connection with a fresh managed instance.',
        enum: ['auto', 'reuse', 'launch'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'string', required: true, enum: ['attached', 'launched'] },
          endpoint: { type: 'string', required: true },
          browser: { type: 'string', required: true },
          targetId: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        {
          type: 'text',
          text: value.connected === 'attached'
            ? `Attached to the existing Chrome at ${value.endpoint}${versionSuffix(value.browser)} — reusing the running instance (it stays alive when this plugin unloads).`
            : `Launched a fresh managed Chrome at ${value.endpoint}${versionSuffix(value.browser)}.`,
        },
      ],
    },
    timeoutMs,
    async execute(args, exec): Promise<ChromeConnectValue> {
      return await chrome.ensureConnection((args.mode ?? 'auto') as ChromeConnectMode, exec.signal)
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Connect (${args.mode ?? 'auto'})`, kind: 'execute' }
    },
  }))
}

/** ` (Browser x.y)` when the version string is known. */
function versionSuffix(browser: string): string {
  return browser.length > 0 ? ` (${browser})` : ''
}
