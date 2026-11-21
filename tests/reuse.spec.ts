import { describe, expect, it } from 'vitest'
import { createServer, type AddressInfo, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer, type WebSocket } from 'ws'
import { probeExistingEndpoint } from '../src/launcher.ts'
import { ChromeRuntime, type ChromeRuntimeConfig } from '../src/service.ts'
import { ChromeError } from '../src/types.ts'

/** Reserve one ephemeral TCP port and release it immediately. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
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

/**
 * A fake Chrome debugger endpoint on one port: `/json/version` over HTTP and
 * a minimal browser-level CDP peer over the WebSocket upgrade. Enough of the
 * protocol for the runtime's attach handshake (create target, attach session,
 * enable domains) and nothing more.
 */
class FakeDebugger {
  readonly server: Server
  private readonly wss = new WebSocketServer({ noServer: true })
  private counter = 0
  endpoint = ''
  private wsUrl = ''

  constructor(private readonly browser = 'FakeChrome/999.0') {
    this.server = createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ Browser: this.browser, webSocketDebuggerUrl: this.wsUrl }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    this.server.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, ws => {
        this.wss.emit('connection', ws, req)
        this.serve(ws)
      })
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const port = (this.server.address() as AddressInfo).port
    this.endpoint = `http://127.0.0.1:${port}`
    this.wsUrl = `ws://127.0.0.1:${port}/devtools/browser/fake-${Date.now()}`
  }

  /** Answer the handful of CDP methods the attach handshake sends. */
  private serve(ws: WebSocket): void {
    ws.on('message', data => {
      let message: { id?: number; method?: string }
      try {
        message = JSON.parse(String(data)) as { id?: number; method?: string }
      } catch {
        return
      }
      if (message.id === undefined) return
      let result: unknown = {}
      switch (message.method) {
        case 'Target.createTarget': result = { targetId: `T${++this.counter}` }; break
        case 'Target.attachToTarget': result = { sessionId: `S${++this.counter}` }; break
        default: result = {}
      }
      ws.send(JSON.stringify({ id: message.id, result }))
    })
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}

/** Runtime config for launch mode against a specific port. */
function launchConfig(port: number, reuseExisting: boolean): ChromeRuntimeConfig {
  return {
    launch: true,
    reuseExisting,
    port,
    host: '127.0.0.1',
    headless: 'new',
    extraArgs: [],
    operationTimeoutMs: 5_000,
    networkIdleMs: 100,
  }
}

