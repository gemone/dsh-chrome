/**
 * Minimal Chrome DevTools Protocol client over a WebSocket.
 *
 * One {@link CdpClient} wraps a single browser-level CDP WebSocket and speaks
 * the "flattened" session protocol (`Target.attachToTarget` with `flatten:
 * true`): commands and events carry a `sessionId` so a page target is driven
 * through the same socket that owns the browser.
 *
 * The client is transport-agnostic over a {@link WebSocketLike} surface so unit
 * tests can feed it an in-memory peer. Production callers use {@link createCdpClient}.
 * @module dsh-chrome/cdp
 */

import { WebSocket, type RawData } from 'ws'
import { ChromeError } from './types.ts'

/** Transport surface the client drives; the real `ws.WebSocket` satisfies it. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string | Buffer): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: RawData) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  off?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

/** `WebSocket.OPEN` from the `ws` package; mirrored to avoid a runtime import cycle. */
const OPEN = 1

/** One decoded CDP protocol message. Every field is optional; the union is discriminated at use sites. */
export interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** A pending command awaiting its matching response by `id`. */
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  method: string
}

/** Decode one raw WebSocket frame into a CDP message, tolerating malformed JSON. */
export function parseCdpMessage(raw: RawData): CdpMessage | undefined {
  let text: string
  if (typeof raw === 'string') {
    text = raw
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf8')
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw as readonly Buffer[]).toString('utf8')
  } else {
    // ws `RawData` is string | Buffer | Buffer[]; anything else is ignored.
    return undefined
  }
  try {
    return JSON.parse(text) as CdpMessage
  } catch {
    return undefined
  }
}

/**
 * A single browser-level CDP connection. Thread-safe across concurrent
 * `send` calls; each gets a unique monotonic `id`.
 */
export class CdpClient {
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
  private closed = false
  private socketClosed = false

