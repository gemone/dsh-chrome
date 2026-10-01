/**
 * The Chrome access service, registered as `ctx.chrome`. One instance owns a
 * single Chrome process (when launching) and one browser-level CDP connection
 * driving a dedicated page target through a flattened session.
 *
 * Resources start lazily on first use and are torn down with the owning fiber
 * (an effect-scoped disposer closes the socket and terminates the child). The
 * interface is provider-shaped so a future split into a capability seam +
 * provider + tool consumer is a refactor, not a redesign.
 * @module dsh-chrome/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { CdpClient, createCdpClient } from './cdp.ts'
import { disposeChild, fetchVersionInfo, launchChrome, normalizeDebugEndpoint, type LaunchedChrome } from './launcher.ts'
import { markdownExpression, type RawMarkdownSnapshot } from './markdown.ts'
import { pageSnapshotExpression, type RawPageSnapshot } from './page-walker.ts'
import {
  ChromeError,
  computeCaptureScale,
  type CapturedScreenshot,
  type ClickResult,
  type EvaluationResult,
  type NavigationResult,
  type PageTreeSnapshotResult,
  type SnapshotResult,
  type WaitUntil,
} from './types.ts'

/** Resolved configuration consumed by {@link ChromeRuntime} (schemastery fills defaults). */
export interface ChromeRuntimeConfig {
  /** Explicit Chrome executable path; omitted = discover. */
  readonly executablePath?: string
  /** Launch a managed Chrome. False = attach to `cdpUrl`. */
  readonly launch: boolean
  /** Existing CDP endpoint to attach to when `launch` is false (`ws://` or `http(s)://`). */
  readonly cdpUrl?: string
  /** Remote debugging port for a launched Chrome. */
  readonly port: number
  /** Host a launched Chrome binds its endpoint on. */
  readonly host: string
  /** Headless mode for a launched Chrome. */
  readonly headless: boolean | 'new'
  /** Persistent profile directory; fresh temp dir when omitted. */
  readonly userDataDir?: string
  /** Extra raw Chrome CLI flags. */
  readonly extraArgs: readonly string[]
  /** Per-operation timeout (ms) used as a cooperative backstop inside the service. */
  readonly operationTimeoutMs: number
  /** Default quiet window before `networkidle*` is declared. */
  readonly networkIdleMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    chrome: ChromeRuntime
  }
}

/** One tracked in-flight network request id. */
interface NetworkState {
  inflight: Set<string>
  timer?: NodeJS.Timeout
}

/** Connection lifecycle state. */
type ConnectionState =
  | { kind: 'idle' }
  | { kind: 'connecting'; promise: Promise<ActiveConnection> }
  | { kind: 'connected'; active: ActiveConnection }
  /** Browser connection alive, but the page target was closed (e.g. via closeTab). */
  | { kind: 'connected-browser'; client: CdpClient; launched?: LaunchedChrome }
  | { kind: 'disposed' }

/** A live browser connection driving one page target. */
interface ActiveConnection {
  readonly client: CdpClient
  readonly targetId: string
  readonly sessionId: string
  /** The launched child, when this runtime owns it. */
  readonly launched?: LaunchedChrome
  /** Per-session network request tracker for `networkidle*` waits. */
  readonly network: NetworkState
  /**
   * Ref id to CSS selector from the most recent `pageSnapshot()`. Mutated in
   * place: navigation clears it, each snapshot replaces it wholesale.
   */
  readonly pageRefs: Map<string, string>
}

/**
 * The Chrome DevTools Protocol service. Methods are the capability surface the
 * model-facing tools consume; each forwards the caller's cancellation signal.
 */
export class ChromeRuntime extends Service {
  private state: ConnectionState = { kind: 'idle' }

  constructor(ctx: Context, private readonly config: ChromeRuntimeConfig) {
    super(ctx, 'chrome')
    // Tear down the lazy Chrome resources with the owning fiber, whether or not
    // a connection was ever opened. The disposer is async; unloading awaits it.
    this.ctx.effect(() => () => { void this.dispose() }, 'chrome.dispose')
  }

