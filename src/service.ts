/**
 * The Chrome access service, registered as `ctx.chrome`. One instance owns a
 * single Chrome process (when launching) and one browser-level CDP connection
 * driving a dedicated page target through a flattened session.
 *
 * Connection strategies: launch a managed Chrome, attach to a `cdpUrl`, or —
 * the default in launch mode — probe the configured debugger `port` first and
 * reuse an instance already listening there (`ensureConnection` exposes the
 * choice to the model via `chrome_connect`).
 *
 * Resources start lazily on first use and are torn down with the owning fiber
 * (an effect-scoped disposer closes the socket and terminates the child). The
 * interface is provider-shaped so a future split into a capability seam +
 * provider + tool consumer is a refactor, not a redesign.
 * @module dsh-chrome/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { CdpClient, createCdpClient } from './cdp.ts'
import { networkConditions } from './emulation.ts'
import { urlMatchesGlob } from './url-glob.ts'
import { formatAxTree, storageReadExpression, storageWriteExpression, type RawAxNode } from './a11y.ts'
import { DEFAULT_WS_PROBE_TIMEOUT_MS, disposeChild, fetchVersionInfo, findFreePort, launchChrome, normalizeDebugEndpoint, probeEndpointPresence, probeExistingEndpoint, type ChromeVersionInfo, type LaunchedChrome } from './launcher.ts'
import { DEFAULT_PAGE_SNAPSHOT_MAX_NODES } from './page-walker.ts'
import { DEFAULT_SNAPSHOT_MAX_CHARS, type ChromeSettings } from './settings.ts'
import { markdownExpression, type RawMarkdownSnapshot } from './markdown.ts'
import { pageSnapshotExpression, type RawPageSnapshot } from './page-walker.ts'
import {
  Observatory,
  DEFAULT_NET_BODY_MAX_CHARS,
  DEFAULT_STORAGE_VALUE_MAX_CHARS,
  formatActivityHint as formatActivityHintSafe,
  type ConsoleLevel,
  type ConsoleReadResult,
  type NetEntry,
  type NetListResult,
} from './observatory.ts'
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
  /**
   * Before launching on `port`, probe the debugger endpoint first and attach
   * to an instance already listening there instead of spawning a second
   * Chrome over the same port. False = always launch (the port must be free).
   */
  readonly reuseExisting: () => boolean
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
  /**
   * Per-operation timeout (ms), read live at each use so a settings edit
   * applies to the next operation without restarting the plugin.
   */
  readonly operationTimeoutMs: () => number
  /** `chrome_connect` budget (ms), read live per connect. */
  readonly connectTimeoutMs: () => number
  /** Default quiet window before `networkidle*` is declared (ms), read live. */
  readonly networkIdleMs: () => number
  /** Ring-buffer capacity per observatory stream, read live per connection. */
  readonly observatoryMaxEntries: () => number
  /** How to answer JS dialogs, read live per dialog (default "accept"). */
  readonly dialogPolicy: () => 'accept' | 'dismiss'
  /** Prompt text sent when answering a `prompt` dialog under "accept", read live. */
  readonly dialogPromptText: () => string | undefined
  /** Directory downloads are redirected into (absolute path), read live. */
  readonly downloadDir: () => string | undefined
  /** What a fresh launch does when the configured port is already served (read live). */
  readonly occupiedPortPolicy: () => 'reuse' | 'refuse'
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

/** Strategy for obtaining the browser connection (the `chrome_connect` modes). */
export type ChromeConnectMode = 'auto' | 'reuse' | 'launch'

/** Snapshot of the current browser connection, reported by {@link ChromeRuntime.ensureConnection}. */
export interface ChromeConnectionInfo {
  /** How the browser was obtained: attached to an existing instance, or launched fresh. */
  readonly connected: 'attached' | 'launched'
  /** The debugger endpoint base URL in use. */
  readonly endpoint: string
  /** Browser version string from `/json/version` (empty when unknown). */
  readonly browser: string
  /** The page target id driving the tools. */
  readonly targetId: string
}

/** Connection lifecycle state. */
type ConnectionState =
  | { kind: 'idle' }
  | { kind: 'connecting'; promise: Promise<ActiveConnection> }
  | { kind: 'connected'; active: ActiveConnection }
  /** Browser connection alive, but the page target was closed (e.g. via closeTab). */
  | { kind: 'connected-browser'; client: CdpClient; endpoint: string; browser: string; launched?: LaunchedChrome }
  | { kind: 'disposed' }

/** A live browser connection driving one page target. */
interface ActiveConnection {
  readonly client: CdpClient
  readonly targetId: string
  readonly sessionId: string
  /** The debugger endpoint base URL this connection came from. */
  readonly endpoint: string
  /** Browser version string reported by `/json/version` (empty when unknown). */
  readonly browser: string
  /** The launched child, when this runtime owns it (absent when attached to an existing instance). */
  readonly launched?: LaunchedChrome
  /** Per-session network request tracker for `networkidle*` waits. */
  readonly network: NetworkState
  /** Per-session activity ring buffers (network + console). */
  readonly observatory: Observatory
  /** What the model has already seen — the "since" cursors for auto-hints. */
  readonly readCursors: { net: number; console: number }
  /** CDP event disposers for this session's trackers, unwound on recovery. */
  readonly listeners: (() => void)[]
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
  /** In-flight dead-session recovery, shared by concurrent ensure() callers. */
  private recovery?: Promise<ActiveConnection>

  private readonly config: ChromeRuntimeConfig

  /**
   * The live settings view this runtime was built over. Family component rows
   * (which inject `chrome` instead of carrying their own config) read their
   * registration-time values — e.g. the declared `timeoutMs` — from here, so
   * a live settings edit on the core row applies to them through the
   * `chrome/registrations-changed` event.
   */
  readonly settings: ChromeSettings

