/**
 * Chrome process lifecycle: discover an executable, launch it with remote
 * debugging enabled, and locate the browser-level CDP endpoint.
 *
 * The plugin owns the Chrome process it launches and tears it down on dispose.
 * In connect mode (`cdpUrl`) it attaches to a Chrome the deployment already
 * runs and spawns nothing.
 * @module dsh-chrome/launcher
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createCdpClient, type CdpClient } from './cdp.ts'
import { ChromeError } from './types.ts'

/** Common executable names searched on PATH when no explicit path is given. */
const PATH_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'] as const

/** Well-known absolute install locations, checked in order. */
const WELL_KNOWN_LOCATIONS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
] as const

/** How many bytes of child output the launch tail keeps for diagnostics. */
const OUTPUT_TAIL_BYTES = 4096

/**
 * Rewrite `localhost` in a debug endpoint to `127.0.0.1`. Chrome ≥111 rejects
 * DevTools HTTP requests whose `Host` header is not an IP or `localhost` is
 * proxied, so always polling by loopback IP avoids the spurious 403.
 *
 * @param endpoint - `http(s)://host:port` base URL.
 * @returns the endpoint with a literal loopback IP host.
 */
export function normalizeDebugEndpoint(endpoint: string): string {
  return endpoint.includes('://localhost:') ? endpoint.replace('://localhost:', '://127.0.0.1:') : endpoint
}

/** Resolve `headless` config to the Chrome `--headless` flag value. */
export function headlessFlag(headless: boolean | 'new'): string {
  if (headless === false) return ''
  if (headless === 'new') return '--headless=new'
  return '--headless'
}

/** Whether a path exists and is executable on this platform. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    try {
      accessSync(path, constants.R_OK)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Discover a Chrome/Chromium executable. Resolution order:
 * explicit `preferred`, then `DSH_CHROME_EXECUTABLE_PATH`, then well-known
 * absolute locations. (PATH lookup via `which` is intentionally best-effort:
 * most deployments pin the absolute path or set the env var.)
 *
 * @param preferred - explicit candidate from plugin config.
 * @returns the resolved absolute path, or `undefined` when nothing usable is found.
 */
export function discoverExecutable(preferred?: string): string | undefined {
  const candidates = [
    preferred,
    process.env.DSH_CHROME_EXECUTABLE_PATH,
    // Per-user Windows install (the machine-wide paths miss it).
    process.env.LOCALAPPDATA !== undefined ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    ...WELL_KNOWN_LOCATIONS,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && isExecutable(candidate)) {
      return candidate
    }
  }
  // PATH lookup without spawning `which`/`where`: scan $PATH for a known
  // basename, honoring the platform separator and Windows' `.exe` suffix.
  const pathEnv = process.env.PATH
  if (pathEnv !== undefined && pathEnv.length > 0) {
    for (const dir of pathEnv.split(delimiter)) {
      if (dir.length === 0) continue
      for (const name of PATH_CANDIDATES) {
        const candidate = join(dir, process.platform === 'win32' ? `${name}.exe` : name)
        if (isExecutable(candidate)) return candidate
      }
    }
  }
  return undefined
}

/** Options for {@link launchChrome}. */
export interface LaunchChromeOptions {
  /** Explicit executable path (else discovered). */
  readonly executablePath?: string
  /** Remote debugging port to open. */
  readonly port: number
  /** Host Chrome binds its debugging endpoint on. */
  readonly host?: string
  /** Headless mode. */
  readonly headless?: boolean | 'new'
  /** Persistent profile directory; a fresh temp dir when omitted. */
  readonly userDataDir?: string
  /** Extra raw CLI flags appended to the Chrome command line. */
  readonly extraArgs?: readonly string[]
}

/** A launched Chrome process plus its CDP discovery URL. */
export interface LaunchedChrome {
  /** `http(s)://host:port` base for `/json/version` discovery (loopback IP host). */
  readonly endpoint: string
  /** The spawned child process (absent in connect mode). */
  readonly child?: ChildProcess
  /**
   * The last few KB of combined child stdout/stderr. Chrome prints the real
   * reason it cannot start (profile locked by another instance, sandbox or
   * `/dev/shm` failures in containers, bad flags) here, so launch failures
   * surface it instead of a bare exit code.
   */
  readonly recentOutput: () => string
}

