import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { ChromeRuntime } from '../../src/service.ts'
import { discoverExecutable } from '../../src/launcher.ts'

const ENABLED = process.env.DSH_CHROME_INTEGRATION === '1'
const hasChrome = discoverExecutable() !== undefined
const runnable = ENABLED && hasChrome

/** Reserve one ephemeral TCP port and release it immediately. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

describe.skipIf(!runnable)('ChromeRuntime against a real Chrome', { timeout: 60_000 }, () => {
  let chrome: ChromeRuntime
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    const [serverPort, debugPort] = await Promise.all([freePort(), freePort()])
    const html = `<!doctype html><html><head><title>Dsh Chrome Test</title></head>
      <body><h1>Hello CDP</h1><p id="marker">present</p>
      <button id="btn" onclick="this.dataset.clicked='1'">go</button></body></html>`
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise<void>(resolve => server.listen(serverPort, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${serverPort}`

    const ctx = new Context()
    chrome = new ChromeRuntime(ctx, {
      launch: true,
      port: debugPort,
      host: '127.0.0.1',
      headless: 'new',
      extraArgs: [],
      operationTimeoutMs: 30_000,
      networkIdleMs: 300,
    })
  })

  afterAll(async () => {
    try {
      await chrome?.dispose()
    } catch {
      // ignore
    }
    await new Promise<void>(resolve => server?.close(() => resolve()))
  })

  it('navigates to the fixture and reads title + final URL', async () => {
    const result = await chrome.navigate(`${baseUrl}/`, 'domcontentloaded')
    expect(result.title).toBe('Dsh Chrome Test')
    expect(result.finalUrl).toContain(`${baseUrl}/`)
  })

  it('evaluates JavaScript and returns the value', async () => {
    const result = await chrome.evaluate('1 + 2 + 3')
    expect(result.result).toBe(6)
    expect(result.exceptionDetails).toBeUndefined()
  })

  it('reports an exception without throwing', async () => {
    const result = await chrome.evaluate('(function () { throw new Error("boom") })()')
    expect(result.exceptionDetails).toBeDefined()
  })

  it('reads the rendered page text', async () => {
    const result = await chrome.snapshot(10_000)
    expect(result.title).toBe('Dsh Chrome Test')
    expect(result.text).toContain('Hello CDP')
    expect(result.text).toContain('present')
    expect(result.truncated).toBe(false)
  })

  it('bounds snapshot text', async () => {
    const result = await chrome.snapshot(3)
    expect(result.truncated).toBe(true)
  })

  it('clicks an element by selector', async () => {
    const before = await chrome.evaluate("document.getElementById('btn').dataset.clicked || null")
    expect(before.result).toBeNull()
    const result = await chrome.click('#btn', 'left')
    expect(result.clicked).toBe(true)
    const after = await chrome.evaluate("document.getElementById('btn').dataset.clicked")
    expect(after.result).toBe('1')
  })

  it('captures a PNG screenshot', async () => {
    const captured = await chrome.screenshot({ format: 'png' })
    expect(captured.mediaType).toBe('image/png')
    expect(captured.data.byteLength).toBeGreaterThan(100)
  })

  it('runs a raw CDP passthrough on the page session', async () => {
    const res = await chrome.cdp({ method: 'Runtime.evaluate', params: { expression: '40 + 2', returnByValue: true } }) as { result?: { value?: number } }
    expect(res.result?.value).toBe(42)
  })
})