  constructor(ctx: Context, config: ChromeRuntimeConfig, settings?: ChromeSettings) {
    super(ctx, 'chrome')
    this.config = config
    this.settings = settings ?? {
      reuseExisting: config.reuseExisting,
      operationTimeoutMs: config.operationTimeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      networkIdleMs: config.networkIdleMs,
      snapshotMaxChars: () => DEFAULT_SNAPSHOT_MAX_CHARS,
      pageSnapshotMaxNodes: () => DEFAULT_PAGE_SNAPSHOT_MAX_NODES,
      observatoryMaxEntries: config.observatoryMaxEntries,
      dialogPolicy: config.dialogPolicy,
      dialogPromptText: config.dialogPromptText,
      downloadDir: config.downloadDir,
      analysisRoute: () => undefined,
      occupiedPortPolicy: config.occupiedPortPolicy,
    }
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
   * @param mode - explicit connect strategy; defaults to the `reuseExisting`
   * config (probe-and-attach when true, always launch when false).
   * @returns the active connection.
   */
  private async ensure(signal?: AbortSignal, mode?: ChromeConnectMode): Promise<ActiveConnection> {
    const connectMode = mode ?? (this.config.reuseExisting() ? 'auto' : 'launch')
    if (this.state.kind === 'connected') {
      const active = this.state.active
      if (!active.client.isClosed) {
        // The flattened page session can die under us (the user closes the
        // tab, the target crashes or is replaced): verify it before trusting
        // it, so one stale session id cannot wedge every later call.
        if (await this.sessionAlive(active, signal)) return active
        if (this.recovery === undefined) {
          this.recovery = this.recoverPageTarget(active, signal).finally(() => { this.recovery = undefined })
        }
        return this.recovery
      }
      // Socket died: drop it and reconnect.
      await this.closeActive(active).catch(() => undefined)
      this.state = { kind: 'idle' }
    }
    if (this.state.kind === 'connected-browser') {
      const { client, endpoint, browser, launched } = this.state
      if (client.isClosed) {
        this.state = { kind: 'idle' }
        return this.ensure(signal, mode)
      }
      // Browser alive but no target: create a fresh page target on the existing connection.
      const active = await this.createTargetOnClient(client, { endpoint, browser, launched }, signal)
      this.state = { kind: 'connected', active }
      return active
    }
    if (this.state.kind === 'disposed') {
      throw new ChromeError('Chrome runtime has been disposed', 'CHROME_CDP_ERROR')
    }
    if (this.state.kind === 'connecting') return this.state.promise
    const promise = this.connectWithMode(connectMode, signal)
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

  /** Cheap liveness probe for the flattened page session (one trivial evaluate). */
  private async sessionAlive(active: ActiveConnection, signal?: AbortSignal): Promise<boolean> {
    try {
      await active.client.send('Runtime.evaluate', { expression: '1', returnByValue: true }, { sessionId: active.sessionId, signal })
      return true
    } catch {
      // Any failure (session not found, crashed target, socket trouble) counts
      // as dead; the recovery path below re-establishes a working session.
      return false
    }
  }

  /** Whether the page target itself still exists (browser-level check, no session needed). */
  private async targetExists(active: ActiveConnection, signal?: AbortSignal): Promise<boolean> {
    try {
      const info = await active.client.send('Target.getTargetInfo', { targetId: active.targetId }, { signal }) as { targetInfo?: { targetId?: string } }
      return info.targetInfo?.targetId === active.targetId
    } catch {
      return false
    }
  }

  /**
   * Replace a dead page session: re-attach to the same target while it still
   * exists (a session-only death), otherwise open a fresh page target on the
   * same browser connection. The old connection's event listeners stay wired
   * but only ever observe its dead session id, so recovery never leaks live
   * duplicates; the browser-level connection (and a reused Chrome) survives.
   */
  private async recoverPageTarget(active: ActiveConnection, signal?: AbortSignal): Promise<ActiveConnection> {
    for (const off of active.listeners) off()
    const sameTarget = (await this.targetExists(active, signal).catch(() => false)) ? active.targetId : undefined
    this.state = { kind: 'connected-browser', client: active.client, endpoint: active.endpoint, browser: active.browser, launched: active.launched }
    const fresh = await this.createTargetOnClient(active.client, { endpoint: active.endpoint, browser: active.browser, launched: active.launched }, signal, sameTarget)
    this.state = { kind: 'connected', active: fresh }
    return fresh
  }

  /**
   * Ensure a live connection using an explicit strategy and report what is
   * now driving the tools. This is the model-facing `chrome_connect` surface:
   * the agent chooses whether to reuse the instance already listening on the
   * debugger port or to force a fresh managed launch.
   *
   * @param mode - `"auto"` attaches when an instance already listens on the
   * debugger port and launches otherwise; `"reuse"` attaches only (fails when
   * nothing is listening); `"launch"` replaces the current connection with a
   * fresh managed instance — a connection this runtime owns is closed (and
   * its Chrome killed) first, and when the port is still served by an
   * instance this runtime does not own, the `occupiedPortPolicy` setting
   * decides (read live): "reuse" attaches to the served instance, "refuse"
   * fails with a `CHROME_LAUNCH_FAILED` error.
   * @param signal - optional cancellation for the connect/attach handshake.
   */
  async ensureConnection(mode: ChromeConnectMode = 'auto', signal?: AbortSignal): Promise<ChromeConnectionInfo> {
    if (this.state.kind === 'disposed') {
      throw new ChromeError('Chrome runtime has been disposed', 'CHROME_CDP_ERROR')
    }
    if (mode === 'launch') {
      // "launch" means a fresh managed instance: drop any existing connection
      // first (owned child killed, port freed). A reused instance is only
      // detached — it keeps serving the port, so the launch below fails with
      // a clear "already serving" error instead of a doomed spawn.
      await this.closeBrowser()
    }
    const active = await this.ensure(signal, mode)
    return {
      connected: active.launched !== undefined ? 'launched' : 'attached',
      endpoint: active.endpoint,
      browser: active.browser,
      targetId: active.targetId,
    }
  }

  /**
   * Re-apply the connection-scoped live settings onto the active browser:
   * the download redirect directory and the observatory ring capacity. The
   * plugin's `loader/volatile-update` listener calls this after a settings
   * edit, so the change reaches the running connection immediately instead of
   * waiting for the next connect. All other live fields (timeouts, dialog
   * policy, caps) are read at use time and need no re-application.
   */
  applyLiveSettings(): void {
    if (this.state.kind !== 'connected' && this.state.kind !== 'connected-browser') return
    // Re-send the download redirect (browser-level setting): a changed
    // downloadDir takes effect on the running session, and clearing it
    // restores default handling.
    const downloadDir = this.config.downloadDir()
    const client = this.state.kind === 'connected' ? this.state.active.client : this.state.client
    void client.send('Browser.setDownloadBehavior', downloadDir !== undefined
      ? { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true }
      : { behavior: 'default', eventsEnabled: true },
    ).catch(() => undefined)
    // Resize the live observatory ring; eviction follows the new capacity.
    // (Only a fully connected page target owns an observatory.)
    if (this.state.kind === 'connected') {
      this.state.active.observatory.resize(this.config.observatoryMaxEntries())
    }
  }

  /** Whether the currently connected browser is a child process this runtime owns. False when idle or attached to a reused instance. */
  get ownsBrowserProcess(): boolean {
    if (this.state.kind === 'connected') return this.state.active.launched !== undefined
    if (this.state.kind === 'connected-browser') return this.state.launched !== undefined
    return false
  }

  /**
   * Open the browser connection and attach to a page target, following the
   * requested strategy. Attach paths (existing endpoint on the configured
   * port, or `cdpUrl`) spawn nothing and own no child; the launch path spawns
   * a managed Chrome the runtime tears down on dispose.
   */
  private async connectWithMode(mode: ChromeConnectMode, signal?: AbortSignal): Promise<ActiveConnection> {
    if (!this.config.launch) {
      if (mode === 'launch') {
        throw new ChromeError('managed launch is disabled by config ("launch": false); attach to "cdpUrl" instead', 'CHROME_CDP_ERROR')
      }
      const endpoint = this.config.cdpUrl
      if (endpoint === undefined || endpoint.length === 0) {
        throw new ChromeError('Chrome connect mode requires a "cdpUrl" (ws:// or http(s):// endpoint)', 'CHROME_ENDPOINT_UNREACHABLE')
      }
      // Chrome ≥111 rejects DevTools HTTP requests whose Host header is not an
      // IP; a `localhost` cdpUrl (especially behind a proxy) trips this, so poll by IP.
      const normalized = normalizeDebugEndpoint(endpoint.replace(/\/$/, ''))
      if (normalized.startsWith('ws://') || normalized.startsWith('wss://')) {
        return this.openClient(normalized, { endpoint: normalized }, signal)
      }
      const version = await fetchVersionInfo(normalized, signal)
      return this.openClient(version.webSocketDebuggerUrl, { endpoint: normalized, browser: version.Browser ?? '', client: version.client }, signal)
    }

    const endpoint = normalizeDebugEndpoint(`http://${this.config.host}:${this.config.port}`)
    if (mode === 'launch') {
      return await this.launchFresh(endpoint, signal)
    }

    // Interactive probe: the WS fallback waits for the user to approve the
    // connection, and hands over its already-open one (one prompt).
    const probe = await probeExistingEndpoint(endpoint, signal, { interactive: true })
    if (probe !== undefined) {
      return await this.attachToProbe(endpoint, probe, signal)
    }
    if (mode === 'reuse') {
      throw new ChromeError(
        `no Chrome debugger is listening on ${endpoint}; start Chrome with --remote-debugging-port=${this.config.port} first, or connect with mode "auto" or "launch" to start a managed instance`,
        'CHROME_ENDPOINT_UNREACHABLE',
      )
    }
    return await this.spawnAndAttach(endpoint, signal)
  }

  /** Attach to a probed endpoint: verified adopts the probe's connection; occupied attaches to the browser-level endpoint directly (waiting on the caller's signal — where the user approves). */
  private async attachToProbe(endpoint: string, probe: ChromeVersionInfo | 'occupied', signal?: AbortSignal): Promise<ActiveConnection> {
    if (probe === 'occupied') {
      return await this.openClient(`${endpoint.replace(/^http/i, 'ws')}/devtools/browser`, { endpoint }, signal)
    }
    return await this.openClient(probe.webSocketDebuggerUrl, { endpoint, browser: probe.Browser ?? '', client: probe.client }, signal)
  }

  /** Fresh launch: a free port spawns; an occupied port follows the `occupiedPortPolicy` (reuse the served instance, or refuse) — never a doomed spawn. */
  private async launchFresh(endpoint: string, signal?: AbortSignal): Promise<ActiveConnection> {
    if (!await probeEndpointPresence(endpoint, signal)) return await this.spawnAndAttach(endpoint, signal)
    // The port is served by an instance this runtime does not own. The
    // policy decides (read live): "reuse" attaches to the served instance,
    // "refuse" fails with a clear error. No interactive question.
    if (this.config.occupiedPortPolicy() === 'refuse') {
      throw new ChromeError(
        `a Chrome debug endpoint is already serving ${endpoint}; attach to it with mode "auto" or "reuse", set occupiedPortPolicy to "reuse" to attach automatically, or free the port / pick another "port"`,
        'CHROME_LAUNCH_FAILED',
      )
    }
    const probe = await probeExistingEndpoint(endpoint, signal, { interactive: true })
    if (probe === undefined) {
      throw new ChromeError(`the Chrome debug endpoint at ${endpoint} stopped answering before it could be attached`, 'CHROME_ENDPOINT_UNREACHABLE')
    }
    return await this.attachToProbe(endpoint, probe, signal)
  }

  /** Spawn a managed Chrome and attach to its debug endpoint. */
  private async spawnAndAttach(endpoint: string, signal?: AbortSignal, portOverride?: number): Promise<ActiveConnection> {
    const launched = launchChrome({
      executablePath: this.config.executablePath,
      port: portOverride ?? this.config.port,
      host: this.config.host,
      headless: this.config.headless,
      ...this.config.userDataDir !== undefined ? { userDataDir: this.config.userDataDir } : {},
      extraArgs: this.config.extraArgs,
    })
    try {
      const version = await waitForReady(launched.endpoint, this.config.operationTimeoutMs(), signal, launched)
      return await this.openClient(version.webSocketDebuggerUrl, { endpoint: launched.endpoint, browser: version.Browser ?? '', launched, client: version.client }, signal)
    } catch (error) {
      // waitForReady throws before openClient saw the child — clean it up here.
      if (launched.child !== undefined) await disposeChild(launched.child).catch(() => undefined)
      throw error
    }
  }

  /**
   * Open a browser-level CDP connection and attach to a fresh page target.
   * Shared by every connect path; on failure the socket is closed and the
   * owned child (when any) terminated before the error propagates.
   */
  private async openClient(
    webSocketDebuggerUrl: string,
    info: { endpoint: string; browser?: string; launched?: LaunchedChrome; client?: CdpClient },
    signal?: AbortSignal,
  ): Promise<ActiveConnection> {
    // Adopt a connection the probe already opened (and the user may already
    // have authorized); dial a fresh one only when there is nothing to adopt.
    const client = info.client ?? await createCdpClient(webSocketDebuggerUrl, signal)
    try {
      return await this.createTargetOnClient(client, info, signal)
    } catch (error) {
      await client.close()
      if (info.launched?.child !== undefined) await disposeChild(info.launched.child).catch(() => undefined)
      throw error
    }
  }

  /**
   * Create a fresh page target on an existing browser-level CDP connection and
   * attach via the flattened session protocol. Used by every connect path
   * (first attach) and the `connected-browser` state (after a tab was closed).
   */
  private async createTargetOnClient(
    client: CdpClient,
    info: { endpoint: string; browser?: string; launched?: LaunchedChrome },
    signal?: AbortSignal,
    existingTargetId?: string,
  ): Promise<ActiveConnection> {
    let targetId: string
    if (existingTargetId !== undefined) {
      targetId = existingTargetId
    } else {
      // background: true — the tools drive tabs from behind the scenes; a new
      // tab must never yank the user's current tab out of the foreground.
      const created = await client.send('Target.createTarget', { url: 'about:blank', background: true }, { signal }) as { targetId: string }
      targetId = created.targetId
    }
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }, { signal }) as { sessionId: string }
    const sessionId = attached.sessionId
    const network: NetworkState = { inflight: new Set() }
    const pageRefs = new Map<string, string>()
    const observatory = new Observatory(this.config.observatoryMaxEntries())
    const readCursors = { net: 0, console: 0 }
    // Enable the domains the tools rely on; failures here are infrastructure errors.
    await client.send('Page.enable', undefined, { sessionId, signal })
    await client.send('Runtime.enable', undefined, { sessionId, signal })
    await client.send('Network.enable', undefined, { sessionId, signal })
    // Browser-side log (CSP violations, failed loads); best-effort — old targets may refuse.
    await client.send('Log.enable', undefined, { sessionId, signal }).catch(() => undefined)
    // Compute the full accessibility tree for a11ySnapshot; Chromium builds it
    // lazily and only tracks it while the domain is enabled. Best-effort.
    await client.send('Accessibility.enable', undefined, { sessionId, signal }).catch(() => undefined)
    const listeners = [
      ...this.trackNetwork(client, sessionId, network, observatory),
      ...this.trackConsole(client, sessionId, observatory),
      ...this.trackDialogs(client, sessionId, observatory),
    ]
    // Fresh session: re-arm Fetch interception when mocks are active, so
    // mocks keep working after reconnects and tab switches. Awaited: a
    // fire-and-forget enable races the page's own first requests.
    if (this.netMocks.size > 0) {
      await this.enableMockInterception({ client, sessionId }).catch(() => undefined)
    }
    return { client, targetId, sessionId, endpoint: info.endpoint, browser: info.browser ?? '', launched: info.launched, network, observatory, readCursors, pageRefs, listeners }
  }

