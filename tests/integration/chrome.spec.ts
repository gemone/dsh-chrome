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
      <form><label for="name">Name</label><input id="name" type="text" value="">
      <button id="btn" onclick="this.dataset.clicked='1'">go</button>
      <button id="buried" onclick="this.dataset.clicked='1'">buried</button></form>
      <div id="markdown-body">
        <h2>Docs</h2>
        <p>See the <a href="/docs/guide">guide</a> and <strong>notes</strong>.</p>
        <ul><li>one</li><li>two<ul><li>two.a</li></ul></li></ul>
        <pre><code>const x = 1;</code></pre>
        <table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
      </div>
      </body></html>`
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise<void>(resolve => server.listen(serverPort, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${serverPort}`

    const ctx = new Context()
    chrome = new ChromeRuntime(ctx, {
      launch: true,
      reuseExisting: true,
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
    expect(result.readyState).toBe('complete')
    expect(result.text).toContain('Hello CDP')
    expect(result.text).toContain('present')
    expect(result.truncated).toBe(false)
  })

  it('bounds snapshot text', async () => {
    const result = await chrome.snapshot(3)
    expect(result.truncated).toBe(true)
  })

  it('converts the page to markdown', async () => {
    const result = await chrome.markdown(20_000)
    expect(result.title).toBe('Dsh Chrome Test')
    expect(result.readyState).toBe('complete')
    expect(result.truncated).toBe(false)
    expect(result.text).toContain('# Hello CDP')
    expect(result.text).toContain('## Docs')
    expect(result.text).toContain(`[guide](${baseUrl}/docs/guide)`)
    expect(result.text).toContain('**notes**')
    expect(result.text).toContain('- one')
    expect(result.text).toContain('  - two.a')
    expect(result.text).toContain('```')
    expect(result.text).toContain('const x = 1;')
    expect(result.text).toContain('| a | b |')
    expect(result.text).toContain('| --- | --- |')
    expect(result.text).toContain('| 1 | 2 |')
  })

  it('bounds the markdown conversion', async () => {
    const result = await chrome.markdown(150)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(150)
  })

  it('clicks an element by selector', async () => {
    const before = await chrome.evaluate("document.getElementById('btn').dataset.clicked || null")
    expect(before.result).toBeNull()
    const result = await chrome.click('#btn', 'left')
    expect(result.clicked).toBe(true)
    expect(result.coveredBy).toBeUndefined()
    const after = await chrome.evaluate("document.getElementById('btn').dataset.clicked")
    expect(after.result).toBe('1')
  })

  it('reports the overlay covering a click point', async () => {
    await chrome.evaluate(`(() => { const d = document.createElement('div'); d.id = 'overlay'; d.textContent = 'banner'; d.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:99'; document.body.appendChild(d); return 'ok'; })()`, { awaitPromise: false, returnByValue: true })
    try {
      const result = await chrome.click('#buried', 'left')
      expect(result.clicked).toBe(true)
      expect(result.coveredBy).toMatch(/overlay/)
      // A click covered by the fixed overlay did not reach the button.
      const state = await chrome.evaluate("document.getElementById('buried').dataset.clicked || null")
      expect(state.result).toBeNull()
    } finally {
      await chrome.evaluate("document.getElementById('overlay').remove()", { awaitPromise: false, returnByValue: true })
    }
  })

  it('captures a structured page snapshot with actionable refs', async () => {
    const result = await chrome.pageSnapshot(200)
    expect(result.title).toBe('Dsh Chrome Test')
    expect(result.tree).toContain('heading')
    expect(result.tree).toContain('[ref=e')
    expect(result.tree).toContain('button')
    expect(result.tree).toContain('textbox')
    expect(result.truncated).toBe(false)
    expect(result.refCount).toBeGreaterThan(0)
    // The refs resolve to selectors that actually find elements.
    const anyRef = result.tree.match(/\[ref=(e\d+)\]/)?.[1]
    expect(anyRef).toBeDefined()
    expect(chrome.resolvePageRef(anyRef!)).toBeDefined()
    const found = await chrome.evaluate(`document.querySelector(${JSON.stringify(chrome.resolvePageRef(anyRef!))}) !== null`)
    expect(found.result).toBe(true)
  })

  it('invalidates refs on navigation', async () => {
    const before = await chrome.pageSnapshot(100)
    const ref = before.tree.match(/\[ref=(e\d+)\]/)?.[1]
    expect(ref).toBeDefined()
    expect(chrome.resolvePageRef(ref!)).toBeDefined()
    await chrome.navigate(`${baseUrl}/`, 'domcontentloaded')
    expect(chrome.resolvePageRef(ref!)).toBeUndefined()
  })

  it('captures a PNG screenshot', async () => {
    const captured = await chrome.screenshot({ format: 'png' })
    expect(captured.mediaType).toBe('image/png')
    expect(captured.data.byteLength).toBeGreaterThan(100)
  })

  it('scales a too-tall full-page capture into the admission budget', async () => {
    // A 1280×20000 page exceeds the 8192px per-side admission cap; the
    // capture must clamp (scale < 1) instead of being refused later.
    const tall = '<html><head><style>body{margin:0} .b{height:20000px;background:linear-gradient(#488,#844)}</style></head><body><div class="b"></div></body></html>'
    await chrome.evaluate(`document.open(); document.write(${JSON.stringify(tall)}); document.close(); 'ok'`, { awaitPromise: false, returnByValue: true })
    try {
      const captured = await chrome.screenshot({ format: 'png', limits: { maxDimension: 8192, maxPixels: 64_000_000 } })
      expect(captured.scale).toBeDefined()
      expect(captured.scale!).toBeLessThan(1)
      expect(captured.sourceHeight!).toBeGreaterThanOrEqual(20000)
      // Decode the PNG IHDR to verify the scaled raster fits the cap.
      const ihdr = new DataView(captured.data.buffer, captured.data.byteOffset + 16, 8)
      const width = ihdr.getUint32(0)
      const height = ihdr.getUint32(4)
      expect(Math.max(width, height)).toBeLessThanOrEqual(8192)
      expect(Math.max(width, height)).toBeGreaterThan(4000)
      expect(captured.data.byteLength).toBeGreaterThan(100)
    } finally {
      await chrome.navigate(`${baseUrl}/`, 'domcontentloaded')
    }
  })

  it('leaves an in-budget page unclamped', async () => {
    const captured = await chrome.screenshot({ format: 'png', limits: { maxDimension: 8192, maxPixels: 64_000_000 } })
    expect(captured.scale).toBeUndefined()
    expect(captured.sourceHeight).toBeLessThan(8192)
  })

  it('runs a raw CDP passthrough on the page session', async () => {
    const res = await chrome.cdp({ method: 'Runtime.evaluate', params: { expression: '40 + 2', returnByValue: true } }) as { result?: { value?: number } }
    expect(res.result?.value).toBe(42)
  })
})

