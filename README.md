# dsh-chrome

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent model-facing tools to drive a **real Chrome browser** over the **Chrome DevTools Protocol (CDP)**.

9 tools covering navigation, JS execution, page reading, clicking, scrolling, typing, keyboard input, screenshots, and tab/browser lifecycle — a complete browser automation surface for AI agents.

> Authoring follows the DSH [adding-a-tool](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool) and [plugin packaging](https://deepseek-harness.github.io/deepseek-harness/reference/user/develop/basic/publish) guides. Tools are defined with `defineTool`; the Chrome lifecycle lives in a `ctx.chrome` Cordis `Service`.

## Tools

| Tool | What it does | CDP |
|---|---|---|
| `chrome_navigate` | Open a URL, wait for a lifecycle event (`load`/`domcontentloaded`/`networkidle0`/`networkidle2`). Returns final URL + title. | `Page.navigate` |
| `chrome_evaluate` | Evaluate JS, return JSON value. Exceptions returned as `exceptionDetails` (not an error). | `Runtime.evaluate` |
| `chrome_snapshot` | Read rendered `document.body.innerText`, bounded with `truncated` flag. | `Runtime.evaluate` |
| `chrome_click` | Click the center of the first element matching a CSS selector (real mouse events). | `Input.dispatchMouseEvent` |
| `chrome_screenshot` | Capture screenshot, return as image block. **Requires image-capable model.** | `Page.captureScreenshot` |
| `chrome_scroll` | Scroll page by pixel amount or scroll an element into view by selector. | `Runtime.evaluate` |
| `chrome_type` | Type text via real keyboard events (`Input.insertText`). React/Vue/Angular-friendly — unlike `evaluate` + setter hacks. | `Input.insertText` |
| `chrome_press_key` | Press a special key: Enter, Tab, Escape, arrows, F1–F12, etc. | `Input.dispatchKeyEvent` |
| `chrome_close` | Close current tab (`Target.closeTarget`, browser stays alive) or entire browser (kill process). Auto-reconnects on next call. | `Target.closeTarget` / dispose |

Each tool registers a `systemPrompt.section` guidance entry and a UI card presenter.

## Install

### From GitHub

```sh
dsh plugin --profile web add github:gemone/dsh-chrome
```

pnpm ≥10 blocks git-hosted packages' `prepare` scripts by default. On first install, pnpm prints an error with the package key — add it to the profile's `pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - dsh-chrome
```

Then re-run the `add`. This file lives at `$DSH_HOME/profiles/web/pnpm-workspace.yaml`.

> Pin a commit (`github:gemone/dsh-chrome#<sha>`) so a later push cannot change what builds on your machine.

### From a local checkout

```sh
cd dsh-chrome && pnpm install && pnpm build && cd ..
dsh plugin --profile web add ./dsh-chrome
```

Local `add` uses `link:` and does **not** run `prepare`, so you must `pnpm build` first.

### From npm or a tarball

```sh
dsh plugin --profile web add dsh-chrome
dsh plugin --profile web add ./dsh-chrome-0.1.0.tgz
```

No build permission needed — `lib/` is pre-built.

### Verify and boot

```sh
dsh --profile web --dump-config   # a "# == dsh-chrome" layer with the chrome-tool row
dsh --profile web
```

Remove with `dsh plugin --profile web remove dsh-chrome`.

## Configuration

All options live under the `chrome-tool:` section. Every field is optional with sensible defaults.

| Option | Default | Description |
|---|---|---|
| `executablePath` | discovered | Chrome/Chromium path. Env `DSH_CHROME_EXECUTABLE_PATH` → well-known paths → PATH. |
| `launch` | `true` | Launch a managed Chrome. `false` = attach to `cdpUrl`. |
| `cdpUrl` | — | Existing CDP endpoint when `launch: false` (`ws://…` or `http(s)://…`). Required when `launch` is false. |
| `port` | `9222` | Remote debugging port. |
| `host` | `127.0.0.1` | Chrome debug endpoint host. |
| `headless` | `"new"` | `true` (old headless), `"new"`, or `false` (visible window). |
| `userDataDir` | temp dir | Persistent profile directory. |
| `extraArgs` | `[]` | Extra Chrome CLI flags. |
| `operationTimeoutMs` | `30000` | Per-operation timeout (tool `timeoutMs`). |
| `networkIdleMs` | `500` | Quiet window before `networkidle*`. |
| `snapshotMaxChars` | `200000` | Cap on `chrome_snapshot` output. |
| `navigate` / `evaluate` / `snapshot` / `click` / `screenshot` / `scroll` / `type` / `pressKey` / `close` | `true` | Enable/disable individual tools. |

Example profile patch (`cordis.patch.yml`):

```yaml
- id: chrome-tool
  config:
    headless: false           # visible Chrome window
    port: 9333
    snapshotMaxChars: 100000
```

Config edits to `cordis.patch.yml` hot-apply — no profile restart needed (DSH watches the file transactionally).

### Connect to an already-running Chrome

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

```yaml
- id: chrome-tool
  config:
    launch: false
    cdpUrl: "http://127.0.0.1:9222"
```

## Security

Driving a real browser is **shell-equivalent power**: it can reach the local network, run arbitrary page JavaScript, read rendered content, and exfiltrate data. This plugin is **not** a sandbox.

- Prefer headless + ephemeral `userDataDir`. Warn before attaching to a profile with real credentials.
- Enforce allow/ask via `tools/pre-execute` (deployment concern); the plugin registers tools and does not invent policy.
- Chrome is a child process outside any agent sandbox. Only install plugins you trust.

## Architecture

```
src/
├── index.ts          plugin entry: name/inject/Config(schemastery)/apply
├── service.ts        ChromeRuntime Service → ctx.chrome (lifecycle + CDP orchestration)
├── cdp.ts            CDP client over ws (flattened sessions, abort-aware)
├── launcher.ts       executable discovery, Chrome spawn, /json/version polling
├── types.ts          error codes + shared types
└── tools/            9 defineTool consumers
    ├── navigate.ts     chrome_navigate
    ├── evaluate.ts     chrome_evaluate
    ├── snapshot.ts     chrome_snapshot
    ├── click.ts        chrome_click
    ├── screenshot.ts   chrome_screenshot (attachment-gated)
    ├── scroll.ts       chrome_scroll
    ├── type.ts         chrome_type (Input.insertText)
    ├── press-key.ts    chrome_press_key (Input.dispatchKeyEvent)
    └── close.ts        chrome_close (Target.closeTarget / dispose)
```

- **One bundle, provider-shaped seam.** `ChromeRuntime` is `ctx.chrome`; its interface allows a future split into capability seam + provider + consumer (mirroring `ctx.web`).
- **Flattened CDP sessions.** One browser-level WebSocket drives a page target via `Target.attachToTarget({ flatten: true })`.
- **Connected-browser state.** After `closeTab()`, the browser connection stays alive; the next tool call auto-creates a fresh page target — no Chrome restart needed.
- **Lazy, fiber-scoped lifecycle.** Chrome starts on first use; torn down (socket closed, child killed) with the owning plugin fiber. HMR-safe.
- **Caller-signal honored.** Every operation forwards `exec.signal`; cancellation stops the wait, not Chrome.

## Requirements

- DeepSeek Harness `^0.1.0-rc.5`
- Chrome or Chromium on the host (or a reachable CDP endpoint)
- Node ≥20

## Development

```sh
pnpm install
pnpm run typecheck           # tsc --noEmit
pnpm run build               # tsdown → lib/index.js + lib/index.d.ts
pnpm test                    # unit + plugin tests (no Chrome needed)
DSH_CHROME_INTEGRATION=1 pnpm run test:integration  # real headless Chrome
```

## License

MIT
