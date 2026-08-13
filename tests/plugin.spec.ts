import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, Config, name, inject } from '../src/index.ts'
import { ChromeRuntime } from '../src/service.ts'

const EXPECTED_TOOLS = ['chrome_navigate', 'chrome_evaluate', 'chrome_snapshot', 'chrome_click', 'chrome_screenshot', 'chrome_scroll', 'chrome_type', 'chrome_press_key', 'chrome_close']

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('plugin integration with the DSH registries', () => {
  it('exports the Cordis plugin shape', () => {
    expect(name).toBe('chrome-tool')
    expect(inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof apply).toBe('function')
    expect(typeof Config).toBe('function')
  })

  it('registers all five chrome tools and the ctx.chrome service', async () => {
    const ctx = await setup()
    apply(ctx, Config({}))

    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const tool of EXPECTED_TOOLS) {
      expect(names).toContain(tool)
    }
    expect(ctx.chrome).toBeInstanceOf(ChromeRuntime)
  })

  it('contributes tool + overview guidance to the system-prompt assembly', async () => {
    const ctx = await setup()
    apply(ctx, Config({}))

    const assembly = await ctx.systemPrompt.assemble()
    const toolNames = assembly.tools.map(tool => tool.name).sort()
    expect(toolNames).toEqual([...EXPECTED_TOOLS].sort())

    const sectionNames = assembly.sections.map(section => section.name)
    expect(sectionNames).toContain('chrome:overview')
    for (const tool of EXPECTED_TOOLS) {
      expect(sectionNames).toContain(`tool:${tool}`)
    }
  })

  it('respects per-tool enable flags', async () => {
    const ctx = await setup()
    apply(ctx, Config({ navigate: true, evaluate: false, snapshot: false, click: false, screenshot: false }))

    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('chrome_navigate')
    for (const disabled of ['chrome_evaluate', 'chrome_snapshot', 'chrome_click', 'chrome_screenshot']) {
      expect(names).not.toContain(disabled)
    }
  })

  it('rejects connect mode without a cdpUrl', async () => {
    const ctx = await setup()
    expect(() => apply(ctx, Config({ launch: false }))).toThrow(/cdpUrl/)
  })

  it('unregisters on dispose', async () => {
    const ctx = await setup()
    const fiber = await ctx.plugin({ name: 'chrome-tool', inject, apply: (c) => apply(c, Config({})) })
    expect(ctx.tools.schemas().map(s => s.name)).toContain('chrome_navigate')
    await fiber.dispose()
    const names = ctx.tools.schemas().map(s => s.name)
    for (const tool of EXPECTED_TOOLS) {
      expect(names).not.toContain(tool)
    }
  })
})