  /** Whether the runtime is currently attached to a live Chrome target. */
  get isConnected(): boolean {
    return this.state.kind === 'connected' && !this.state.active.client.isClosed
  }

  /**
   * Ensure a live connection exists, creating one lazily. Reconnects if the
   * previous socket died. Concurrent first-callers share the single connect
   * promise.
   *
   * @param signal - optional cancellation for the connect/attach handshake.
   * @returns the active connection.
   */
  private async ensure(signal?: AbortSignal): Promise<ActiveConnection> {
    if (this.state.kind === 'connected') {
      const active = this.state.active
      if (!active.client.isClosed) return active
      // Socket died: drop it and reconnect.
      await this.closeActive(active).catch(() => undefined)
      this.state = { kind: 'idle' }
    }
    if (this.state.kind === 'connected-browser') {
      const { client, launched } = this.state
      if (client.isClosed) {
        this.state = { kind: 'idle' }
        return this.ensure(signal)
      }
      // Browser alive but no target: create a fresh page target on the existing connection.
      const active = await this.createTargetOnClient(client, launched, signal)
      this.state = { kind: 'connected', active }
      return active
    }
    if (this.state.kind === 'disposed') {
      throw new ChromeError('Chrome runtime has been disposed', 'CHROME_CDP_ERROR')
    }
    if (this.state.kind === 'connecting') return this.state.promise
    const promise = this.connect(signal)
    this.state = { kind: 'connecting', promise }
    try {
      const active = await promise
      this.state = { kind: 'connected', active }
      return active
    } catch (error) {
      if (this.state.kind === 'connecting') this.state = { kind: 'idle' }
      throw error
    }
  }

  /** Open the browser connection and attach to a fresh page target. */
  private async connect(signal?: AbortSignal): Promise<ActiveConnection> {
    let webSocketDebuggerUrl: string
    let launched: LaunchedChrome | undefined
    if (this.config.launch) {
      launched = launchChrome({
        executablePath: this.config.executablePath,
        port: this.config.port,
        host: this.config.host,
        headless: this.config.headless,
        ...this.config.userDataDir !== undefined ? { userDataDir: this.config.userDataDir } : {},
        extraArgs: this.config.extraArgs,
      })
      const version = await waitForReady(launched.endpoint, this.config.operationTimeoutMs, signal, launched)
      webSocketDebuggerUrl = version.webSocketDebuggerUrl
    } else {
      const endpoint = this.config.cdpUrl
      if (endpoint === undefined || endpoint.length === 0) {
        throw new ChromeError('Chrome connect mode requires a "cdpUrl" (ws:// or http(s):// endpoint)', 'CHROME_ENDPOINT_UNREACHABLE')
      }
      webSocketDebuggerUrl = await resolveBrowserWsUrl(endpoint, signal)
    }

    const client = await createCdpClient(webSocketDebuggerUrl, signal)
    try {
      return await this.createTargetOnClient(client, launched, signal)
    } catch (error) {
      await client.close()
      if (launched?.child !== undefined) await disposeChild(launched.child).catch(() => undefined)
      throw error
    }
  }

