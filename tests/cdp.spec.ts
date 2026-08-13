import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { CdpClient, parseCdpMessage, type WebSocketLike } from '../src/cdp.ts'
import { ChromeError } from '../src/types.ts'

/** Minimal in-memory CDP peer for testing the client. */
class MockSocket implements WebSocketLike {
  readonly readyState = 1
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  sent: string[] = []

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return listener
  }
  off(event: string, listener: (...args: unknown[]) => void): unknown {
    this.listeners.get(event)?.delete(listener)
    return listener
  }
  removeListener = this.off
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.emit('close', 1000, Buffer.from(''))
  }
  /** Test helper: deliver one decoded CDP frame to the client. */
  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event)
    if (set !== undefined) for (const listener of [...set]) listener(...args)
  }
  /** Deliver a CDP message object as a JSON buffer frame. */
  reply(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)))
  }
}

describe('parseCdpMessage', () => {
  it('decodes a JSON buffer frame', () => {
    const message = parseCdpMessage(Buffer.from(JSON.stringify({ id: 1, result: { ok: true } })))
    expect(message).toBeDefined()
    expect(message?.id).toBe(1)
    expect(message?.result).toEqual({ ok: true })
  })

  it('decodes a string frame', () => {
    const message = parseCdpMessage(JSON.stringify({ method: 'Page.loadEventFired' }))
    expect(message?.method).toBe('Page.loadEventFired')
  })

  it('returns undefined for malformed JSON', () => {
    expect(parseCdpMessage(Buffer.from('not json'))).toBeUndefined()
  })
})

describe('CdpClient', () => {
  it('matches a command response by id and resolves with result', async () => {
    const socket = new MockSocket()
    const client = new CdpClient(socket)
    const pending = client.send('Page.navigate', { url: 'https://example.com' })
    await new Promise(r => setImmediate(r))
    expect(socket.sent).toHaveLength(1)
    const sent = JSON.parse(socket.sent[0]!) as { id: number; method: string; params: unknown }
    expect(sent.method).toBe('Page.navigate')
    expect(sent.params).toEqual({ url: 'https://example.com' })
    socket.reply({ id: sent.id, result: { frameId: 'F1', loaderId: 'L1' } })
    await expect(pending).resolves.toEqual({ frameId: 'F1', loaderId: 'L1' })
    expect(client.pendingCount).toBe(0)
    client.close()
  })

  it('rejects on a CDP error response', async () => {
    const socket = new MockSocket()
    const client = new CdpClient(socket)
    const pending = client.send('Target.createTarget')
    await new Promise(r => setImmediate(r))
    const sent = JSON.parse(socket.sent[0]!) as { id: number }
    socket.reply({ id: sent.id, error: { code: -32000, message: 'boom' } })
    await expect(pending).rejects.toThrow(/Target.createTarget failed: boom/)
    client.close()
  })

  it('rejects all pending when the socket closes', async () => {
    const socket = new MockSocket()
    const client = new CdpClient(socket)
    const pending = client.send('Runtime.evaluate')
    await new Promise(r => setImmediate(r))
    socket.emit('close', 1000, Buffer.from(''))
    await expect(pending).rejects.toBeInstanceOf(ChromeError)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const socket = new MockSocket()
    const client = new CdpClient(socket)
    const controller = new AbortController()
    controller.abort()
    await expect(client.send('Page.reload', undefined, { signal: controller.signal })).rejects.toMatchObject({ code: 'CHROME_ABORTED' })
    client.close()
  })

  it('rejects a waiting command when the signal fires', async () => {
    const socket = new MockSocket()
    const client = new CdpClient(socket)
    const controller = new AbortController()
    const pending = client.send('Runtime.evaluate', undefined, { signal: controller.signal })
    await new Promise(r => setImmediate(r))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CHROME_ABORTED' })
    client.close()
  })

  it('delivers events to subscribers', () => {
    const socket = new MockSocket()
    const client = new CdpClient(socket)
    const calls: unknown[] = []
    client.on('Page.loadEventFired', params => calls.push(params))
    socket.reply({ method: 'Page.loadEventFired', params: { ts: 1 } })
    expect(calls).toEqual([{ ts: 1 }])
    client.close()
  })
})
