import { describe, expect, it } from 'vitest'
import { createServer, type AddressInfo, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer, type WebSocket } from 'ws'
import { findFreePort, hostForUrl, normalizeDebugEndpoint, probeExistingEndpoint, waitForEndpoint } from '../src/launcher.ts'
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
 *
 * `httpDiscovery: false` models Chrome ≥154, which removed the DevTools HTTP
 * discovery layer: every `/json/*` path answers a bare 404 while the
 * browser-level WebSocket endpoint still speaks CDP.
 *
 * `holdUpgradesMs` delays each WebSocket upgrade, modeling a Chrome that
 * authorizes debugging connections and waits for the user to approve; every
 * accepted upgrade increments {@link connections}, so tests can prove how
 * many connections (approval prompts) a flow spends.
 */
class FakeDebugger {
  readonly server: Server
  /** Params of the last Target.createTarget call, for assertion. */
  lastCreateTargetParams: Record<string, unknown> | undefined
  private readonly wss = new WebSocketServer({ noServer: true })
  private counter = 0
  endpoint = ''
  private wsUrl = ''
  /** How many WebSocket upgrades this endpoint has accepted. */
  connections = 0

  constructor(
    private readonly browser = 'FakeChrome/999.0',
    private readonly httpDiscovery = true,
    private readonly holdUpgradesMs = 0,
  ) {
    this.server = createServer((req, res) => {
      if (httpDiscovery && req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ Browser: this.browser, webSocketDebuggerUrl: this.wsUrl }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    this.server.on('upgrade', (req, socket, head) => {
      this.connections++
      this.rawSockets.add(socket)
      socket.once('close', () => this.rawSockets.delete(socket))
      setTimeout(() => {
        // The requester may have given up mid-hold; upgrading a destroyed socket would keep close() waiting.
        if (socket.destroyed) return
        this.wss.handleUpgrade(req, socket, head, ws => {
          this.wss.emit('connection', ws, req)
          this.serve(ws)
        })
      }, this.holdUpgradesMs)
    })
  }

  private readonly rawSockets = new Set<import('node:net').Socket>()

  async listen(port = 0): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(port, '127.0.0.1', resolve))
    const bound = (this.server.address() as AddressInfo).port
    this.endpoint = `http://127.0.0.1:${bound}`
    this.wsUrl = `ws://127.0.0.1:${bound}/devtools/browser/fake-${Date.now()}`
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
        case 'Browser.getVersion': result = { protocolVersion: '1.3', product: this.browser }; break
        case 'Target.createTarget':
          this.lastCreateTargetParams = (message as { params?: Record<string, unknown> }).params
          result = { targetId: `T${++this.counter}` }; break
        case 'Target.attachToTarget': result = { sessionId: `S${++this.counter}` }; break
        // The stale-session recovery probes answer with the killed session's
        // id when the fake has retired a session.
        case 'Runtime.evaluate':
        case 'Page.navigate':
          if (this.deadSessions.has(String((message as { sessionId?: string }).sessionId))) {
            ws.send(JSON.stringify({ id: message.id, error: { code: -32001, message: 'Session with given id not found.' } }))
            return
          }
          result = {}; break
        case 'Target.getTargetInfo': {
          const targetId = (message as { params?: { targetId?: string } }).params?.targetId
          result = { targetInfo: { targetId } }
          break
        }
        default: result = {}
      }
      ws.send(JSON.stringify({ id: message.id, result }))
    })
  }

  /** Session ids the fake treats as dead (external target/session loss). */
  readonly deadSessions = new Set<string>()

  async close(): Promise<void> {
    // Half-open upgrade sockets (client aborted mid-hold) would block close().
    for (const socket of this.rawSockets) socket.destroy()
    this.rawSockets.clear()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}

