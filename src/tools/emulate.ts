/**
 * The model-facing `chrome_emulate` tool: one parameterized tool over the
 * service's {@link ChromeRuntime.emulate} — viewport, network/CPU throttling,
 * geolocation, timezone, locale, user-agent, and a one-shot reset.
 * @module dsh-chrome/tools/emulate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ChromeRuntime } from '../service.ts'

/** Canonical `chrome_emulate` outcome. */
export interface ChromeEmulateValue {
  applied: string[]
  text: string
}

/** Register `chrome_emulate` with its prompt guidance. */
export function applyChromeEmulateTool(ctx: Context, chrome: ChromeRuntime, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:chrome_emulate',
    order: 115,
    text: 'Use the chrome_emulate tool to control the controlled Chrome page\'s environment: viewport size/DPR/mobile, network throttling (offline/slow3G/fast3G/none), CPU throttling, geolocation, timezone, locale, and user-agent. clear: true resets everything first. Omitted fields are left unchanged.',
  })

  ctx.tools.register(defineTool({
    name: 'chrome_emulate',
    description: 'Overriding the controlled Chrome page\'s environment: viewport (width/height/deviceScaleFactor/mobile), network throttling (network: offline/slow3G/fast3G/none), CPU throttling (cpuThrottlingRate), geolocation (latitude/longitude/accuracy), timezoneId, locale, userAgent, permissions (grant browser permissions), colorScheme/reducedMotion (emulated media features). clear: true resets all overrides first; omitted fields stay unchanged.',
    parameters: {
      clear: { type: 'boolean', description: 'Reset all overrides to defaults before applying the other fields (default false).' },
      width: { type: 'integer', description: 'Viewport width in CSS px (0 = responsive).' },
      height: { type: 'integer', description: 'Viewport height in CSS px (0 = responsive).' },
      deviceScaleFactor: { type: 'number', description: 'Device pixel ratio (default 1).' },
      mobile: { type: 'boolean', description: 'Whether to emulate a mobile device.' },
      network: {
        type: 'string',
        description: 'Network throttling preset: "offline", "slow3G", "fast3G", or "none" (clears throttling).',
        enum: ['none', 'offline', 'slow3G', 'fast3G'],
      },
      cpuThrottlingRate: { type: 'number', description: 'CPU throttling multiplier (1 = none, 4 = 4x slowdown).' },
      latitude: { type: 'number', description: 'Geolocation latitude.' },
      longitude: { type: 'number', description: 'Geolocation longitude.' },
      accuracy: { type: 'number', description: 'Geolocation accuracy in meters (default 100).' },
      timezoneId: { type: 'string', description: 'IANA timezone (e.g. "America/New_York"); empty string resets to system.' },
      locale: { type: 'string', description: 'Accept-Language locale (e.g. "zh-CN").' },
      userAgent: { type: 'string', description: 'User-Agent to send; empty string resets.' },
      permissions: {
        type: 'array',
        description: 'Browser permissions to grant (e.g. "geolocation", "notifications", "clipboard-read", "clipboard-write", "camera", "microphone").',
        items: { type: 'string' },
      },
      resetPermissions: { type: 'boolean', description: 'Reset all granted permissions first.' },
      colorScheme: {
        type: 'string',
        description: 'Emulated prefers-color-scheme ("dark" or "light").',
        enum: ['dark', 'light'],
      },
      reducedMotion: {
        type: 'string',
        description: 'Emulated prefers-reduced-motion.',
        enum: ['reduce', 'no-preference'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'array', items: { type: 'string' }, required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: value.text }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const result = await chrome.emulate({
        ...args.clear === true ? { clear: true } : {},
        ...args.width !== undefined ? { width: args.width } : {},
        ...args.height !== undefined ? { height: args.height } : {},
        ...args.deviceScaleFactor !== undefined ? { deviceScaleFactor: args.deviceScaleFactor } : {},
        ...args.mobile !== undefined ? { mobile: args.mobile } : {},
        ...args.network !== undefined ? { network: args.network } : {},
        ...args.cpuThrottlingRate !== undefined ? { cpuThrottlingRate: args.cpuThrottlingRate } : {},
        ...args.latitude !== undefined ? { latitude: args.latitude } : {},
        ...args.longitude !== undefined ? { longitude: args.longitude } : {},
        ...args.accuracy !== undefined ? { accuracy: args.accuracy } : {},
        ...args.timezoneId !== undefined ? { timezoneId: args.timezoneId } : {},
        ...args.locale !== undefined ? { locale: args.locale } : {},
        ...args.userAgent !== undefined ? { userAgent: args.userAgent } : {},
        ...args.permissions !== undefined && args.permissions.length > 0 ? { permissions: args.permissions } : {},
        ...args.resetPermissions === true ? { resetPermissions: true } : {},
        ...args.colorScheme !== undefined ? { colorScheme: args.colorScheme } : {},
        ...args.reducedMotion !== undefined ? { reducedMotion: args.reducedMotion } : {},
        signal: exec.signal,
      })
      const text = result.applied.length === 0
        ? 'Nothing to apply — pass at least one override field, or clear: true to reset.'
        : `Applied ${result.applied.length} override(s):\n${result.applied.map(a => `  ${a}`).join('\n')}`
      return { applied: [...result.applied], text }
    },
    presentCall(args): GenericCallView {
      const parts = Object.entries(args).filter(([k]) => k !== 'clear').map(([k]) => k)
      return { card: 'generic', title: `Emulate${args.clear === true ? ' (reset +)' : ''}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`, kind: 'edit' }
    },
  }))
}