describe('probeExistingEndpoint', () => {
  it('returns version info when a debugger serves the endpoint', async () => {
    const fake = new FakeDebugger('ProbeChrome/1.2.3')
    await fake.listen()
    try {
      const info = await probeExistingEndpoint(fake.endpoint)
      expect(info).toBeDefined()
      expect(info?.Browser).toBe('ProbeChrome/1.2.3')
      expect(info?.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//)
    } finally {
      await fake.close()
    }
  })

  it('returns undefined when the endpoint answers but is not a debugger', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hello: 'world' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      await expect(probeExistingEndpoint(endpoint)).resolves.toBeUndefined()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('returns undefined when nothing is listening', async () => {
    const port = await freePort()
    await expect(probeExistingEndpoint(`http://127.0.0.1:${port}`)).resolves.toBeUndefined()
  })

  it('rejects with CHROME_ABORTED when the signal is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const port = await freePort()
    await expect(probeExistingEndpoint(`http://127.0.0.1:${port}`, controller.signal)).rejects.toMatchObject({ code: 'CHROME_ABORTED' })
  })
})

describe('debugger-port reuse (ensureConnection)', () => {
  it('attaches to the instance already listening on the configured port (auto)', async () => {
    const fake = new FakeDebugger()
    await fake.listen()
    const chrome = new ChromeRuntime(new Context(), launchConfig((fake.server.address() as AddressInfo).port, true))
    try {
      const info = await chrome.ensureConnection('auto')
      expect(info.connected).toBe('attached')
      expect(info.endpoint).toBe(fake.endpoint)
      expect(info.browser).toBe('FakeChrome/999.0')
      expect(info.targetId).toMatch(/^T\d+$/)
      expect(chrome.ownsBrowserProcess).toBe(false)
      // Idempotent: a second call reports the same instance.
      const again = await chrome.ensureConnection('auto')
      expect(again.targetId).toBe(info.targetId)
    } finally {
      await chrome.dispose()
      await fake.close()
    }
  })

  it('mode "launch" closes the current connection first, then fails while a foreign instance serves the port', async () => {
    const fake = new FakeDebugger()
    await fake.listen()
    const chrome = new ChromeRuntime(new Context(), launchConfig((fake.server.address() as AddressInfo).port, true))
    try {
      const attached = await chrome.ensureConnection('auto')
      expect(attached.connected).toBe('attached')
      // "launch" drops the connection (the fake is not ours, so it keeps the
      // port serving) and then refuses instead of spawning over it.
      await expect(chrome.ensureConnection('launch')).rejects.toMatchObject({ code: 'CHROME_LAUNCH_FAILED', message: /already serving/ })
      // The failed launch left the runtime idle; the next call re-attaches.
      const reattached = await chrome.ensureConnection('auto')
      expect(reattached.connected).toBe('attached')
      expect(reattached.endpoint).toBe(attached.endpoint)
    } finally {
      await chrome.dispose()
      await fake.close()
    }
  })

  it('refuses mode "launch" when the port is already served, without spawning a doomed Chrome', async () => {
    const fake = new FakeDebugger()
    await fake.listen()
    const port = (fake.server.address() as AddressInfo).port
    // No connection yet: the preflight probe must catch the occupied port.
    const chrome = new ChromeRuntime(new Context(), launchConfig(port, false))
    try {
      const error = await chrome.ensureConnection('launch').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ChromeError)
      expect((error as ChromeError).code).toBe('CHROME_LAUNCH_FAILED')
      expect((error as ChromeError).message).toMatch(/already serving/)
    } finally {
      await chrome.dispose()
      await fake.close()
    }
  })

  it('refuses mode "reuse" when nothing is listening', async () => {
    const port = await freePort()
    const chrome = new ChromeRuntime(new Context(), launchConfig(port, true))
    try {
      const error = await chrome.ensureConnection('reuse').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ChromeError)
      expect((error as ChromeError).code).toBe('CHROME_ENDPOINT_UNREACHABLE')
      expect((error as ChromeError).message).toMatch(/no Chrome debugger is listening/)
    } finally {
      await chrome.dispose()
    }
  })

  it('detach on close leaves the reused instance alive and re-attaches later', async () => {
    const fake = new FakeDebugger()
    await fake.listen()
    const port = (fake.server.address() as AddressInfo).port
    const chrome = new ChromeRuntime(new Context(), launchConfig(port, true))
    try {
      const first = await chrome.ensureConnection('auto')
      await chrome.closeBrowser()
      expect(chrome.ownsBrowserProcess).toBe(false)
      const second = await chrome.ensureConnection('reuse')
      expect(second.connected).toBe('attached')
      expect(second.endpoint).toBe(first.endpoint)
    } finally {
      await chrome.dispose()
      await fake.close()
    }
  })

  it('attach mode with launch:false attaches via cdpUrl and refuses explicit launch', async () => {
    const fake = new FakeDebugger()
    await fake.listen()
    const config: ChromeRuntimeConfig = {
      launch: false,
      reuseExisting: true,
      cdpUrl: fake.endpoint,
      port: 1,
      host: '127.0.0.1',
      headless: 'new',
      extraArgs: [],
      operationTimeoutMs: 5_000,
      networkIdleMs: 100,
    }
    const chrome = new ChromeRuntime(new Context(), config)
    try {
      const info = await chrome.ensureConnection('auto')
      expect(info.connected).toBe('attached')
      expect(info.endpoint).toBe(fake.endpoint)
    } finally {
      await chrome.dispose()
    }
    // A fresh runtime in attach mode (nothing open yet) refuses to launch.
    const fresh = new ChromeRuntime(new Context(), config)
    try {
      await expect(fresh.ensureConnection('launch')).rejects.toThrow(/managed launch is disabled/)
    } finally {
      await fresh.dispose()
      await fake.close()
    }
  })
})