/** Runtime config for launch mode against a specific port (live fields as accessors). */
function launchConfig(port: number, reuseExisting: boolean): ChromeRuntimeConfig {
  return {
    launch: true,
    reuseExisting: () => reuseExisting,
    port,
    host: '127.0.0.1',
    headless: 'new',
    extraArgs: [],
    operationTimeoutMs: () => 5_000,
    networkIdleMs: () => 100,
    observatoryMaxEntries: () => 500,
    dialogPolicy: () => 'accept',
    dialogPromptText: () => undefined,
    downloadDir: () => undefined,
    occupiedPortPolicy: () => 'refuse',
  }
}

describe('hostForUrl', () => {
  it('brackets IPv6 literals and passes everything else through', () => {
    expect(hostForUrl('::1')).toBe('[::1]')
    expect(hostForUrl('2001:db8::1')).toBe('[2001:db8::1]')
    expect(hostForUrl('[::1]')).toBe('[::1]')
    expect(hostForUrl('127.0.0.1')).toBe('127.0.0.1')
    expect(hostForUrl('localhost')).toBe('localhost')
    expect(hostForUrl('chrome.example.internal')).toBe('chrome.example.internal')
    expect(hostForUrl(' ::1 ')).toBe('[::1]')
  })

  it('builds a bracketed endpoint for an IPv6 host and a plain one for IPv4', () => {
    expect(normalizeDebugEndpoint(`http://${hostForUrl('::1')}:9222`)).toBe('http://[::1]:9222')
    expect(normalizeDebugEndpoint(`http://${hostForUrl('127.0.0.1')}:9222`)).toBe('http://127.0.0.1:9222')
  })
})