/** Default per-launch temp profile directory. */
export function defaultUserDataDir(): string {
  return join(tmpdir(), `dsh-chrome-${process.pid}-${Date.now()}`)
}

/**
 * Spawn Chrome with remote debugging enabled. Does NOT wait for the endpoint —
 * callers poll {@link fetchVersionInfo} for the browser `webSocketDebuggerUrl`.
 *
 * @param options - launch parameters.
 * @returns the spawned child and its discovery base URL.
 * @throws {ChromeError} `CHROME_NOT_FOUND` / `CHROME_LAUNCH_FAILED`.
 */
export function launchChrome(options: LaunchChromeOptions): LaunchedChrome {
  const executable = discoverExecutable(options.executablePath)
  if (executable === undefined) {
    throw new ChromeError(
      `no Chrome/Chromium executable found; set config "executablePath" or the DSH_CHROME_EXECUTABLE_PATH environment variable (tried ${WELL_KNOWN_LOCATIONS.length} known locations and PATH)`,
      'CHROME_NOT_FOUND',
    )
  }
  const host = options.host ?? '127.0.0.1'
  const userDataDir = options.userDataDir ?? defaultUserDataDir()
  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-allow-origins=*',
  ]
  const headless = headlessFlag(options.headless ?? 'new')
  if (headless.length > 0) args.push(headless)
  if (options.extraArgs !== undefined) args.push(...options.extraArgs)
  // An empty `about:blank` target keeps the browser alive in headless mode.
  args.push('about:blank')

  let child: ChildProcess
  try {
    child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false, windowsHide: true })
  } catch (error) {
    throw new ChromeError(
      `failed to launch Chrome (${executable}): ${error instanceof Error ? error.message : String(error)}`,
      'CHROME_LAUNCH_FAILED',
      { cause: error },
    )
  }
  // If Chrome dies immediately, surface a clear error rather than timing out.
  child.once('error', () => {
    // The polling loop below will reject; nothing to do here but avoid an unhandled error.
  })
  // Keep a bounded tail of combined output for launch-failure diagnostics, and
  // unref the pipes so they cannot keep the parent event loop alive.
  let outputTail = ''
  const append = (chunk: Buffer | string): void => {
    outputTail = (outputTail + String(chunk)).slice(-OUTPUT_TAIL_BYTES)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  // Typings model child pipes as plain Readables; the underlying handles do
  // support unref, which stops them from keeping the parent loop alive.
  for (const stream of [child.stdout, child.stderr]) {
    (stream as unknown as { unref?: () => void } | null)?.unref?.()
  }

  return {
    endpoint: normalizeDebugEndpoint(`http://${host}:${options.port}`),
    child,
    recentOutput: () => outputTail,
  }
}

/** `/json/version` payload from a Chrome debugging endpoint. `client` rides along when the probe opened the connection itself — adopt it instead of dialing again (on Chrome builds that authorize each debugging connection, a second dial means a second prompt). */
export interface ChromeVersionInfo {
  /** Browser-level WebSocket debugger URL. */
  readonly webSocketDebuggerUrl: string
  /** Browser version string. */
  readonly 'Browser'?: string
  readonly client?: CdpClient
}

/** Thrown when nothing answered at the network level — the endpoint may still be coming up, so callers may retry. */
class RetryableProbeError extends ChromeError {}

/**
 * Fetch and parse `/json/version`. Chrome ≥154 answers a bare 404 for every
 * `/json/*` path (HTTP discovery removed) while the browser-level WebSocket
 * still speaks CDP, so a 404/405 falls back to verifying that endpoint
 * directly.
 *
 * @throws {RetryableProbeError} when nothing answered at the network level —
 * the endpoint may still be coming up, so callers may retry.
 */