describe.skipIf(!runnable)('debugger-port reuse against a real Chrome', { timeout: 90_000 }, () => {
  /** Runtime config for launch mode against a specific port. */
  function config(port: number): Parameters<typeof ChromeRuntime>[1] {
    return {
      launch: true,
      reuseExisting: true,
      port,
      host: '127.0.0.1',
      headless: 'new',
      extraArgs: [],
      operationTimeoutMs: 30_000,
      networkIdleMs: 300,
    }
  }

  it('launches on a free port, replaces its own instance, then other runtimes reuse the port', async () => {
    const debugPort = await freePort()
    const a = new ChromeRuntime(new Context(), config(debugPort))
    try {
      // Nothing is listening yet: "auto" falls through to a managed launch.
      const first = await a.ensureConnection('auto')
      expect(first.connected).toBe('launched')
      expect(first.endpoint).toBe(`http://127.0.0.1:${debugPort}`)
      expect(first.browser).toContain('Chrome')
      expect(a.ownsBrowserProcess).toBe(true)

      // "launch" replaces a connection the runtime owns: the old Chrome is
      // killed (freeing the port) and a fresh one starts in its place.
      const replaced = await a.ensureConnection('launch')
      expect(replaced.connected).toBe('launched')
      expect(replaced.endpoint).toBe(first.endpoint)
      expect(replaced.targetId).not.toBe(first.targetId)
      expect(a.ownsBrowserProcess).toBe(true)

      // A second runtime on the same port must not spawn over the occupied port…
      const b = new ChromeRuntime(new Context(), config(debugPort))
      try {
        await expect(b.ensureConnection('launch')).rejects.toMatchObject({ code: 'CHROME_LAUNCH_FAILED', message: /already serving/ })
        // …and "reuse" attaches instead.
        const second = await b.ensureConnection('reuse')
        expect(second.connected).toBe('attached')
        expect(second.endpoint).toBe(first.endpoint)
        expect(b.ownsBrowserProcess).toBe(false)
      } finally {
        // Detaching must not kill the browser A launched.
        await b.dispose()
      }

      // The reused instance is still serving after B detached.
      const c = new ChromeRuntime(new Context(), config(debugPort))
      try {
        const third = await c.ensureConnection('auto')
        expect(third.connected).toBe('attached')
        expect(third.targetId).not.toBe(replaced.targetId)
      } finally {
        await c.dispose()
      }
    } finally {
      // Disposing the owner terminates the Chrome child.
      await a.dispose()
    }
    // After the owner is gone, the port is free again: reuse finds nothing.
    const d = new ChromeRuntime(new Context(), config(debugPort))
    try {
      await expect(d.ensureConnection('reuse')).rejects.toMatchObject({ code: 'CHROME_ENDPOINT_UNREACHABLE' })
    } finally {
      await d.dispose()
    }
  })
})