describe('probeExistingEndpoint', () => {
  it('returns a verified probe when a debugger serves the endpoint', async () => {
    const fake = new FakeDebugger('ProbeChrome/1.2.3')
    await fake.listen()
    try {
      const probe = await probeExistingEndpoint(fake.endpoint)
      if (probe === undefined || typeof probe === 'string') throw new Error('expected a verified probe')
      expect(probe.Browser).toBe('ProbeChrome/1.2.3')
      expect(probe.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//)
      // HTTP discovery answered: the probe never dialed the WebSocket.
      expect(probe.client).toBeUndefined()
    } finally {
      await fake.close()
    }
  })

  it('reports the port occupied when the endpoint answers but is not a debugger', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hello: 'world' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      // Occupied, not "nothing listening": spawning over a served port is
      // never the probe's call.
      await expect(probeExistingEndpoint(endpoint)).resolves.toBe('occupied')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('falls back to the WebSocket probe when HTTP discovery answers 404 (Chrome ≥154 shape)', async () => {
    const fake = new FakeDebugger('WsOnlyChrome/154.0.1', false)
    await fake.listen()
    let adopted: { close(): void } | undefined
    try {
      const probe = await probeExistingEndpoint(fake.endpoint)
      if (probe === undefined || typeof probe === 'string') throw new Error('expected a verified probe')
      expect(probe.Browser).toBe('WsOnlyChrome/154.0.1')
      // The fallback returns the endpoint it just verified, not a page URL.
      expect(probe.webSocketDebuggerUrl).toBe(`${fake.endpoint.replace('http', 'ws')}/devtools/browser`)
      // The verified connection rides along for the caller to adopt.
      expect(probe.client).toBeDefined()
      expect(fake.connections).toBe(1)
      // Not adopting here: the caller owns the connection and must close it
      // (the runtime's openClient adopts instead of dialing again).
      adopted = probe.client
    } finally {
      adopted?.close()
      await fake.close()
    }
  })

  it('reports the port occupied when a bare 404 server serves no CDP WebSocket either', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      await expect(probeExistingEndpoint(endpoint)).resolves.toBe('occupied')
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

  it('interactive probe waits out a held upgrade (connection authorization) instead of failing on a budget', async () => {
    const fake = new FakeDebugger('AuthChrome/154.0.1', false, 600)
    await fake.listen()
    const controller = new AbortController()
    let adopted: { close(): void } | undefined
    try {
      // No probe budget: the wait belongs to the caller's signal.
      const probe = await probeExistingEndpoint(fake.endpoint, controller.signal, { interactive: true })
      if (probe === undefined || typeof probe === 'string') throw new Error('expected a verified probe')
      expect(fake.connections).toBe(1)
      adopted = probe.client
    } finally {
      adopted?.close()
      controller.abort()
      await fake.close()
    }
  })

  it('non-interactive probe gives up after its budget and reports the port occupied', async () => {
    const fake = new FakeDebugger('SlowAuthChrome/154.0.1', false, 5_000)
    await fake.listen()
    try {
      expect(await probeExistingEndpoint(fake.endpoint, undefined, { probeTimeoutMs: 200 })).toBe('occupied')
      // One attempt only: a second dial would queue a second approval prompt.
      expect(fake.connections).toBe(1)
    } finally {
      await fake.close()
    }
  })
})

describe('waitForEndpoint', () => {
  it('resolves via the WebSocket fallback when a launched Chrome serves no HTTP discovery', async () => {
    const fake = new FakeDebugger('WsOnlyChrome/154.0.1', false)
    await fake.listen()
    let adopted: { close(): void } | undefined
    try {
      const info = await waitForEndpoint(fake.endpoint, { retries: 10, intervalMs: 50 })
      expect(info.Browser).toBe('WsOnlyChrome/154.0.1')
      expect(info.webSocketDebuggerUrl).toBe(`${fake.endpoint.replace('http', 'ws')}/devtools/browser`)
      // The ready connection rides along; openClient adopts it instead of
      // dialing again (a second dial = a second authorization prompt).
      expect(info.client).toBeDefined()
      adopted = info.client
    } finally {
      adopted?.close()
      await fake.close()
    }
  })

  it('keeps failing when nothing ever answers (launch readiness budget)', async () => {
    const port = await freePort()
    await expect(waitForEndpoint(`http://127.0.0.1:${port}`, { retries: 3, intervalMs: 20 }))
      .rejects.toMatchObject({ code: 'CHROME_ENDPOINT_UNREACHABLE' })
  })
})

describe('findFreePort', () => {
  it('reserves a port that is actually free', async () => {
    const port = await findFreePort('127.0.0.1')
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
    // The reservation was released: a server can bind it again.
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    await new Promise<void>(resolve => server.close(() => resolve()))
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

      // The flattened session dies under us (external target replacement):
      // the next call re-attaches the SAME target over the SAME socket
      // instead of failing every later call with "session not found".
      fake.deadSessions.add('S1')
      const recovered = await chrome.ensureConnection('auto')
      expect(recovered.connected).toBe('attached')
      expect(recovered.endpoint).toBe(fake.endpoint)
      expect(fake.connections).toBe(1)
    } finally {
      await chrome.dispose()
      await fake.close()
    }
  })

  it('attaches to a Chrome ≥154 instance whose HTTP discovery answers 404 (auto)', async () => {
    const fake = new FakeDebugger('WsOnlyChrome/154.0.1', false)
    await fake.listen()
    const chrome = new ChromeRuntime(new Context(), launchConfig((fake.server.address() as AddressInfo).port, true))
    try {
      const info = await chrome.ensureConnection('auto')
      expect(info.connected).toBe('attached')
      expect(info.endpoint).toBe(fake.endpoint)
      expect(info.browser).toBe('WsOnlyChrome/154.0.1')
      expect(info.targetId).toMatch(/^T\d+$/)
      expect(chrome.ownsBrowserProcess).toBe(false)
      // The probe's verified connection was adopted: one dial, one potential
      // authorization prompt — never two.
      expect(fake.connections).toBe(1)
    } finally {
      await chrome.dispose()
      await fake.close()
    }
  })

  it('creates every tab in the background — the user working tab is never hijacked', async () => {
    const fake = new FakeDebugger()
    await fake.listen()
    const chrome = new ChromeRuntime(new Context(), launchConfig((fake.server.address() as AddressInfo).port, true))
    try {
      // Implicit connect creates the default working tab.
      await chrome.ensureConnection('auto')
      expect(fake.lastCreateTargetParams).toMatchObject({ url: 'about:blank', background: true })
      // chrome_tab new must also stay behind the scenes.
      await chrome.openTab('about:blank')
      expect(fake.lastCreateTargetParams).toMatchObject({ url: 'about:blank', background: true })
    } finally {
      await chrome.dispose()
      await fake.close()
    }
  })

  it('policy "reuse" attaches to the instance already serving the port, without asking', async () => {
    const fake = new FakeDebugger()
    await fake.listen()
    const port = (fake.server.address() as AddressInfo).port
    const config = launchConfig(port, true)
    config.occupiedPortPolicy = () => 'reuse'
    const chrome = new ChromeRuntime(new Context(), config)
    try {
      const info = await chrome.ensureConnection('launch')
      expect(info.connected).toBe('attached')
      expect(info.endpoint).toBe(fake.endpoint)
      expect(chrome.ownsBrowserProcess).toBe(false)
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

  it('interactive probe retries the startup race: a port that binds late attaches instead of spawning', async () => {
    const port = await freePort()
    const fake = new FakeDebugger('LateBindChrome/154.0.1', false)
    const chrome = new ChromeRuntime(new Context(), launchConfig(port, true))
    try {
      // The debugger comes up 250ms in — the first probe attempt races it.
      const listening = new Promise<void>(resolve => setTimeout(() => { void fake.listen(port).then(resolve) }, 250))
      const info = await chrome.ensureConnection('auto')
      await listening
      expect(info.connected).toBe('attached')
      expect(info.endpoint).toBe(`http://127.0.0.1:${port}`)
      expect(fake.connections).toBe(1)
    } finally {
      await chrome.dispose()
      await fake.close()
    }
  })

  it('launch preflight retries the startup race: a port that binds late reuses instead of spawning', async () => {
    const port = await freePort()
    const fake = new FakeDebugger()
    const config = launchConfig(port, true)
    config.occupiedPortPolicy = () => 'reuse'
    const chrome = new ChromeRuntime(new Context(), config)
    try {
      const listening = new Promise<void>(resolve => setTimeout(() => { void fake.listen(port).then(resolve) }, 250))
      const info = await chrome.ensureConnection('launch')
      await listening
      // Occupied-and-reused, never spawned over.
      expect(info.connected).toBe('attached')
      expect(info.endpoint).toBe(`http://127.0.0.1:${port}`)
      expect(chrome.ownsBrowserProcess).toBe(false)
    } finally {
      await chrome.dispose()
      await fake.close()
    }
  })

  it('a cancelled fresh launch never spawns over a possibly-free port', async () => {
    const port = await freePort()
    const chrome = new ChromeRuntime(new Context(), launchConfig(port, true))
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(chrome.ensureConnection('launch', controller.signal)).rejects.toMatchObject({ code: 'CHROME_ABORTED' })
    } finally {
      await chrome.dispose()
    }
  })

  it('attach mode with launch:false attaches via cdpUrl and refuses explicit launch', async () => {
    const fake = new FakeDebugger()
    await fake.listen()
    const config: ChromeRuntimeConfig = {
      launch: false,
      reuseExisting: () => true,
      cdpUrl: fake.endpoint,
      port: 1,
      host: '127.0.0.1',
      headless: 'new',
      extraArgs: [],
      operationTimeoutMs: () => 5_000,
      networkIdleMs: () => 100,
      observatoryMaxEntries: () => 500,
      dialogPolicy: () => 'accept',
      dialogPromptText: () => undefined,
      downloadDir: () => undefined,
      occupiedPortPolicy: () => 'refuse',
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