export async function fetchVersionInfo(endpoint: string, signal?: AbortSignal, options?: { probeTimeoutMs?: number }): Promise<ChromeVersionInfo> {
  let response: Response
  try {
    response = await fetch(`${endpoint}/json/version`, { signal })
  } catch (error) {
    // Nothing answered HTTP; a debug server shares its port with plain HTTP,
    // so there is nothing to probe over WebSocket either.
    throw new RetryableProbeError(
      `Chrome debugging endpoint at ${endpoint} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      'CHROME_ENDPOINT_UNREACHABLE',
      { cause: error },
    )
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      return await probeOverWebSocket(endpoint, signal, options)
    }
    throw new ChromeError(`Chrome /json/version at ${endpoint} returned HTTP ${response.status}`, 'CHROME_ENDPOINT_UNREACHABLE')
  }
  const json = await response.json() as Record<string, unknown>
  const webSocketDebuggerUrl = json.webSocketDebuggerUrl
  if (typeof webSocketDebuggerUrl !== 'string' || webSocketDebuggerUrl.length === 0) {
    throw new ChromeError(`Chrome /json/version at ${endpoint} did not return a webSocketDebuggerUrl`, 'CHROME_ENDPOINT_UNREACHABLE')
  }
  return { webSocketDebuggerUrl, ...'Browser' in json ? { Browser: json.Browser as string } : {} }
}

/** Budget for one WebSocket fallback dial; `0` (with a signal) waits for that signal alone. */
export const DEFAULT_WS_PROBE_TIMEOUT_MS = 10_000

/**
 * Verify the browser-level CDP WebSocket (`ws://…/devtools/browser`) with one
 * `Browser.getVersion` round-trip. The opened connection rides along in the
 * result so the caller adopts it instead of dialing — and re-authorizing — a
 * second one. `probeTimeoutMs: 0` with a signal means "wait for the signal":
 * the interactive path, where a stalled handshake is Chrome's authorization
 * prompt waiting for the user.
 */
async function probeOverWebSocket(endpoint: string, signal?: AbortSignal, options?: { probeTimeoutMs?: number }): Promise<ChromeVersionInfo> {
  const wsUrl = `${endpoint.replace(/^http/i, 'ws')}/devtools/browser`
  const budgetMs = options?.probeTimeoutMs ?? DEFAULT_WS_PROBE_TIMEOUT_MS
  const interactive = signal !== undefined && budgetMs <= 0
  const budget = interactive ? undefined : AbortSignal.timeout(budgetMs > 0 ? budgetMs : DEFAULT_WS_PROBE_TIMEOUT_MS)
  const probeSignal = budget === undefined ? signal : signal === undefined ? budget : AbortSignal.any([signal, budget])
  const client = await createCdpClient(wsUrl, probeSignal)
  try {
    const { product } = await client.send('Browser.getVersion', {}, { signal: probeSignal }) as { product?: unknown }
    if (typeof product !== 'string' || product.length === 0) {
      throw new ChromeError(`Chrome WebSocket probe at ${wsUrl} answered CDP but reported no product`, 'CHROME_ENDPOINT_UNREACHABLE')
    }
    return { webSocketDebuggerUrl: wsUrl, Browser: product, client }
  } catch (error) {
    client.close()
    if (signal?.aborted) throw error
    if (error instanceof ChromeError && error.code === 'CHROME_ABORTED') {
      // The budget expired, not the caller: say so, and point at the
      // authorization prompt a stalled handshake usually means.
      throw new ChromeError(
        `Chrome WebSocket probe at ${wsUrl} did not answer within ${budgetMs}ms — on Chrome builds that authorize debugging connections, the browser may be waiting for the user to approve`,
        'CHROME_ENDPOINT_UNREACHABLE',
        { cause: error },
      )
    }
    throw error
  }
}

/**
 * Reuse preflight: does a debugger already serve this endpoint? Returns the
 * verified version (with an open connection to adopt when the probe opened
 * one), `'occupied'` when the port answers but CDP is unverified (Chrome ≥154
 * shape — never spawn over it), or `undefined` when nothing listens.
 *
 * `interactive: true` gives the WS dial no budget (wait for the caller's
 * signal — one connection, one authorization prompt). A network-level miss
 * retries once on either path: it never touched the WebSocket, so the retry
 * prompts nothing.
 */
export async function probeExistingEndpoint(
  endpoint: string,
  signal?: AbortSignal,
  options?: { probeTimeoutMs?: number; interactive?: boolean },
): Promise<ChromeVersionInfo | 'occupied' | undefined> {
  const probeOptions = options?.interactive === true ? { ...options, probeTimeoutMs: 0 } : options
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchVersionInfo(endpoint, signal, probeOptions)
    } catch (error) {
      if (signal?.aborted) {
        throw new ChromeError('Chrome endpoint probe aborted', 'CHROME_ABORTED', { cause: error })
      }
      if (error instanceof RetryableProbeError && attempt === 0) {
        // A Chrome still starting binds its debug port late; one short retry
        // buys that window instead of spawning a doomed second Chrome.
        await new Promise<void>(resolve => setTimeout(resolve, 400))
        continue
      }
      if (error instanceof RetryableProbeError) return undefined
      // The port answered HTTP but CDP is unverified — occupied either way.
      return 'occupied'
    }
  }
  return undefined
}

/**
 * Fresh-launch preflight: whether anything serves HTTP on the endpoint,
 * checked without touching the WebSocket (no authorization prompt). Cancellation
 * is rethrown, never mistaken for "the port is free".
 */
export async function probeEndpointPresence(endpoint: string, signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal })
      await response.arrayBuffer().catch(() => undefined)
      return true
    } catch (error) {
      if (signal?.aborted) {
        throw new ChromeError('Chrome endpoint presence probe aborted', 'CHROME_ABORTED', { cause: error })
      }
      if (attempt === 0) await new Promise<void>(resolve => setTimeout(resolve, 400))
    }
  }
  return false
}

