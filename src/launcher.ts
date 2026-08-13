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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChromeError } from './types.ts'

/** Common executable names searched on PATH (POSIX) when no explicit path is given. */
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
    ...WELL_KNOWN_LOCATIONS,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && isExecutable(candidate)) {
      return candidate
    }
  }
  // POSIX PATH lookup without spawning `which`/`where`: scan $PATH for a known basename.
  if (process.platform !== 'win32') {
    const pathEnv = process.env.PATH
    if (pathEnv !== undefined && pathEnv.length > 0) {
      for (const dir of pathEnv.split(':')) {
        if (dir.length === 0) continue
        for (const name of PATH_CANDIDATES) {
          const candidate = join(dir, name)
          if (isExecutable(candidate)) return candidate
        }
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
  /** `http(s)://host:port` base for `/json/version` discovery. */
  readonly endpoint: string
  /** The spawned child process (absent in connect mode). */
  readonly child?: ChildProcess
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
  // Detach stdio so the child cannot keep the parent event loop alive through inherited pipes.
  child.stdout?.once('data', () => undefined)
  child.stderr?.once('data', () => undefined)

  return { endpoint: `http://${host}:${options.port}`, child }
}

/** `/json/version` payload from a Chrome debugging endpoint. */
export interface ChromeVersionInfo {
  /** Browser-level WebSocket debugger URL. */
  readonly webSocketDebuggerUrl: string
  /** Browser version string. */
  readonly 'Browser'?: string
}

/**
 * Fetch and parse `/json/version` from a Chrome debugging endpoint.
 *
 * @param endpoint - `http(s)://host:port` base URL.
 * @param signal - optional cancellation.
 * @returns the version info including the browser `webSocketDebuggerUrl`.
 */
export async function fetchVersionInfo(endpoint: string, signal?: AbortSignal): Promise<ChromeVersionInfo> {
  let response: Response
  try {
    response = await fetch(`${endpoint}/json/version`, { signal })
  } catch (error) {
    throw new ChromeError(
      `Chrome debugging endpoint at ${endpoint} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      'CHROME_ENDPOINT_UNREACHABLE',
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new ChromeError(
      `Chrome /json/version at ${endpoint} returned HTTP ${response.status}`,
      'CHROME_ENDPOINT_UNREACHABLE',
    )
  }
  const json = await response.json() as Record<string, unknown>
  const webSocketDebuggerUrl = json.webSocketDebuggerUrl
  if (typeof webSocketDebuggerUrl !== 'string' || webSocketDebuggerUrl.length === 0) {
    throw new ChromeError(`Chrome /json/version at ${endpoint} did not return a webSocketDebuggerUrl`, 'CHROME_ENDPOINT_UNREACHABLE')
  }
  return { webSocketDebuggerUrl, ...'Browser' in json ? { Browser: json.Browser as string } : {} }
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