  constructor(private readonly ws: WebSocketLike) {
    const handleMessage = (data: RawData): void => {
      const message = parseCdpMessage(data)
      if (message === undefined) return
      this.dispatch(message)
    }
    const handleClose = (): void => {
      this.socketClosed = true
      const error = new ChromeError('Chrome DevTools Protocol socket closed', 'CHROME_CDP_ERROR')
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
    const handleError = (error: Error): void => {
      if (this.socketClosed) return
      this.socketClosed = true
      const wrapped = error instanceof ChromeError ? error : new ChromeError(`CDP socket error: ${error.message}`, 'CHROME_CDP_ERROR', { cause: error })
      for (const pending of this.pending.values()) pending.reject(wrapped)
      this.pending.clear()
    }
    this.ws.on('message', handleMessage)
    this.ws.on('close', handleClose)
    this.ws.on('error', handleError)
  }

  /** Whether the underlying socket has closed. */
  get isClosed(): boolean {
    return this.socketClosed
  }

  /** Number of commands awaiting a response (diagnostics/testing). */
  get pendingCount(): number {
    return this.pending.size
  }

  /** Internal: route one decoded message to its pending command or event listeners. */
  private dispatch(message: CdpMessage): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(new ChromeError(
          `CDP ${pending.method} failed: ${message.error.message} (code ${message.error.code})`,
          'CHROME_CDP_ERROR',
        ))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method !== undefined) {
      const handlers = this.listeners.get(message.method)
      if (handlers !== undefined) {
        // Snapshot so a handler that unsubscribes itself does not mutate the set mid-iteration.
        for (const handler of [...handlers]) handler(message.params ?? {}, message.sessionId)
      }
    }
  }

  /**
   * Send one CDP command and await its result.
   *
   * Honors `signal`: if it is already aborted the call rejects immediately with
   * `CHROME_ABORTED`; if it fires while waiting, the pending entry is dropped and
   * the call rejects (the browser keeps running the command — cancellation here
   * stops the wait, not the target's work, matching the DSH caller-signal rule).
   *
   * @param method - fully-qualified CDP method, e.g. `Page.navigate`.
   * @param params - method parameters.
   * @param options - optional target `sessionId` and cancellation `signal`.
   * @returns the CDP `result` object.
   */
  send(
    method: string,
    params?: Record<string, unknown>,
    options?: { sessionId?: string; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new ChromeError('CDP client is closed', 'CHROME_CDP_ERROR'))
    if (this.socketClosed) return Promise.reject(new ChromeError('CDP socket is closed', 'CHROME_CDP_ERROR'))
    const signal = options?.signal
    if (signal?.aborted) {
      return Promise.reject(new ChromeError(`CDP ${method} aborted before send`, 'CHROME_ABORTED'))
    }
    const id = this.nextId++
    const payload: CdpMessage = { id, method, ...(params === undefined ? {} : { params }) }
    if (options?.sessionId !== undefined) payload.sessionId = options.sessionId

    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject, method }
      this.pending.set(id, entry)

      const onAbort = (): void => {
        if (!this.pending.delete(id)) return
        reject(new ChromeError(`CDP ${method} aborted`, 'CHROME_ABORTED'))
      }
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true })
        // Resolve with the CDP result and drop the abort listener.
        const originalResolve = entry.resolve
        const originalReject = entry.reject
        entry.resolve = (value: unknown): void => {
          signal.removeEventListener('abort', onAbort)
          originalResolve(value)
        }
        entry.reject = (error: unknown): void => {
          signal.removeEventListener('abort', onAbort)
          originalReject(error)
        }
      }

      try {
        this.ws.send(JSON.stringify(payload))
      } catch (error) {
        this.pending.delete(id)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        reject(new ChromeError(
          `CDP ${method} failed to send: ${error instanceof Error ? error.message : String(error)}`,
          'CHROME_CDP_ERROR',
          { cause: error },
        ))
      }
    })
  }

  /** Subscribe to one CDP event; returns an unsubscribe function. */
  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void {
    let set = this.listeners.get(method)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(handler)
    return () => {
      const existing = this.listeners.get(method)
      if (existing === undefined) return
      existing.delete(handler)
      if (existing.size === 0) this.listeners.delete(method)
    }
  }

  /** Close the underlying socket and reject any pending commands. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.reject(new ChromeError('CDP client closed', 'CHROME_CDP_ERROR'))
    }
    this.pending.clear()
    this.listeners.clear()
    try {
      this.ws.close()
    } catch {
      // A close during teardown must not throw.
    }
  }
}

/**
 * Open a CDP WebSocket to `url`, await the open handshake, and wrap it in a
 * {@link CdpClient}. `signal` aborts the connect wait.
 *
 * @param url - a `ws://` webSocketDebuggerUrl.
 * @param signal - optional cancellation for the connect handshake.
 * @returns a ready CDP client.
 */
export function createCdpClient(url: string, signal?: AbortSignal): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ChromeError('CDP connect aborted before open', 'CHROME_ABORTED'))
      return
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 })
    } catch (error) {
      reject(new ChromeError(
        `failed to open CDP WebSocket to ${url}: ${error instanceof Error ? error.message : String(error)}`,
        'CHROME_ENDPOINT_UNREACHABLE',
        { cause: error },
      ))
      return
    }
    const onOpen = (): void => {
      cleanup()
      const client = new CdpClient(socket as unknown as WebSocketLike)
      resolve(client)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(new ChromeError(
        `CDP WebSocket connect to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
        'CHROME_ENDPOINT_UNREACHABLE',
        { cause: error },
      ))
    }
    const onAbort = (): void => {
      cleanup()
      try {
        socket.close()
      } catch {
        // ignore
      }
      reject(new ChromeError(`CDP connect to ${url} aborted`, 'CHROME_ABORTED'))
    }
    function cleanup(): void {
      socket.off('open', onOpen)
      socket.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Whether a value behaves like an open CDP socket for the client's purposes. */
export function isOpen(ws: WebSocketLike): boolean {
  return ws.readyState === OPEN
}