  /**
   * Redirect downloads into the configured directory (browser-level setting,
   * applied once per connection when `downloadDir` is set) and record the
   * download lifecycle into the observatory.
   */
  /** Per-client guard so browser-level download listeners are wired once per browser connection. */
  private readonly downloadWiredClients = new WeakSet<object>()

  private setupDownloads(client: CdpClient, observatory: Observatory): void {
    const downloadDir = this.config.downloadDir()
    if (downloadDir !== undefined) {
      void client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
        eventsEnabled: true,
      }).catch((error: unknown) => {
        // Surface a misconfigured downloadDir instead of silently falling back to browser defaults.
        observatory.recordBrowserLog({ level: 'error', text: `Browser.setDownloadBehavior failed: ${error instanceof Error ? error.message : String(error)}`, timestamp: Date.now() })
      })
    }
    // Browser-level events: wire once per client, not per tab switch.
    if (this.downloadWiredClients.has(client)) return
    this.downloadWiredClients.add(client)
    const filenames = new Map<string, string>()
    client.on('Browser.downloadWillBegin', (raw: unknown) => {
      const params = raw as { guid?: string; suggestedFilename?: string; url?: string }
      if (params.guid === undefined) return
      const filename = params.suggestedFilename ?? 'download'
      filenames.set(params.guid, filename)
      const downloadDir = this.config.downloadDir()
      observatory.recordDownload({
        state: 'started',
        filename,
        ...params.url !== undefined ? { url: params.url } : {},
        ...downloadDir !== undefined ? { path: `${downloadDir}/${filename}` } : {},
        timestamp: Date.now(),
      })
    })
    client.on('Browser.downloadProgress', (raw: unknown) => {
      const params = raw as { guid?: string; state?: string; receivedBytes?: number; totalBytes?: number }
      if (params.guid === undefined || params.state === undefined || params.state === 'inProgress') return
      const filename = filenames.get(params.guid) ?? 'download'
      filenames.delete(params.guid)
      const downloadDir = this.config.downloadDir()
      observatory.recordDownload({
        state: params.state === 'completed' ? 'completed' : 'canceled',
        filename,
        ...downloadDir !== undefined ? { path: `${downloadDir}/${filename}` } : {},
        ...params.receivedBytes !== undefined ? { receivedBytes: params.receivedBytes } : {},
        ...params.totalBytes !== undefined ? { totalBytes: params.totalBytes } : {},
        timestamp: Date.now(),
      })
    })
  }

  /**
   * Subscribe to `Page.javascriptDialogOpening` and answer each dialog per
   * the configured policy. An unanswered dialog blocks every tool on the
   * target, so auto-answering is what keeps automation alive; each opening
   * (and how it was answered) is recorded into the observatory.
   */
  private trackDialogs(client: CdpClient, sessionId: string, observatory: Observatory): (() => void)[] {
    // Policy and prompt text resolve per dialog, so a live settings edit
    // applies from the next opening without re-registering the listener.
    const offDialog = client.on('Page.javascriptDialogOpening', (raw: unknown) => {
      const params = raw as { type?: string; message?: string; url?: string }
      const accept = this.config.dialogPolicy() !== 'dismiss'
      const promptText = this.config.dialogPromptText()
      void client.send('Page.handleJavaScriptDialog', {
        accept,
        ...accept && promptText !== undefined ? { promptText } : {},
      }, { sessionId }).catch(() => undefined)
      observatory.recordDialog({
        kind: params.type ?? 'alert',
        message: params.message ?? '',
        ...params.url !== undefined ? { url: params.url } : {},
        response: accept ? 'accepted' : 'dismissed',
        timestamp: Date.now(),
      })
    })
    void sessionId
    return [offDialog]
  }

  /**
   * Subscribe to Network events: keep the `networkidle*` inflight set and
   * record every request into the observatory ring buffers.
   */
  private trackNetwork(client: CdpClient, sessionId: string, network: NetworkState, observatory: Observatory): (() => void)[] {
    const inflight = (params: unknown): string | undefined => (params as { requestId?: string }).requestId
    const onRequest = (raw: unknown): void => {
      const params = raw as {
        requestId?: string
        request?: { url?: string; method?: string }
        type?: string
        redirectCount?: number
        timestamp?: number
        wallTime?: number
      }
      const requestId = inflight(raw)
      if (requestId === undefined) return
      network.inflight.add(requestId)
      observatory.recordRequest({
        requestId,
        url: params.request?.url ?? '',
        method: params.request?.method ?? 'GET',
        timestamp: params.wallTime !== undefined ? params.wallTime * 1000 : params.timestamp !== undefined ? params.timestamp * 1000 : Date.now(),
        ...params.type !== undefined ? { resourceType: params.type } : {},
        ...params.redirectCount !== undefined ? { redirects: params.redirectCount } : {},
      })
    }
    const onResponse = (raw: unknown): void => {
      const params = raw as {
        requestId?: string
        type?: string
        response?: { status?: number; mimeType?: string }
      }
      const requestId = inflight(raw)
      if (requestId === undefined) return
      network.inflight.delete(requestId)
      observatory.recordResponse({
        requestId,
        ...params.response?.status !== undefined ? { status: params.response.status } : {},
        ...params.response?.mimeType !== undefined ? { mimeType: params.response.mimeType } : {},
        ...params.type !== undefined ? { resourceType: params.type } : {},
      })
    }
    const onFinished = (raw: unknown): void => {
      const requestId = inflight(raw)
      if (requestId === undefined) return
      network.inflight.delete(requestId)
    }
    const onFailed = (raw: unknown): void => {
      const params = raw as { requestId?: string; errorText?: string; canceled?: boolean }
      const requestId = params.requestId
      if (requestId === undefined) return
      network.inflight.delete(requestId)
      observatory.recordFailure({
        requestId,
        ...params.errorText !== undefined ? { errorText: params.errorText } : {},
        ...params.canceled !== undefined ? { canceled: params.canceled } : {},
      })
    }
    const disposers = [
      client.on('Network.requestWillBeSent', onRequest),
      client.on('Network.responseReceived', onResponse),
      client.on('Network.loadingFinished', onFinished),
      client.on('Network.loadingFailed', onFailed),
    ]
    void sessionId
    return disposers
  }

  /** Subscribe to Runtime/Log events recording console output and exceptions. */
  private trackConsole(client: CdpClient, sessionId: string, observatory: Observatory): (() => void)[] {
    const offConsole = client.on('Runtime.consoleAPICalled', (raw: unknown) => {
      const params = raw as {
        type?: string
        args?: unknown[]
        timestamp?: number
        stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> }
      }
      if (params.type === undefined) return
      const frame = params.stackTrace?.callFrames?.[0]
      observatory.recordConsole({
        type: params.type,
        args: params.args ?? [],
        timestamp: params.timestamp !== undefined ? params.timestamp * 1000 : Date.now(),
        ...frame?.url !== undefined ? { url: frame.url } : {},
        ...frame?.lineNumber !== undefined ? { lineNumber: frame.lineNumber } : {},
      })
    })
    const offException = client.on('Runtime.exceptionThrown', (raw: unknown) => {
      const params = raw as {
        timestamp?: number
        exceptionDetails?: {
          text: string
          exception?: { description?: string }
          url?: string
          lineNumber?: number
        }
      }
      const details = params.exceptionDetails
      if (details === undefined) return
      observatory.recordException({
        text: details.text,
        ...details.exception?.description !== undefined ? { description: details.exception.description } : {},
        timestamp: params.timestamp !== undefined ? params.timestamp * 1000 : Date.now(),
        ...details.url !== undefined ? { url: details.url } : {},
        ...details.lineNumber !== undefined ? { lineNumber: details.lineNumber } : {},
      })
    })
    const offLog = client.on('Log.entryAdded', (raw: unknown) => {
      const entry = (raw as { entry?: { level?: string; text?: string; timestamp?: number; url?: string; lineNumber?: number } }).entry
      if (entry?.text === undefined) return
      observatory.recordBrowserLog({
        level: entry.level ?? 'info',
        text: entry.text,
        timestamp: entry.timestamp !== undefined ? entry.timestamp * 1000 : Date.now(),
        ...entry.url !== undefined ? { url: entry.url } : {},
        ...entry.lineNumber !== undefined ? { lineNumber: entry.lineNumber } : {},
      })
    })
    void sessionId
    return [offConsole, offException, offLog]
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
      await waiter.wait(this.config.operationTimeoutMs(), signal)
    } catch (error) {
      if (error instanceof ChromeError && error.code === 'CHROME_TIMEOUT') {
        throw new ChromeError(
          `navigation to ${url} timed out after ${this.config.operationTimeoutMs()} ms waiting for "${waitUntil}"; `
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
    // Chrome (≥154 observed) does not synthesize the `click` event unless the
    // press/release pair uses minimal parameters: any preceding mouseMoved, or
    // extra fields like pointerType/buttons, downgrades the sequence to
    // mousedown/mouseup only and inline onclick never fires. Keep the raw
    // minimal pair — verified against Chrome 154 event logs.
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
   * List captured network requests. Marks everything returned as "seen" for
   * the auto-hint cursors, so follow-up calls only surface new activity.
   */
  async netList(options?: {
    failedOnly?: boolean
    maxEntries?: number
    signal?: AbortSignal
  }): Promise<NetListResult> {
    const active = await this.ensure(options?.signal)
    const result = active.observatory.netSince({
      ...options?.failedOnly === true ? { failedOnly: true } : {},
      ...options?.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {},
    })
    const newest = result.entries[result.entries.length - 1]
    if (newest !== undefined) active.readCursors.net = Math.max(active.readCursors.net, newest.seq + 1)
    return result
  }

  /**
   * Read one captured response body via `Network.getResponseBody`. Bodies are
   * evicted by Chrome as loading proceeds, so a miss is reported as a
   * recoverable hint rather than a hard failure.
   */
  async netBody(requestId: string, options?: { maxChars?: number; signal?: AbortSignal }): Promise<{ body: string; truncated: boolean; mimeType?: string; status?: number }> {
    if (requestId.trim().length === 0) {
      throw new ChromeError('netBody requires the requestId from chrome_net_list', 'CHROME_CDP_ERROR')
    }
    const active = await this.ensure(options?.signal)
    const entry = active.observatory.netEntry(requestId)
    let response: { body?: string; base64Encoded?: boolean }
    try {
      response = await active.client.send('Network.getResponseBody', { requestId }, {
        sessionId: active.sessionId, signal: options?.signal,
      }) as { body?: string; base64Encoded?: boolean }
    } catch (error) {
      throw new ChromeError(
        `response body for ${requestId} is no longer available (Chrome evicts bodies as the page proceeds — list again and fetch promptly): ${(error as Error).message}`,
        'CHROME_CDP_ERROR',
        { cause: error },
      )
    }
    if (typeof response.body !== 'string') {
      throw new ChromeError(`response body for ${requestId} came back empty`, 'CHROME_CDP_ERROR')
    }
    const body = response.base64Encoded === true
      ? Buffer.from(response.body, 'base64').toString('utf-8')
      : response.body
    const maxChars = options?.maxChars ?? DEFAULT_NET_BODY_MAX_CHARS
    return {
      body: body.slice(0, Math.max(0, maxChars)),
      truncated: body.length > maxChars,
      ...entry?.mimeType !== undefined ? { mimeType: entry.mimeType } : {},
      ...entry?.status !== undefined ? { status: entry.status } : {},
    }
  }

  /**
   * Read console entries (console API output, uncaught exceptions, browser
   * log). Advances the unread cursor over the returned entries; pass `all`
   * to dump the entire buffer.
   */
  async consoleRead(options?: {
    minLevel?: ConsoleLevel
    maxEntries?: number
    all?: boolean
    signal?: AbortSignal
  }): Promise<ConsoleReadResult> {
    const active = await this.ensure(options?.signal)
    const result = active.observatory.consoleSince({
      ...options?.minLevel !== undefined ? { minLevel: options.minLevel } : {},
      ...options?.all === true ? { all: true } : {},
      ...options?.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {},
    }, active.readCursors.console)
    active.readCursors.console = result.cursor
    return result
  }

  /**
   * One-line hint about unread page activity (console errors + failed
   * requests) since the model last looked — appended to other tools' output.
   * Does not touch the cursors.
   */
  activityHint(): string {
    if (this.state.kind !== 'connected') return ''
    const { observatory, readCursors } = this.state.active
    return formatActivityHintSafe(observatory.unread(readCursors.net, readCursors.console))
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
      for (const off of active.listeners) off()
      this.state = { kind: 'connected-browser', client: active.client, endpoint: active.endpoint, browser: active.browser, launched: active.launched }
    }
  }

  /**
   * Capture the full accessibility tree, bounded, formatted as an indented
   * role/name/state tree. A semantic read alternative to `pageSnapshot`.
   */
  async a11ySnapshot(maxNodes: number, signal?: AbortSignal): Promise<{
    url: string
    title: string
    readyState: string
    tree: string
    nodeCount: number
    truncated: boolean
  }> {
    const active = await this.ensure(signal)
    const response = await active.client.send('Accessibility.getFullAXTree', undefined, {
      sessionId: active.sessionId, signal,
    }) as { nodes?: RawAxNode[] }
    const nodes = response.nodes ?? []
    const formatted = formatAxTree(nodes, maxNodes)
    const meta = await this.evaluate('JSON.stringify({ url: location.href, title: document.title, readyState: document.readyState })', { signal })
    const parsed = parseJsonString(meta.result) as { url?: string; title?: string; readyState?: string } | undefined
    return {
      url: parsed?.url ?? '',
      title: parsed?.title ?? '',
      readyState: parsed?.readyState ?? '',
      tree: formatted.tree,
      nodeCount: formatted.count,
      truncated: formatted.truncated,
    }
  }

  /**
   * Point a file input at local files via `DOM.setFileInputFiles` — the one
   * form interaction `Input.insertText` cannot perform. Every path must exist
   * and be readable; the element must be an `<input type="file">`.
   */
  async upload(options: {
    selector: string
    paths: readonly string[]
    signal?: AbortSignal
  }): Promise<{ uploaded: boolean; selector: string; fileCount?: number; coveredBy?: string }> {
    if (options.paths.length === 0) {
      throw new ChromeError('upload requires at least one file path', 'CHROME_CDP_ERROR')
    }
    // Fail fast with a readable message when a path does not exist.
    await Promise.all(options.paths.map(async path => {
      try { await fs.access(path, fs.constants.R_OK) } catch {
        throw new ChromeError(`upload file not found or not readable: ${path}`, 'CHROME_CDP_ERROR')
      }
    }))
    const active = await this.ensure(options.signal)
    const { client, sessionId } = active
    // Confirm the selector resolves to a file input before touching the DOM.
    const probe = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); if (!el) return JSON.stringify({ found: false }); const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; let coveredBy = null; const top = document.elementFromPoint(x, y); if (top && top !== el && !el.contains(top) && !top.contains(el)) coveredBy = top.tagName.toLowerCase(); return JSON.stringify({ found: true, type: el instanceof HTMLInputElement ? el.type : String(el.tagName).toLowerCase(), coveredBy }); })()`, { signal: options.signal })
    const info = parseJsonString(probe.result) as { found: boolean; type?: string; coveredBy?: string | null } | undefined
    if (info === undefined || info.found !== true) {
      return { uploaded: false, selector: options.selector }
    }
    if (info.type !== 'file') {
      throw new ChromeError(`element at ${options.selector} is a <${info.type ?? 'unknown'}> input, not a file input`, 'CHROME_CDP_ERROR')
    }
    const document_ = await client.send('DOM.getDocument', { depth: 0 }, {
      sessionId, signal: options.signal,
    }) as { root?: { nodeId?: number } }
    const rootNodeId = document_.root?.nodeId
    if (rootNodeId === undefined) {
      throw new ChromeError('DOM.getDocument returned no root node', 'CHROME_CDP_ERROR')
    }
    const queried = await client.send('DOM.querySelector', { nodeId: rootNodeId, selector: options.selector }, {
      sessionId, signal: options.signal,
    }) as { nodeId?: number }
    if (queried.nodeId === undefined) {
      return { uploaded: false, selector: options.selector }
    }
    await client.send('DOM.setFileInputFiles', {
      files: [...options.paths],
      nodeId: queried.nodeId,
    }, { sessionId, signal: options.signal })
    return {
      uploaded: true,
      selector: options.selector,
      fileCount: options.paths.length,
      ...info.coveredBy !== undefined && info.coveredBy !== null ? { coveredBy: info.coveredBy } : {},
    }
  }

  /**
   * List the browser's page tabs (browser-level `Target.getTargets`, page
   * type only) with `attached` marking the tab the tools currently drive.
   */
  async listTabs(signal?: AbortSignal): Promise<Array<{ index: number; targetId: string; url: string; title: string; attached: boolean }>> {
    const active = await this.ensure(signal)
    const targets = await active.client.send('Target.getTargets', undefined, { signal }) as {
      targetInfos?: Array<{ targetId: string; type: string; url: string; title: string }>
    }
    const pages = (targets.targetInfos ?? []).filter(t => t.type === 'page')
    return pages.map((t, index) => ({
      index,
      targetId: t.targetId,
      url: t.url,
      title: t.title,
      attached: t.targetId === active.targetId,
    }))
  }

  /**
   * Open a new tab (default `about:blank`) and switch the tools to drive it.
   * The tab is created in the background: the user's current tab keeps the
   * foreground and the work happens behind the scenes. The previous tab stays
   * alive in the background.
   */
  async openTab(url: string | undefined, signal?: AbortSignal): Promise<{ targetId: string; url: string; title: string }> {
    const active = await this.ensure(signal)
    const created = await active.client.send('Target.createTarget', {
      url: url !== undefined && url.length > 0 ? url : 'about:blank',
      background: true,
    }, { signal }) as { targetId: string }
    await this.switchToTarget(created.targetId, signal)
    const meta = await this.evaluate('JSON.stringify({ url: location.href, title: document.title })', { signal })
    const parsed = parseJsonString(meta.result) as { url?: string; title?: string } | undefined
    return { targetId: created.targetId, url: parsed?.url ?? url ?? 'about:blank', title: parsed?.title ?? '' }
  }

  /**
   * Switch the tools to drive a different tab, by zero-based list index (as
   * reported by `listTabs`) or by target id. The previously driven tab stays
   * alive; observatory buffers are per-tab, so counts reset on switch.
   */
  async switchTab(options: { index?: number; targetId?: string; signal?: AbortSignal }): Promise<{ targetId: string; url: string; title: string }> {
    const active = await this.ensure(options.signal)
    const targets = await active.client.send('Target.getTargets', undefined, { signal: options.signal }) as {
      targetInfos?: Array<{ targetId: string; type: string; url: string; title: string }>
    }
    const pages = (targets.targetInfos ?? []).filter(t => t.type === 'page')
    let targetId: string | undefined
    if (options.targetId !== undefined && options.targetId.length > 0) {
      targetId = pages.find(t => t.targetId === options.targetId)?.targetId
      if (targetId === undefined) {
        throw new ChromeError(`no page tab with targetId ${options.targetId}`, 'CHROME_CDP_ERROR')
      }
    } else if (options.index !== undefined) {
      const found = pages[options.index]
      if (found === undefined) {
        throw new ChromeError(`no page tab at index ${options.index} (${pages.length} tab(s) open)`, 'CHROME_CDP_ERROR')
      }
      targetId = found.targetId
    } else {
      throw new ChromeError('switchTab requires either index or targetId', 'CHROME_CDP_ERROR')
    }
    if (targetId === active.targetId) {
      const current = pages.find(t => t.targetId === targetId)
      return { targetId, url: current?.url ?? '', title: current?.title ?? '' }
    }
    const info = await this.switchToTarget(targetId, options.signal)
    return { targetId, url: info.url, title: info.title }
  }

  /** Attach to an existing page target and make it the driven tab. */
  private async switchToTarget(targetId: string, signal?: AbortSignal): Promise<{ url: string; title: string }> {
    if (this.state.kind !== 'connected') {
      throw new ChromeError('cannot switch tabs without a live connection', 'CHROME_CDP_ERROR')
    }
    const { client } = this.state.active
    const info = { endpoint: this.state.active.endpoint, browser: this.state.active.browser, launched: this.state.active.launched }
    const attached = await this.createTargetOnClient(client, info, signal, targetId)
    this.state = { kind: 'connected', active: attached }
    const meta = await this.evaluate('JSON.stringify({ url: location.href, title: document.title })', { signal })
    const parsed = parseJsonString(meta.result) as { url?: string; title?: string } | undefined
    return { url: parsed?.url ?? '', title: parsed?.title ?? '' }
  }
  /** Active network mocks for the current connection: URL pattern → canned response. */
  private netMocks = new Map<string, { status: number; body: string; contentType: string }>()

  /**
   * Set one network mock: requests whose URL matches the glob `pattern`
   * (`*` wildcards, CDP `Fetch` interception syntax) are answered with the
   * canned response without touching the network. Overwrites any mock with
   * the same pattern. Requires Fetch interception, enabled lazily and once
   * per connection.
   */
  async netMock(options: {
    pattern: string
    status?: number
    body?: string
    contentType?: string
    signal?: AbortSignal
  }): Promise<{ pattern: string; status: number; mocks: number }> {
    if (options.pattern.trim().length === 0) {
      throw new ChromeError('netMock requires a non-empty URL pattern', 'CHROME_CDP_ERROR')
    }
    const active = await this.ensure(options.signal)
    const entry = {
      status: options.status ?? 200,
      body: options.body ?? '',
      contentType: options.contentType ?? 'text/plain',
    }
    this.netMocks.set(options.pattern, entry)
    await this.enableMockInterception(active)
    return { pattern: options.pattern, status: entry.status, mocks: this.netMocks.size }
  }

  /** Clear all network mocks (and stop interception on the current session). */
  async netMockClear(signal?: AbortSignal): Promise<{ cleared: number }> {
    const cleared = this.netMocks.size
    this.netMocks.clear()
    // Stop events on the live session when there is one (a clear with no
    // connection is still a valid local-table reset); the per-client handler
    // stays wired (it only acts on live mocks), so a later netMock() re-enables cleanly.
    if (this.state.kind === 'connected' && !this.state.active.client.isClosed) {
      const { client, sessionId } = this.state.active
      await client.send('Fetch.disable', undefined, { sessionId, signal }).catch(() => undefined)
    }
    return { cleared }
  }

  /** Per-client guard so the requestPaused handler is wired exactly once per browser connection. */
  private readonly mockWiredClients = new WeakSet<object>()

  /**
   * Enable Fetch interception for THIS session when mocks are active, and
   * wire the requestPaused handler once per browser client. Per-session
   * enabling (instead of a runtime-level flag) keeps mocks working after
   * reconnects and tab switches, where a fresh session needs its own
   * Fetch.enable; responses answer on the event's own session.
   */
  private async enableMockInterception(active: Pick<ActiveConnection, 'client' | 'sessionId'>): Promise<void> {
    if (this.netMocks.size === 0) return
    const { client, sessionId } = active
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, { sessionId })
    if (this.mockWiredClients.has(client)) return
    this.mockWiredClients.add(client)
    client.on('Fetch.requestPaused', async (raw: unknown, eventSessionId?: string) => {
      const params = raw as { requestId?: string; request?: { url?: string } }
      const url = params.request?.url ?? ''
      const matched = [...this.netMocks.entries()].find(([pattern]) => urlMatchesGlob(url, pattern))
      const respondOpts = { sessionId: eventSessionId }
      if (matched === undefined || params.requestId === undefined) {
        // Not mocked: continue the request untouched.
        void client.send('Fetch.continueRequest', { requestId: params.requestId }, respondOpts).catch(() => undefined)
        return
      }
      const mock = matched[1]
      // Always include a permissive CORS header: mocked responses are for
      // the model's testing, and a cross-origin page fetch must not fail in
      // the CORS layer after the interception already succeeded.
      void client.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: mock.status,
        body: Buffer.from(mock.body, 'utf-8').toString('base64'),
        responseHeaders: [
          { name: 'Content-Type', value: mock.contentType },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
      }, respondOpts).catch(() => undefined)
    })
  }

  /**
   * One storage operation: browser cookies (via the Network domain, scoped to
   * the current page's URL unless `url` is given) or the current origin's
   * localStorage / sessionStorage (via the page).
   */
  async storage(options: {
    kind: 'cookies' | 'local' | 'session'
    operation: 'get' | 'set' | 'remove' | 'clear'
    key?: string
    value?: string
    url?: string
    maxChars?: number
    signal?: AbortSignal
  }): Promise<{ result: unknown }> {
    const active = await this.ensure(options.signal)
    const { client, sessionId } = active
    if (options.kind === 'cookies') {
      switch (options.operation) {
        case 'get': {
          const cookies = await client.send('Network.getCookies', {
            ...options.url !== undefined && options.url.length > 0 ? { urls: [options.url] } : {},
          }, { sessionId, signal: options.signal }) as { cookies?: unknown }
          return { result: cookies.cookies ?? [] }
        }
        case 'set': {
          if (options.key === undefined || options.key.length === 0 || options.value === undefined) {
            throw new ChromeError('cookie "set" requires both key (name) and value', 'CHROME_CDP_ERROR')
          }
          const pageUrl = await this.evaluate('location.href', { signal: options.signal })
          const set = await client.send('Network.setCookie', {
            name: options.key,
            value: options.value,
            url: options.url ?? (typeof pageUrl.result === 'string' ? pageUrl.result : undefined),
          }, { sessionId, signal: options.signal }) as { success?: boolean }
          if (set.success === false) {
            throw new ChromeError(`setting cookie "${options.key}" failed (check the URL/path scope)`, 'CHROME_CDP_ERROR')
          }
          return { result: { ok: true, name: options.key } }
        }
        case 'remove': {
          if (options.key === undefined || options.key.length === 0) {
            throw new ChromeError('cookie "remove" requires key (name)', 'CHROME_CDP_ERROR')
          }
          // Network.deleteCookies requires url or domain; default to the
          // current page's URL so removal is scoped like "set" is.
          let removalUrl = options.url
          if (removalUrl === undefined || removalUrl.length === 0) {
            const pageUrl = await this.evaluate('location.href', { signal: options.signal })
            if (typeof pageUrl.result === 'string') removalUrl = pageUrl.result
          }
          await client.send('Network.deleteCookies', {
            name: options.key,
            ...removalUrl !== undefined ? { url: removalUrl } : {},
          }, { sessionId, signal: options.signal })
          return { result: { ok: true, name: options.key } }
        }
        case 'clear': {
          await client.send('Network.clearBrowserCookies', undefined, { sessionId, signal: options.signal })
          return { result: { ok: true, cleared: 'all cookies' } }
        }
      }
    }
    // Web storage via the page.
    switch (options.operation) {
      case 'get': {
        const expression = storageReadExpression(options.kind, options.key, options.maxChars ?? DEFAULT_STORAGE_VALUE_MAX_CHARS)
        const evaluation = await active.client.send('Runtime.evaluate', {
          expression, awaitPromise: false, returnByValue: true,
        }, { sessionId, signal: options.signal }) as { result?: { value?: string } }
        const parsed = parseJsonString(evaluation.result?.value)
        return { result: parsed ?? {} }
      }
      case 'set': {
        if (options.key === undefined || options.key.length === 0 || options.value === undefined) {
          throw new ChromeError(`web storage "set" requires both key and value`, 'CHROME_CDP_ERROR')
        }
        const expression = storageWriteExpression(options.kind, 'set', options.key, options.value)
        await active.client.send('Runtime.evaluate', {
          expression, awaitPromise: false, returnByValue: true,
        }, { sessionId, signal: options.signal })
        return { result: { ok: true, key: options.key } }
      }
      case 'remove': {
        if (options.key === undefined || options.key.length === 0) {
          throw new ChromeError(`web storage "remove" requires key`, 'CHROME_CDP_ERROR')
        }
        const expression = storageWriteExpression(options.kind, 'remove', options.key, undefined)
        await active.client.send('Runtime.evaluate', {
          expression, awaitPromise: false, returnByValue: true,
        }, { sessionId, signal: options.signal })
        return { result: { ok: true, key: options.key } }
      }
      case 'clear': {
        const expression = storageWriteExpression(options.kind, 'clear', undefined, undefined)
        await active.client.send('Runtime.evaluate', {
          expression, awaitPromise: false, returnByValue: true,
        }, { sessionId, signal: options.signal })
        return { result: { ok: true, cleared: options.kind === 'local' ? 'localStorage' : 'sessionStorage' } }
      }
    }
  }

  /**
   * Apply environment overrides. Every field is independent; omitted fields
   * are left untouched. `clear: true` first resets device metrics,
   * geolocation, and network conditions to defaults (later fields in the same
   * call still apply). Returns the CDP actions performed.
   */
  async emulate(options: {
    clear?: boolean
    width?: number
    height?: number
    deviceScaleFactor?: number
    mobile?: boolean
    network?: 'none' | 'offline' | 'slow3G' | 'fast3G'
    cpuThrottlingRate?: number
    latitude?: number
    longitude?: number
    accuracy?: number
    timezoneId?: string
    locale?: string
    userAgent?: string
    /** Browser permissions to grant (e.g. "geolocation", "clipboard-read", "notifications", "camera"). */
    permissions?: readonly string[]
    /** Reset all granted permissions first. */
    resetPermissions?: boolean
    /** Emulated `prefers-color-scheme`. */
    colorScheme?: 'dark' | 'light'
    /** Emulated `prefers-reduced-motion`. */
    reducedMotion?: 'reduce' | 'no-preference'
    signal?: AbortSignal
  }): Promise<{ applied: readonly string[] }> {
    const active = await this.ensure(options.signal)
    const { client, sessionId } = active
    const signal = options.signal
    const applied: string[] = []
    const send = async (method: string, params?: Record<string, unknown>): Promise<void> => {
      await client.send(method, params, { sessionId, signal })
      applied.push(params === undefined ? method : `${method} ${JSON.stringify(params)}`)
    }
    if (options.clear === true) {
      await send('Emulation.clearDeviceMetricsOverride')
      await send('Emulation.clearGeolocationOverride')
      await send('Emulation.setTimezoneOverride', { timezoneId: '' })
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      await send('Emulation.setCPUThrottlingRate', { rate: 1 })
      await send('Emulation.setUserAgentOverride', { userAgent: '' })
      await send('Emulation.setEmulatedMedia', { features: [] })
      // Browser-domain reset (no sessionId — Browser commands are browser-level).
      await client.send('Browser.resetPermissions', undefined, { signal })
      applied.push('Browser.resetPermissions')
    }
    if (options.resetPermissions === true && options.clear !== true) {
      await client.send('Browser.resetPermissions', undefined, { signal })
      applied.push('Browser.resetPermissions')
    }
    if (options.permissions !== undefined && options.permissions.length > 0) {
      // Browser-domain grant; browser-level send (sessionId would be rejected).
      await client.send('Browser.grantPermissions', {
        permissions: [...options.permissions],
      }, { signal })
      applied.push(`Browser.grantPermissions ${JSON.stringify(options.permissions)}`)
    }
    if (options.colorScheme !== undefined || options.reducedMotion !== undefined) {
      const features: Array<{ name: string; value: string }> = []
      if (options.colorScheme !== undefined) features.push({ name: 'prefers-color-scheme', value: options.colorScheme })
      if (options.reducedMotion !== undefined) features.push({ name: 'prefers-reduced-motion', value: options.reducedMotion })
      await send('Emulation.setEmulatedMedia', { features })
    }
    if (options.width !== undefined || options.height !== undefined || options.deviceScaleFactor !== undefined || options.mobile !== undefined) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: options.width ?? 0,
        height: options.height ?? 0,
        deviceScaleFactor: options.deviceScaleFactor ?? 1,
        mobile: options.mobile ?? false,
      })
    }
    if (options.network !== undefined) {
      await send('Network.emulateNetworkConditions', networkConditions(options.network))
    }
    if (options.cpuThrottlingRate !== undefined) {
      if (!(options.cpuThrottlingRate >= 1)) {
        throw new ChromeError('cpuThrottlingRate must be a number >= 1 (1 = no throttling)', 'CHROME_CDP_ERROR')
      }
      await send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottlingRate })
    }
    if (options.latitude !== undefined || options.longitude !== undefined) {
      await send('Emulation.setGeolocationOverride', {
        latitude: options.latitude ?? 0,
        longitude: options.longitude ?? 0,
        accuracy: options.accuracy ?? 100,
      })
    }
    if (options.timezoneId !== undefined) {
      await send('Emulation.setTimezoneOverride', { timezoneId: options.timezoneId })
    }
    if (options.userAgent !== undefined || options.locale !== undefined) {
      await send('Emulation.setUserAgentOverride', {
        userAgent: options.userAgent ?? '',
        ...options.locale !== undefined ? { acceptLanguage: options.locale } : {},
      })
    }
    return { applied }
  }

  /**
   * Capture the whole page as a single MHTML file (layout + inline resources)
   * via `Page.captureSnapshot` and write it to `path`.
   */
  async mhtml(options: { path: string; signal?: AbortSignal }): Promise<{ path: string; bytes: number }> {
    const active = await this.ensure(options.signal)
    const response = await active.client.send('Page.captureSnapshot', { format: 'mhtml' }, {
      sessionId: active.sessionId, signal: options.signal,
    }) as { data?: string }
    if (typeof response.data !== 'string' || response.data.length === 0) {
      throw new ChromeError('Page.captureSnapshot returned no data', 'CHROME_CDP_ERROR')
    }
    const bytes = Buffer.from(response.data, 'utf-8')
    await fs.mkdir(dirname(options.path), { recursive: true })
    await fs.writeFile(options.path, bytes)
    return { path: options.path, bytes: bytes.length }
  }

  /**
   * Print the page to PDF via `Page.printToPDF` and write it to `path`
   * (created recursively when missing). Returns the file size in bytes.
   */
  async pdf(options: {
    path: string
    landscape?: boolean
    printBackground?: boolean
    paperFormat?: string
    scale?: number
    pageRanges?: string
    signal?: AbortSignal
  }): Promise<{ path: string; bytes: number }> {
    const active = await this.ensure(options.signal)
    const response = await active.client.send('Page.printToPDF', {
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? true,
      ...options.paperFormat !== undefined ? { paperFormat: options.paperFormat } : {},
      ...options.scale !== undefined ? { scale: options.scale } : {},
      ...options.pageRanges !== undefined && options.pageRanges.length > 0 ? { pageRanges: options.pageRanges } : {},
    }, { sessionId: active.sessionId, signal: options.signal }) as { data?: string }
    if (typeof response.data !== 'string' || response.data.length === 0) {
      throw new ChromeError('Page.printToPDF returned no data', 'CHROME_CDP_ERROR')
    }
    const bytes = Buffer.from(response.data, 'base64')
    await fs.mkdir(dirname(options.path), { recursive: true })
    await fs.writeFile(options.path, bytes)
    return { path: options.path, bytes: bytes.length }
  }

  /**
   * Close the entire browser: dispose the CDP connection and kill the child
   * process (when the runtime owns it — a reused instance is only detached).
   * After this, the next tool call re-probes the debugger endpoint (attaching
   * to an instance that is listening again when `reuseExisting` is on) or
   * launches a fresh managed Chrome.
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
    // cancel() rejects this promise on error paths where the caller never
    // awaits it (send failure, errorText) — attach a no-op handler so the
    // rejection never surfaces as an unhandledRejection fatal, while real
    // consumers still receive it through raceWithTimeout.
    promise.catch(() => undefined)
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
        network.timer = setTimeout(resolve, this.config.networkIdleMs())
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

/** Poll a launched Chrome endpoint until ready, surfacing immediate child exit. */
async function waitForReady(endpoint: string, timeoutMs: number, signal: AbortSignal | undefined, launched: LaunchedChrome): Promise<ChromeVersionInfo> {
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
    waitWithRetry(endpoint, timeoutMs, signal),
    exited,
  ])
}

/** Retry `fetchVersionInfo` until success, abort, or the wall-clock budget is exhausted. Each WebSocket fallback dial costs at most 10s, so a count-based loop could otherwise stall for retries × budget — the deadline, not the count, bounds the wait. */
async function waitWithRetry(endpoint: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<ChromeVersionInfo> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    if (signal?.aborted) throw new ChromeError('Chrome endpoint wait aborted', 'CHROME_ABORTED')
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      return await fetchVersionInfo(endpoint, signal, { probeTimeoutMs: Math.min(DEFAULT_WS_PROBE_TIMEOUT_MS, remaining) })
    } catch (error) {
      if (signal?.aborted) throw new ChromeError('Chrome endpoint wait aborted', 'CHROME_ABORTED', { cause: error })
      lastError = error
      const pause = Math.min(100, deadline - Date.now())
      if (pause <= 0) break
      await new Promise<void>(resolve => setTimeout(resolve, pause))
    }
  }
  if (lastError instanceof ChromeError) throw lastError
  throw new ChromeError(`Chrome endpoint at ${endpoint} did not become ready`, 'CHROME_ENDPOINT_UNREACHABLE', { cause: lastError })
}