  /**
   * Create a fresh page target on an existing browser-level CDP connection and
   * attach via the flattened session protocol. Used by both `connect()` (first
   * attach) and the `connected-browser` state (after a tab was closed).
   */
  private async createTargetOnClient(client: CdpClient, launched: LaunchedChrome | undefined, signal?: AbortSignal): Promise<ActiveConnection> {
    const created = await client.send('Target.createTarget', { url: 'about:blank' }, { signal }) as { targetId: string }
    const targetId = created.targetId
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }, { signal }) as { sessionId: string }
    const sessionId = attached.sessionId
    const network: NetworkState = { inflight: new Set() }
    const pageRefs = new Map<string, string>()
    // Enable the domains the tools rely on; failures here are infrastructure errors.
    await client.send('Page.enable', undefined, { sessionId, signal })
    await client.send('Runtime.enable', undefined, { sessionId, signal })
    await client.send('Network.enable', undefined, { sessionId, signal })
    this.trackNetwork(client, sessionId, network)
    return { client, targetId, sessionId, launched, network, pageRefs }
  }

  /** Subscribe to Network events to maintain the `networkidle*` inflight set. */
  private trackNetwork(client: CdpClient, sessionId: string, network: NetworkState): void {
    const onRequest = (params: unknown): void => {
      const requestId = (params as { requestId?: string }).requestId
      if (requestId === undefined) return
      network.inflight.add(requestId)
    }
    const onDone = (params: unknown): void => {
      const requestId = (params as { requestId?: string }).requestId
      if (requestId === undefined) return
      network.inflight.delete(requestId)
    }
    client.on('Network.requestWillBeSent', onRequest)
    client.on('Network.responseReceived', onDone)
    client.on('Network.loadingFinished', onDone)
    client.on('Network.loadingFailed', onDone)
    void sessionId
  }

  /** Navigate the page target to a URL and wait for the chosen lifecycle event. */
  async navigate(url: string, waitUntil: WaitUntil, signal?: AbortSignal): Promise<NavigationResult> {
    const active = await this.ensure(signal)
    const { client, sessionId, network } = active
    const waiter = this.startLoadWaiter(client, sessionId, waitUntil, network)
    let nav: { loaderId?: string; errorText?: string }
    try {
      nav = await client.send('Page.navigate', { url }, { sessionId, signal }) as { loaderId?: string; errorText?: string }
    } catch (error) {
      waiter.cancel()
      throw error
    }
    if (nav.errorText !== undefined) {
      waiter.cancel()
      throw new ChromeError(`navigation to ${url} failed: ${nav.errorText} (verify the URL resolves from the machine running Chrome)`, 'CHROME_CDP_ERROR')
    }
    try {
      await waiter.wait(this.config.operationTimeoutMs, signal)
    } catch (error) {
      if (error instanceof ChromeError && error.code === 'CHROME_TIMEOUT') {
        throw new ChromeError(
          `navigation to ${url} timed out after ${this.config.operationTimeoutMs} ms waiting for "${waitUntil}"; `
          + 'networkidle* waits never settle on pages with long-polling or streaming connections — prefer "load" or "domcontentloaded", or raise operationTimeoutMs',
          'CHROME_TIMEOUT',
          { cause: error },
        )
      }
      throw error
    } finally {
      waiter.dispose()
    }
    // A new document invalidates every ref from the previous page snapshot.
    active.pageRefs.clear()
    const meta = await this.evaluate(`JSON.stringify({ url: location.href, title: document.title })`, { signal })
    const parsed = parseJsonString(meta.result) as { url: string; title: string } | undefined
    return {
      url,
      finalUrl: parsed?.url ?? url,
      title: parsed?.title ?? '',
      ...nav.loaderId !== undefined ? { loaderId: nav.loaderId } : {},
    }
  }

  /** Evaluate a JS expression in the page and return its serialized result. */
  async evaluate(expression: string, options?: { awaitPromise?: boolean; returnByValue?: boolean; signal?: AbortSignal }): Promise<EvaluationResult> {
    const active = await this.ensure(options?.signal)
    const result = await active.client.send('Runtime.evaluate', {
      expression,
      awaitPromise: options?.awaitPromise ?? true,
      returnByValue: options?.returnByValue ?? true,
      userGesture: true,
    }, { sessionId: active.sessionId, signal: options?.signal }) as {
      result?: { value?: unknown }
      exceptionDetails?: EvaluationResult['exceptionDetails']
    }
    return {
      result: result.result?.value,
      ...result.exceptionDetails !== undefined ? { exceptionDetails: result.exceptionDetails } : {},
    }
  }

  /**
   * Capture a screenshot as decoded bytes plus its verified media type. When
   * `limits` are given and the page exceeds them (DSH 0.1.7's attachment
   * admission refuses images over `maxDimension` per side or `maxPixels`
   * total), the capture is scaled down via a CDP clip instead of being
   * refused at commit time.
   */
  async screenshot(options: {
    format?: 'png' | 'jpeg' | 'webp'
    quality?: number
    fullPage?: boolean
    signal?: AbortSignal
    limits?: { readonly maxDimension?: number; readonly maxPixels?: number }
  }): Promise<CapturedScreenshot> {
    const format = options.format ?? 'png'
    const active = await this.ensure(options?.signal)
    const fullPage = options.fullPage ?? true
    if (fullPage) {
      await active.client.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      }, { sessionId: active.sessionId, signal: options?.signal }).catch(() => undefined)
    }

    // Measure the page and scale the capture into the admission budget.
    let scale: number | undefined
    let sourceWidth: number | undefined
    let sourceHeight: number | undefined
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
    if (fullPage && options.limits !== undefined) {
      const metrics = await active.client.send('Page.getLayoutMetrics', undefined, {
        sessionId: active.sessionId, signal: options?.signal,
      }).catch(() => undefined) as { cssContentSize?: { width: number; height: number } } | undefined
      const size = metrics?.cssContentSize
      if (size !== undefined && size.width > 0 && size.height > 0) {
        sourceWidth = size.width
        sourceHeight = size.height
        const computed = computeCaptureScale(size.width, size.height, options.limits)
        if (computed < 1) {
          scale = computed
          // The clip covers the full page in CSS pixels; `scale` shrinks the
          // produced raster, exactly like DevTools' "capture node screenshot".
          clip = { x: 0, y: 0, width: size.width, height: size.height, scale: computed }
        }
      }
    }

    const params: Record<string, unknown> = {
      format,
      ...format === 'jpeg' && options.quality !== undefined ? { quality: options.quality } : {},
      captureBeyondViewport: fullPage || clip !== undefined,
      ...clip !== undefined ? { clip } : {},
    }
    const response = await active.client.send('Page.captureScreenshot', params, {
      sessionId: active.sessionId, signal: options?.signal,
    }) as { data?: string }
    if (typeof response.data !== 'string' || response.data.length === 0) {
      throw new ChromeError('Page.captureScreenshot returned no image data', 'CHROME_CDP_ERROR')
    }
    const data = Buffer.from(response.data, 'base64')
    return {
      data: new Uint8Array(data),
      mediaType: `image/${format}` as CapturedScreenshot['mediaType'],
      ...sourceWidth !== undefined ? { sourceWidth } : {},
      ...sourceHeight !== undefined ? { sourceHeight } : {},
      ...scale !== undefined ? { scale } : {},
    }
  }

  /** Read bounded visible page text plus url/title. */
  async snapshot(maxChars: number, signal?: AbortSignal): Promise<SnapshotResult> {
    const active = await this.ensure(signal)
    const expression = `(() => { const t = document.body && document.body.innerText ? document.body.innerText : ''; return JSON.stringify({ url: location.href, title: document.title, readyState: document.readyState, text: t.slice(0, ${Math.max(0, Math.floor(maxChars))}), truncated: t.length > ${Math.max(0, Math.floor(maxChars))} }); })()`
    const evaluation = await active.client.send('Runtime.evaluate', {
      expression,
      awaitPromise: false,
      returnByValue: true,
    }, { sessionId: active.sessionId, signal }) as { result?: { value?: string } }
    const parsed = parseJsonString(evaluation.result?.value) as { url: string; title: string; readyState?: string; text: string; truncated: boolean } | undefined
    if (parsed === undefined) {
      return { url: '', title: '', readyState: '', text: '', truncated: false }
    }
    return { url: parsed.url, title: parsed.title, readyState: parsed.readyState ?? '', text: parsed.text, truncated: parsed.truncated }
  }

  /** Read the page converted to bounded GitHub-flavored Markdown. */
  async markdown(maxChars: number, signal?: AbortSignal): Promise<SnapshotResult> {
    const active = await this.ensure(signal)
    const evaluation = await active.client.send('Runtime.evaluate', {
      expression: markdownExpression(maxChars),
      awaitPromise: false,
      returnByValue: true,
    }, { sessionId: active.sessionId, signal }) as { result?: { value?: string } }
    const parsed = parseJsonString(evaluation.result?.value) as RawMarkdownSnapshot | undefined
    if (parsed === undefined || typeof parsed.markdown !== 'string') {
      return { url: '', title: '', readyState: '', text: '', truncated: false }
    }
    return { url: parsed.url, title: parsed.title, readyState: parsed.readyState ?? '', text: parsed.markdown, truncated: parsed.truncated }
  }

  /**
   * Capture one structured (use-browser style) page snapshot: an element tree
   * with `[ref=eN]` ids plus the ref-to-selector map this runtime keeps for
   * `chrome_click` / `chrome_type` / `chrome_scroll`. The map replaces any
   * previous one; navigation clears it.
   */
  async pageSnapshot(maxNodes: number, signal?: AbortSignal): Promise<PageTreeSnapshotResult> {
    const active = await this.ensure(signal)
    const evaluation = await active.client.send('Runtime.evaluate', {
      expression: pageSnapshotExpression(maxNodes),
      awaitPromise: false,
      returnByValue: true,
    }, { sessionId: active.sessionId, signal }) as { result?: { value?: string } }
    const parsed = parseJsonString(evaluation.result?.value) as RawPageSnapshot | undefined
    if (parsed === undefined || typeof parsed.tree !== 'string') {
      throw new ChromeError(
        'the page returned no structured snapshot (no document body, a non-HTML document, or the page is still loading)',
        'CHROME_CDP_ERROR',
      )
    }
    const refs = new Map<string, string>()
    const raw = parsed.refs ?? {}
    for (const ref of Object.keys(raw)) {
      const selector = raw[ref]
      if (typeof selector === 'string' && selector.length > 0) refs.set(ref, selector)
    }
    active.pageRefs.clear()
    for (const [ref, selector] of refs) active.pageRefs.set(ref, selector)
    return {
      url: parsed.url,
      title: parsed.title,
      readyState: parsed.readyState,
      tree: parsed.tree,
      refCount: refs.size,
      truncated: parsed.truncated === true,
    }
  }

  /** Resolve one `[ref=eN]` id to the CSS selector captured with it. */
  resolvePageRef(ref: string): string | undefined {
    if (this.state.kind !== 'connected') return undefined
    return this.state.active.pageRefs.get(ref)
  }

  /** How many refs from the latest `pageSnapshot()` are currently actionable. */
  get registeredPageRefCount(): number {
    return this.state.kind === 'connected' ? this.state.active.pageRefs.size : 0
  }

  /** Click the center of the first element matching a CSS selector. */
  async click(selector: string, button: 'left' | 'right' | 'middle', signal?: AbortSignal): Promise<ClickResult> {
    const active = await this.ensure(signal)
    // Resolve the center and, in the same script, check what actually sits on
    // top of that point — a cookie banner or fixed header intercepting the
    // click is the classic "clicked but nothing happened" failure.
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; let coveredBy = null; const top = document.elementFromPoint(x, y); if (top && top !== el && !el.contains(top) && !top.contains(el)) { let desc = top.tagName.toLowerCase(); if (top.id) desc += '#' + top.id; else if (typeof top.className === 'string' && top.className.trim()) desc += '.' + top.className.trim().split(/\\s+/).slice(0, 3).join('.'); coveredBy = desc; } return JSON.stringify({ x, y, coveredBy }); })()`
    const evaluation = await active.client.send('Runtime.evaluate', {
      expression,
      awaitPromise: false,
      returnByValue: true,
    }, { sessionId: active.sessionId, signal }) as { result?: { value?: string } }
    const center = parseJsonString(evaluation.result?.value) as { x: number; y: number; coveredBy: string | null } | null
    if (center === null) {
      return { clicked: false, selector }
    }
    const cdpButton = button === 'left' ? 'left' : button === 'right' ? 'right' : 'middle'
    await active.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y }, { sessionId: active.sessionId, signal })
    await active.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: cdpButton, clickCount: 1 }, { sessionId: active.sessionId, signal })
    await active.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: cdpButton, clickCount: 1 }, { sessionId: active.sessionId, signal })
    return {
      clicked: true,
      selector,
      ...center.coveredBy !== null ? { coveredBy: center.coveredBy } : {},
    }
  }

  /** Low-level CDP method passthrough on the page session (power-user escape hatch). */
  async cdp(request: { method: string; params?: Record<string, unknown> }, signal?: AbortSignal): Promise<unknown> {
    const active = await this.ensure(signal)
    return active.client.send(request.method, request.params, { sessionId: active.sessionId, signal })
  }

  /**
   * Close the current page target (tab). The browser-level connection stays
   * alive; the next tool call auto-creates a fresh target on the same browser.
   */
  async closeTab(signal?: AbortSignal): Promise<void> {
    const active = await this.ensure(signal)
    try {
      await active.client.send('Target.closeTarget', { targetId: active.targetId }, { signal })
    } finally {
      if (active.network.timer !== undefined) clearTimeout(active.network.timer)
      this.state = { kind: 'connected-browser', client: active.client, launched: active.launched }
    }
  }

  /**
   * Close the entire browser: dispose the CDP connection and kill the child
   * process (when the runtime owns it). After this, the next tool call
   * re-launches a fresh Chrome if `launch: true`.
   */
  async closeBrowser(): Promise<void> {
    const previous = this.state
    this.state = { kind: 'idle' }
    if (previous.kind === 'connected') {
      await this.closeActive(previous.active).catch(() => undefined)
    } else if (previous.kind === 'connected-browser') {
      try { previous.client.close() } catch { /* ignore */ }
      if (previous.launched?.child !== undefined) {
        await disposeChild(previous.launched.child).catch(() => undefined)
      }
    } else if (previous.kind === 'connecting') {
      try {
        const active = await previous.promise
        await this.closeActive(active).catch(() => undefined)
      } catch { /* connect failed */ }
    }
  }

  /** Start an event-based load waiter for one {@link WaitUntil} lifecycle. */
  private startLoadWaiter(client: CdpClient, sessionId: string, waitUntil: WaitUntil, network: NetworkState): LoadWaiter {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    const offDom = client.on('Page.domContentEventFired', () => {
      if (waitUntil === 'domcontentloaded') resolve()
    })
    const offLoad = client.on('Page.loadEventFired', () => {
      if (waitUntil === 'load' || waitUntil === 'domcontentloaded') resolve()
    })
    let idleThreshold = waitUntil === 'networkidle0' ? 0 : waitUntil === 'networkidle2' ? 2 : -1
    const checkIdle = (): void => {
      if (idleThreshold < 0) return
      if (network.inflight.size <= idleThreshold) {
        if (network.timer !== undefined) clearTimeout(network.timer)
        network.timer = setTimeout(resolve, this.config.networkIdleMs)
      } else if (network.timer !== undefined) {
        clearTimeout(network.timer)
        network.timer = undefined
      }
    }
    const offRequest = idleThreshold >= 0 ? client.on('Network.requestWillBeSent', checkIdle) : () => undefined
    const offDone = idleThreshold >= 0 ? client.on('Network.loadingFinished', checkIdle) : () => undefined
    const offFail = idleThreshold >= 0 ? client.on('Network.loadingFailed', checkIdle) : () => undefined
    void sessionId

    return {
      wait(timeoutMs, signal) {
        return raceWithTimeout(promise, timeoutMs, signal)
      },
      cancel() {
        reject(new ChromeError('navigation waiter cancelled', 'CHROME_ABORTED'))
      },
      dispose() {
        offDom()
        offLoad()
        offRequest()
        offDone()
        offFail()
        if (network.timer !== undefined) {
          clearTimeout(network.timer)
          network.timer = undefined
        }
        idleThreshold = -1
      },
    }
  }

  /** Close one active connection and terminate its child, swallowing errors. */
  private async closeActive(active: ActiveConnection): Promise<void> {
    try {
      active.client.close()
    } catch {
      // ignore
    }
    if (active.network.timer !== undefined) clearTimeout(active.network.timer)
    if (active.launched?.child !== undefined) {
      await disposeChild(active.launched.child).catch(() => undefined)
    }
  }

  /** Permanently dispose the runtime: close socket, kill child, mark disposed. */
  async dispose(): Promise<void> {
    const previous = this.state
    this.state = { kind: 'disposed' }
    if (previous.kind === 'connected') {
      await this.closeActive(previous.active).catch(() => undefined)
    } else if (previous.kind === 'connecting') {
      try {
        const active = await previous.promise
        await this.closeActive(active).catch(() => undefined)
      } catch {
        // connect failed; nothing live to close
      }
    }
  }
}

/** A load-lifecycle waiter for one navigation. */
interface LoadWaiter {
  wait(timeoutMs: number, signal?: AbortSignal): Promise<void>
  cancel(): void
  dispose(): void
}

/** Resolve a promise or reject on timeout/abort. */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ChromeError(`operation timed out after ${timeoutMs} ms`, 'CHROME_TIMEOUT'))
    }, timeoutMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ChromeError('operation aborted', 'CHROME_ABORTED'))
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      reject(new ChromeError('operation aborted', 'CHROME_ABORTED'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Best-effort JSON.parse of a string; returns undefined on any failure. */
export function parseJsonString(value: unknown): unknown | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** Resolve a browser-level `webSocketDebuggerUrl` from a `ws://` or `http(s)://` endpoint. */
async function resolveBrowserWsUrl(endpoint: string, signal?: AbortSignal): Promise<string> {
  if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) return endpoint
  // Chrome ≥111 rejects DevTools HTTP requests whose Host header is not an
  // IP; a `localhost` cdpUrl (especially behind a proxy) trips this, so poll by IP.
  const version = await fetchVersionInfo(normalizeDebugEndpoint(endpoint.replace(/\/$/, '')), signal)
  return version.webSocketDebuggerUrl
}

