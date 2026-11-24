import { describe, expect, it } from 'vitest'
import { createServer, type AddressInfo } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { apply, Config, name, inject } from '../src/index.ts'
import * as reading from '../src/reading.ts'
import * as interact from '../src/interact.ts'
import * as capture from '../src/capture.ts'
import * as observatoryFamily from '../src/observatory.family.ts'
import * as session from '../src/session.ts'
import { ChromeRuntime } from '../src/service.ts'

const CORE_TOOLS = ['chrome_connect', 'chrome_close']
const FAMILY_TOOLS = [
  'chrome_navigate', 'chrome_evaluate', 'chrome_snapshot', 'chrome_page_snapshot',
  'chrome_click', 'chrome_type', 'chrome_scroll', 'chrome_press_key',
  'chrome_screenshot', 'chrome_pdf', 'chrome_mhtml',
  'chrome_net_list', 'chrome_net_body', 'chrome_console_read',
  'chrome_tab', 'chrome_storage', 'chrome_upload', 'chrome_emulate', 'chrome_net_mock',
]
const ALL_TOOLS = [...CORE_TOOLS, ...FAMILY_TOOLS]

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // DSH ≥0.2.1 mounts tool execution as an explicit executor plugin; prompt
  // assembly resolves tools through it.
  await ctx.plugin(NativeExecutor)
  return ctx
}

/** Apply the core row and every family row onto one context. */
function applyAll(ctx: Context): void {
  apply(ctx, Config({}))
  for (const family of [reading, interact, capture, observatoryFamily, session]) {
    family.apply(ctx)
  }
}

function registeredTools(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name)
}

describe('plugin integration with the DSH registries', () => {
  it('exports the Cordis plugin shape', () => {
    expect(name).toBe('chrome-tool')
    expect(inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof apply).toBe('function')
    expect(typeof Config).toBe('function')
  })

  it('registers the lifecycle tools and the ctx.chrome service', async () => {
    const ctx = await setup()
    apply(ctx, Config({}))

    const names = registeredTools(ctx)
    for (const tool of CORE_TOOLS) {
      expect(names).toContain(tool)
    }
    for (const tool of FAMILY_TOOLS) {
      expect(names).not.toContain(tool)
    }
    expect(ctx.chrome).toBeInstanceOf(ChromeRuntime)
  })

  it('every family row registers exactly its own tools over the injected service', async () => {
    const ctx = await setup()
    apply(ctx, Config({}))
    reading.apply(ctx)
    expect(registeredTools(ctx)).toEqual(expect.arrayContaining(['chrome_navigate', 'chrome_evaluate', 'chrome_snapshot', 'chrome_page_snapshot']))
    expect(registeredTools(ctx)).not.toContain('chrome_click')

    interact.apply(ctx)
    expect(registeredTools(ctx)).toEqual(expect.arrayContaining(['chrome_click', 'chrome_type', 'chrome_scroll', 'chrome_press_key']))

    capture.apply(ctx)
    observatoryFamily.apply(ctx)
    session.apply(ctx)
    const names = registeredTools(ctx)
    for (const tool of ALL_TOOLS) {
      expect(names).toContain(tool)
    }
    expect(names).toHaveLength(ALL_TOOLS.length)
  })

  it('contributes tool + overview guidance to the system-prompt assembly', async () => {
    const ctx = await setup()
    applyAll(ctx)
    const assembly = await ctx.systemPrompt.assemble()
    const toolNames = assembly.tools.map(tool => tool.name).sort()
    expect(toolNames).toEqual([...ALL_TOOLS].sort())

    const sectionNames = assembly.sections.map(section => section.name)
    expect(sectionNames).toContain('chrome:overview')
    for (const tool of ALL_TOOLS) {
      // chrome_net_body shares the chrome_net_list prompt section.
      const section = tool === 'chrome_net_body' ? 'chrome_net_list' : tool
      expect(sectionNames).toContain(`tool:${section}`)
    }
  })

  it('rejects connect mode without a cdpUrl', async () => {
    const ctx = await setup()
    expect(() => apply(ctx, Config({ launch: false }))).toThrow(/cdpUrl/)
  })

  it('defaults to reusing an existing debugger-port instance and registers chrome_connect', async () => {
    expect(Config({}).reuseExisting.get()).toBe(true)
    const ctx = await setup()
    apply(ctx, Config({}))
    expect(registeredTools(ctx)).toContain('chrome_connect')
  })

  it('rejects a partially configured screenshotAnalysis section', async () => {
    const ctx = await setup()
    expect(() => apply(ctx, Config({ screenshotAnalysis: { provider: 'openai' } }))).toThrow(/screenshotAnalysis.*provider.*model/)
  })

  it('accepts a fully configured screenshotAnalysis section', async () => {
    const ctx = await setup()
    expect(() => apply(ctx, Config({ screenshotAnalysis: { provider: 'openai', model: 'gpt-4o-mini' } }))).not.toThrow()
  })

  it('unregisters on dispose', async () => {
    const ctx = await setup()
    const fiber = await ctx.plugin({ name: 'chrome-tool', inject, apply: (c) => apply(c, Config({})) })
    expect(registeredTools(ctx)).toContain('chrome_connect')
    await fiber.dispose()
    const names = registeredTools(ctx)
    for (const tool of ALL_TOOLS) {
      expect(names).not.toContain(tool)
    }
  })

  it('the port-occupied flow follows the configured policy without asking', async () => {
    const ctx = await setup()
    // A bare HTTP port: the launch preflight reports it occupied.
    const server = createServer((_req, res) => { res.writeHead(404).end() })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    // No user-questions service is mounted at all: the policy decides, and
    // the default ("reuse") attaches — against a non-Chrome port the attach
    // handshake fails, which is the expected refusal surface here.
    apply(ctx, Config({ port, occupiedPortPolicy: 'reuse' }))
    const connect = ctx.tools.get('chrome_connect')
    if (connect === undefined) throw new Error('chrome_connect not registered')
    const error = await connect.execute({ mode: 'launch' }, {
      agent: { id: 'session-x' },
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    server.close()
  })
})

describe('navigate error paths do not leak unhandled rejections', () => {
  /** A connection stub whose Page.navigate send always fails. */
  function failingConnection(): Record<string, unknown> {
    return {
      client: {
        send: (method: string) => {
          if (method === 'Page.navigate') throw new Error('CDP socket is closed')
          return Promise.resolve({})
        },
        on: () => () => undefined,
      },
      sessionId: 's',
      network: { inflight: new Set() },
      observatory: { netSince: () => ({ entries: [], total: 0, dropped: 0, truncated: false }) },
      readCursors: { net: 0, console: 0 },
      pageRefs: new Map(),
    }
  }

  it('cancel-on-send-failure stays handled (regression: fatal unhandled rejection)', async () => {
    const ctx = await setup()
    apply(ctx, Config({}))
    const chrome = ctx.chrome
    ;(chrome as unknown as { ensure: () => Promise<unknown> }).ensure = () => Promise.resolve(failingConnection())

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(chrome.navigate('https://example.com/', 'load')).rejects.toThrow('CDP socket is closed')
      // Let microtasks (and any leaked rejection) settle.
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
