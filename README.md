# dsh-chrome

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent model-facing tools to drive a **real Chrome browser** over the **Chrome DevTools Protocol (CDP)**: navigate, evaluate JavaScript, read rendered page text, click elements, and capture screenshots the model can *see*.

It is an installable **bundle** — one `dsh plugin add` adds it to any DSH profile (`web`, `headless`, or a custom one).

> Authoring follows the DSH [adding-a-tool](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool) and [plugin packaging](https://deepseek-harness.github.io/deepseek-harness/reference/user/develop/basic/publish) guides. Tools are defined with `defineTool`; the Chrome lifecycle lives in a `ctx.chrome` Cordis `Service`.

## Tools

| Tool | What it does |
|---|---|
| `chrome_navigate` | Open a URL in the controlled Chrome and wait for a lifecycle event (`load`, `domcontentloaded`, `networkidle0`, `networkidle2`). Returns the final URL and page title. |
| `chrome_evaluate` | Evaluate a JavaScript expression in the page and return its JSON value. A thrown exception is returned as `exceptionDetails` (a successful result), not an error. |
| `chrome_snapshot` | Read the rendered visible text of the page body (`document.body.innerText`), bounded with a `truncated` flag. |
| `chrome_click` | Click the center of the first element matching a CSS selector (dispatches a real mouse event). |
| `chrome_screenshot` | Capture a screenshot and return it as an image block. **Requires an image-capable model route** and the attachment service (same gate as `read_image`). |

Each tool registers a `systemPrompt.section` guidance entry and a UI card presenter.

## Install

Pick the form that matches how you distribute the package.

### From a local checkout

```sh
dsh plugin --profile web add ./dsh-chrome
```

### From GitHub

A git install fetches sources, so the package's `prepare` script builds `lib/` on install. pnpm ≥10 blocks that build until you allow it — copy the package key pnpm prints into the profile's `pnpm-workspace.yaml` and re-run:

```yaml
allowBuilds:
  dsh-chrome: true
```

```sh
dsh plugin --profile web add github:<you>/dsh-chrome
```

> Pin a commit (`github:<you>/dsh-chrome#<sha>`) so a later push cannot change what builds on your machine.

### From npm or a tarball (no build permission needed)

```sh
dsh plugin --profile web add dsh-chrome            # published package
dsh plugin --profile web add ./dsh-chrome-0.1.0.tgz # from pnpm pack
```

### Verify and boot

```sh
dsh --profile web --dump-config   # a "# == dsh-chrome" layer with the chrome-tool row
dsh --profile web
```

Then, in the Web UI, prompt: *"Use chrome_navigate to open example.com, then chrome_snapshot to read it, then chrome_screenshot."*

Remove with `dsh plugin --profile web remove dsh-chrome`.

## Configuration

All options have defaults and live under the `chrome-tool:` profile/config section. Every field is optional.

| Option | Default | Description |
|---|---|---|
| `executablePath` | discovered | Chrome/Chromium path. Falls back to `DSH_CHROME_EXECUTABLE_PATH`, then well-known locations, then PATH. |
| `launch` | `true` | Launch a managed Chrome. `false` = attach to `cdpUrl`. |
| `cdpUrl` | — | Existing endpoint to attach to when `launch: false` (`ws://…` or `http(s)://host:port`). **Required** when `launch` is false. |
| `port` | `9222` | Remote debugging port for a launched Chrome. |
| `host` | `127.0.0.1` | Host a launched Chrome binds its endpoint on. |
| `headless` | `"new"` | `true` (old headless), `"new"`, or `false`. |
| `userDataDir` | temp dir | Persistent profile directory. |
| `extraArgs` | `[]` | Extra raw Chrome CLI flags. |
| `operationTimeoutMs` | `30000` | Per-operation cooperative timeout (also the tool `timeoutMs`). |
| `networkIdleMs` | `500` | Quiet window before `networkidle*` is declared. |
| `snapshotMaxChars` | `200000` | Cap on `chrome_snapshot` output. |
| `navigate` / `evaluate` / `snapshot` / `click` / `screenshot` | `true` | Register only the tools you want. |

Example profile patch (`cordis.patch.yml`):

```yaml
- id: chrome-tool
  config:
    port: 9333
    headless: "new"
    snapshotMaxChars: 100000
```

### Connect to an already-running Chrome

Launch Chrome yourself with debugging on:

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

then configure:

```yaml
- id: chrome-tool
  config:
    launch: false
    cdpUrl: "http://127.0.0.1:9222"
```

## Security

Driving a real browser is **shell-equivalent power**: it can reach the local network, run arbitrary page JavaScript, read rendered content, and exfiltrate data. This plugin is **not** a sandbox.

- Prefer a headless managed Chrome with an ephemeral `userDataDir`. Warn users before attaching to a long-lived profile that holds real credentials/cookies.
- Enforce allow/ask policy with a `tools/pre-execute` listener (a deployment concern); the plugin registers tools and does not invent policy.
- Chrome is launched as a child process on the host — outside any agent sandbox. Only install plugins whose source you trust.

## Architecture

```
src/
├── index.ts        plugin entry: name/inject/Config(schemastery)/apply
├── service.ts      ChromeRuntime extends Service → ctx.chrome (lifecycle + CDP orchestration)
├── cdp.ts          minimal CDP client over ws (flattened sessions, abort-aware)
├── launcher.ts     executable discovery, Chrome spawn, /json/version polling
├── types.ts        error codes + shared types
└── tools/          navigate · evaluate · snapshot · click · screenshot (each defineTool)
```

- **One bundle, layered internally.** `ChromeRuntime` is the seam: its interface is provider-shaped, so a future split into a capability seam (`dsh-chrome`) + provider (`dsh-chrome-local`) + tool consumer (`dsh-tool-chrome`) — mirroring the `ctx.web` trio — is a refactor, not a redesign.
- **Flattened CDP sessions.** One browser-level WebSocket drives a dedicated page target via `Target.attachToTarget({ flatten: true })`; commands and events carry a `sessionId`.
- **Lazy, fiber-scoped lifecycle.** Chrome starts on first use and is torn down (socket closed, child killed) with the owning plugin fiber — HMR-safe.
- **Caller-signal honored.** Each operation forwards the tool's `exec.signal`; cancellation stops the wait, not the managed Chrome's lifetime.

## Requirements

- DeepSeek Harness `^0.1.0-rc.5` (provides `tools`, `systemPrompt`, `attachments`, `llm` in the default `web` profile).
- Chrome or Chromium installed on the host (or a reachable CDP endpoint).
- Node `>=20`.

## Development

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run build       # tsdown → lib/index.js + lib/index.d.ts
pnpm test            # unit tests (mocked CDP transport)
DSH_CHROME_INTEGRATION=1 pnpm run test:integration   # launches a real headless Chrome
```

Unit tests use an in-memory CDP peer (no Chrome needed). Integration tests launch a real headless Chrome against a local fixture page and are skipped unless `DSH_CHROME_INTEGRATION=1` and a Chrome is discoverable.

## Known limitations / future work

- **Connect-only backends.** A cloud/browserless provider would slot behind the same `ctx.chrome` seam.
- **Screenshot file fallback.** `chrome_screenshot` requires the attachment service; a file-output fallback is deferred.
- **No `chrome_pdf` / `chrome_fill` / network HAR capture yet** — straightforward to add over the existing `cdp` passthrough.
- **Single shared page target.** Multi-tab/multi-session isolation is not modeled; one target serves all calls.

## License

MIT