/** Poll a launched Chrome endpoint until ready, surfacing immediate child exit. */
async function waitForReady(endpoint: string, timeoutMs: number, signal: AbortSignal | undefined, launched: LaunchedChrome): Promise<{ webSocketDebuggerUrl: string }> {
  const retries = Math.max(5, Math.floor(timeoutMs / 100))
  const exited = launched.child !== undefined
    ? new Promise<never>((_, reject) => {
      launched.child!.once('exit', code => {
        // Chrome prints the real reason it cannot start (profile locked by
        // another instance, sandbox or /dev/shm failure in containers, a bad
        // flag) to stderr. Node can emit 'exit' before the stdio streams
        // deliver their final chunks, so drain briefly before reading the tail.
        setTimeout(() => {
          const output = launched.recentOutput().trim()
          let hint = ''
          if (output.includes('SingletonLock') || output.includes('SingletonSocket')) {
            hint = '; another Chrome is already using this userDataDir — give the plugin its own profile directory'
          } else if (output.includes('sandbox') || output.includes('Failed to move to new namespace')) {
            hint = '; running in a container? add ["--no-sandbox", "--disable-dev-shm-usage"] to extraArgs'
          }
          reject(new ChromeError(
            `Chrome exited before its debugging endpoint opened (exit code ${code})`
            + (output.length > 0 ? `; last output: ${output.slice(-800)}` : '')
            + hint,
            'CHROME_LAUNCH_FAILED',
          ))
        }, 80)
      })
    })
    : new Promise<never>(() => undefined)
  return await Promise.race([
    waitWithRetry(endpoint, retries, signal),
    exited,
  ])
}

/** Retry `fetchVersionInfo` until success, abort, or budget exhaustion. */
async function waitWithRetry(endpoint: string, retries: number, signal: AbortSignal | undefined): Promise<{ webSocketDebuggerUrl: string }> {
  let lastError: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    if (signal?.aborted) throw new ChromeError('Chrome endpoint wait aborted', 'CHROME_ABORTED')
    try {
      return await fetchVersionInfo(endpoint, signal)
    } catch (error) {
      lastError = error
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
  }
  if (lastError instanceof ChromeError) throw lastError
  throw new ChromeError(`Chrome endpoint at ${endpoint} did not become ready`, 'CHROME_ENDPOINT_UNREACHABLE', { cause: lastError })
}