/** Reserve one ephemeral TCP port and release it — for launching on a free port when the configured one is occupied. */
export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    const settle = (error: unknown, port?: number): void => {
      server.close(() => (error !== undefined ? reject(error) : resolve(port as number)))
    }
    server.unref()
    server.on('error', error => settle(error))
    server.listen(0, host, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        settle(new ChromeError('could not reserve a free TCP port', 'CHROME_LAUNCH_FAILED'))
        return
      }
      settle(undefined, address.port)
    })
  })
}

/**
 * Poll a Chrome endpoint until `/json/version` responds or the attempt budget
 * is exhausted.
 *
 * @param endpoint - `http(s)://host:port` base URL.
 * @param options - retry budget and cancellation.
 * @returns the resolved version info.
 */
export async function waitForEndpoint(
  endpoint: string,
  options?: { readonly retries?: number; readonly intervalMs?: number; readonly signal?: AbortSignal },
): Promise<ChromeVersionInfo> {
  const retries = options?.retries ?? 50
  const intervalMs = options?.intervalMs ?? 100
  let lastError: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    if (options?.signal?.aborted) {
      throw new ChromeError('Chrome endpoint wait aborted', 'CHROME_ABORTED')
    }
    try {
      return await fetchVersionInfo(endpoint, options?.signal)
    } catch (error) {
      lastError = error
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, intervalMs)
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
    }
  }
  if (lastError instanceof ChromeError) throw lastError
  throw new ChromeError(`Chrome endpoint at ${endpoint} did not become ready`, 'CHROME_ENDPOINT_UNREACHABLE', { cause: lastError })
}

/**
 * Terminate a launched Chrome child gracefully, then force-kill if it lingers.
 * Safe to call after the child has already exited.
 *
 * @param child - the spawned Chrome process.
 */
export async function disposeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => resolve())
  })
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }
  const forceKill = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }, 2_000)
  try {
    await Promise.race([
      exited,
      new Promise<void>(resolve => setTimeout(resolve, 5_000)),
    ])
  } finally {
    clearTimeout(forceKill)
  }
}
