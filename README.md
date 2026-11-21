# dsh-chrome

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent model-facing tools to drive a **real Chrome browser** over the **Chrome DevTools Protocol (CDP)**.

17 tools covering connection control, navigation, JS execution, page reading (text and structured), clicking, scrolling, typing, keyboard input, screenshots, and tab/browser lifecycle — a complete browser automation surface for AI agents.

> Authoring follows the DSH [adding-a-tool](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool) and [plugin packaging](https://deepseek-harness.github.io/deepseek-harness/reference/user/develop/basic/publish) guides. Tools are defined with `defineTool`; the Chrome lifecycle lives in a `ctx.chrome` Cordis `Service`.

## Tools

| Tool | What it does | CDP |
|---|---|---|
| `chrome_connect` | Ensure a browser connection and report which instance serves it. `mode` chooses the strategy: `"auto"` (default) reuses an instance already listening on the debugger port, launching fresh only when none is; `"reuse"` attaches only to an existing instance; `"launch"` replaces the connection with a fresh managed instance. | `/json/version` probe + `Target.*` |
| `chrome_navigate` | Open a URL, wait for a lifecycle event (`load`/`domcontentloaded`/`networkidle0`/`networkidle2`). Returns final URL + title. | `Page.navigate` |
| `chrome_evaluate` | Evaluate JS, return JSON value. Exceptions returned as `exceptionDetails` (not an error). | `Runtime.evaluate` |
| `chrome_snapshot` | Read the page, bounded: `format: "text"` returns the rendered visible text; `format: "markdown"` converts the page to GitHub-flavored Markdown (headings, links, lists, tables, code blocks). | `Runtime.evaluate` |
| `chrome_page_snapshot` | `use-browser`-style structured read: an element tree (roles, names, states) where every interactive element carries a `[ref=eN]` id. No image support needed. | `Runtime.evaluate` |
| `chrome_click` | Click the center of an element targeted by CSS selector **or `[ref=eN]`** (real mouse events). Reports `coveredBy` when an overlay intercepts the click point. | `Input.dispatchMouseEvent` |
| `chrome_screenshot` | Capture screenshot. Image-capable route → image block; text-only route → described in text by the configured `screenshotAnalysis` model, or refuses with text-only guidance. Full-page captures exceeding the deployment's admission limits (per-side pixels, total pixels) are scaled at capture time instead of being refused. | `Page.captureScreenshot` |
| `chrome_scroll` | Scroll page by pixel amount or scroll an element (selector or ref) into view. | `Runtime.evaluate` |
| `chrome_type` | Type text via real keyboard events (`Input.insertText`), optionally focusing a selector/ref first. React/Vue/Angular-friendly. | `Input.insertText` |
| `chrome_press_key` | Press a special key: Enter, Tab, Escape, arrows, F1–F12, etc. | `Input.dispatchKeyEvent` |
| `chrome_close` | Close current tab (`Target.closeTarget`, browser stays alive) or entire browser. Closing the browser kills the Chrome process the plugin launched; a reused (attached) instance is only detached. Auto-reconnects on next call. | `Target.closeTarget` / dispose |
| `chrome_net_list` | List the network requests the page made since the session connected (URL, method, status, resource type, failures). `failedOnly: true` filters to failures. | `Network.*` events |
| `chrome_net_body` | Read one captured response body by `requestId` (base64-decoded, bounded). Chrome evicts bodies as the page proceeds — fetch promptly. | `Network.getResponseBody` |
| `chrome_console_read` | Read console output: `console.*` calls, uncaught exceptions, browser log entries (CSP, failed loads). `level` filters by severity (default `error`); `all: true` dumps the buffer. | `Runtime`/`Log` events |
| `chrome_emulate` | Override the page environment: viewport/DPR/mobile, network throttling (`offline`/`slow3G`/`fast3G`/`none`), CPU throttling, geolocation, timezone, locale, user-agent. `clear: true` resets first. | `Emulation`/`Network` |
| `chrome_pdf` | Print the page to a PDF file at an absolute path (landscape, printBackground, paperFormat, scale, pageRanges). | `Page.printToPDF` |
| `chrome_storage` | Inspect or change page state: cookies (`kind: "cookies"`, scoped to the current page URL) and localStorage/sessionStorage (`kind: "local"/"session"`, current origin). Operations: get/set/remove/clear. Values are sensitive. | `Network.getCookies` etc. / `Runtime.evaluate` |
| `chrome_upload` | Set local file paths on a file input (`<input type="file">`) by CSS selector or `[ref=eN]` — the one form interaction `chrome_type` cannot do. Every path must exist and be readable. | `DOM.setFileInputFiles` |

`chrome_page_snapshot` accepts `format: "a11y"` to read the page's
accessibility tree instead of the DOM tree (semantic roles, names, and
states; no refs — use it for reading, `dom` for acting).

### Page-activity auto-hints

The observatory (`src/observatory.ts`) ring-buffers network + console activity per
session (500 entries per stream by default). Reading tools (`chrome_navigate`,
`chrome_snapshot`, `chrome_page_snapshot`) append a `[page activity: …]` line
when unread console errors or failed requests exist, so the model discovers
page failures without polling. `chrome_console_read` / `chrome_net_list`
advance the read cursors.

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
dsh plugin --profile web add ./dsh-chrome-0.4.0.tgz
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
| `launch` | `true` | Launch a managed Chrome. `false` = attach to `cdpUrl` only. |
| `cdpUrl` | — | Existing CDP endpoint when `launch: false` (`ws://…` or `http(s)://…`). Required when `launch` is false. |
| `reuseExisting` | `true` | Before launching on `port`, probe the debugger endpoint and **reuse the instance already listening** instead of spawning a second Chrome over the same port. `false` = always launch fresh (the port must be free). The agent can override per call via `chrome_connect`. |
| `dialogPolicy` | `"accept"` | How JS dialogs (`alert`/`confirm`/`prompt`/`beforeunload`) are answered: `"accept"` or `"dismiss"`. Auto-answering keeps the target responsive — an unanswered dialog blocks every tool. Each dialog (and its answer) is recorded into the observatory and surfaced via the `[page activity: …]` hint. |
| `dialogPromptText` | — | Prompt text sent when accepting a `prompt` dialog. |
| `downloadDir` | — | Directory downloads are redirected into (absolute path). Unset = browser default handling. When set, the download lifecycle (started/completed/canceled) is recorded into the observatory and readable via `chrome_console_read`. |
| `port` | `9222` | Remote debugging port. |
| `host` | `127.0.0.1` | Chrome debug endpoint host. |
| `headless` | `"new"` | `true` (old headless), `"new"`, or `false` (visible window). |
| `userDataDir` | temp dir | Persistent profile directory. |
| `extraArgs` | `[]` | Extra Chrome CLI flags. |
| `operationTimeoutMs` | `30000` | Per-operation timeout (tool `timeoutMs`). |
| `networkIdleMs` | `500` | Quiet window before `networkidle*`. |
| `snapshotMaxChars` | `200000` | Cap on `chrome_snapshot` output. |
| `pageSnapshotMaxNodes` | `500` | Cap on `chrome_page_snapshot` tree nodes. |
| `screenshotAnalysis` | — | `{ provider, model, prompt?, maxTokens? }`: an image-capable route that describes screenshots in text when the agent's own route cannot see images. See below. |
| `navigate` / `evaluate` / `snapshot` / `pageSnapshot` / `click` / `screenshot` / `scroll` / `type` / `pressKey` / `close` / `connect` | `true` | Enable/disable individual tools. |

Example profile patch (`cordis.patch.yml`):

```yaml
- id: chrome-tool
  config:
    headless: false           # visible Chrome window
    port: 9333
    snapshotMaxChars: 100000
```

Config edits to `cordis.patch.yml` hot-apply — no profile restart needed (DSH watches the file transactionally).

### Reuse an already-running Chrome (debugger port)

The plugin can attach to a Chrome that is **already** exposing a DevTools
endpoint instead of spawning a second instance over the same port. Start
Chrome with remote debugging:

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

Then just use the plugin with its default config — before launching, the
debugger port (`host` + `port`) is probed via `/json/version`, and an instance
already listening there is reused (attach-only: it is never killed on dispose
or `chrome_close { "what": "browser" }`). Nothing listening → a managed Chrome
launches as before. Set `reuseExisting: false` to always launch fresh.

```yaml
- id: chrome-tool
  config:
    port: 9222               # the port the existing Chrome listens on
    # reuseExisting: true    # default; false restores always-launch
```

#### Letting the agent choose

`chrome_connect` makes the strategy explicit per call:

| `mode` | Behavior |
|---|---|
| `"auto"` (default) | Reuse the instance on the debugger port when one is listening; launch a managed Chrome otherwise. |
| `"reuse"` | Attach only — fails with `CHROME_ENDPOINT_UNREACHABLE` when nothing is listening. |
| `"launch"` | Replace the connection with a fresh managed instance — a connection the plugin owns is closed (its Chrome killed) first; fails with `CHROME_LAUNCH_FAILED` when the port is still served by an instance the plugin does not own. |

The result reports `connected: "attached" | "launched"`, the `endpoint`, the
browser version, and the page `targetId`, so the agent knows whether it is
driving a reused instance or one it owns.

An explicit `cdpUrl` (attach mode) still works exactly as before; in that mode
`chrome_connect { "mode": "launch" }` is refused because the deployment
disabled launching.

```yaml
- id: chrome-tool
  config:
    launch: false
    cdpUrl: "http://127.0.0.1:9222"
```

## Reading the interface without images

Not every route can see images, and screenshots are not the only way to read a
page. The plugin gives a text-only model three interface-acquisition paths,
and can optionally delegate screenshots to a vision model:

1. **`chrome_page_snapshot` (preferred, `use-browser`-style).** One call
   returns the page as a structured element tree — roles, accessible names,
   input values/states — where every interactive element carries a `[ref=eN]`
   id:

   ```
   - heading "Sign in" [ref=e1]
   - textbox "Email" value="" [ref=e2]
   - textbox "Password" [ref=e3]
   - button "Sign in" disabled [ref=e4]
   - link "Forgot password?" href="/reset" [ref=e5]
   ```

   Act on what you saw by ref — `chrome_click { "ref": "e4" }`,
   `chrome_type { "ref": "e2", "text": "a@b.c" }`, `chrome_scroll { "ref": "e1" }`
   — no CSS selector authoring. Refs are invalidated by navigation (and
   reconnection); acting on a stale ref fails with a "take a fresh snapshot"
   error instead of clicking something stale.

2. **`chrome_snapshot` with `format: "markdown"`.** The page converted to
   GitHub-flavored Markdown — headings, links with absolute URLs, emphasis,
   nested lists, fenced code blocks, GFM tables, images. Ideal for archiving a
   page's content or answering "what does this page say" in a form both
   models and humans read naturally. Cross-origin iframes (unreachable from
   the top frame) are emitted as `<!-- iframe: src -->` markers.
   `format: "text"` (the default) returns the plain rendered visible text.

3. **`chrome_evaluate`** — arbitrary DOM queries for anything the structured
   tree does not surface. When an expression returns a non-JSON value (DOM
   node, function), the result hint teaches the `JSON.stringify(...)` idiom.

`chrome_screenshot` tries the image path first: on an image-capable route the
capture enters context as an image block. On a text-only route **with** a
configured `screenshotAnalysis` model, the capture is durably saved and
described in text by that model (steer it per call with the tool's `prompt`
argument). On a text-only route **without** one, it refuses before capturing,
with an error that points at the three text tools above.

```yaml
- id: chrome-tool
  config:
    screenshotAnalysis:
      provider: openai          # any registered provider route
      model: gpt-4o-mini        # any model that declares image input
      # prompt: custom instruction for the description (optional)
      # maxTokens: 1024         # output cap for the description (optional)
```

For the full map of what can fail (launch, endpoint, protocol, page-level,
model-route) and how each failure recovers, see [docs/failure-modes.md](docs/failure-modes.md).

## Security

Driving a real browser is **shell-equivalent power**: it can reach the local network, run arbitrary page JavaScript, read rendered content, and exfiltrate data. This plugin is **not** a sandbox.

- Prefer headless + ephemeral `userDataDir`. Warn before attaching to a profile with real credentials.
- Enforce allow/ask via `tools/pre-execute` (deployment concern); the plugin registers tools and does not invent policy.
- Chrome is a child process outside any agent sandbox. Only install plugins you trust.

## Architecture

```
src/
├── index.ts          plugin entry: name/inject/Config(schemastery)/apply
├── service.ts        ChromeRuntime Service → ctx.chrome (lifecycle + CDP orchestration, attach-or-launch)
├── cdp.ts            CDP client over ws (flattened sessions, abort-aware)
├── launcher.ts       executable discovery, Chrome spawn, /json/version polling + reuse probe
├── page-walker.ts    in-page DOM walker: element tree + [ref=eN] → selector map
├── markdown.ts       in-page DOM→Markdown converter (chrome_snapshot format)
├── analysis.ts       one-shot vision-model call that describes a saved screenshot
├── types.ts          error codes + shared types
└── tools/            17 defineTool consumers
    ├── navigate.ts     chrome_navigate
    ├── evaluate.ts     chrome_evaluate
    ├── snapshot.ts     chrome_snapshot (text)
    ├── page-snapshot.ts chrome_page_snapshot (structured tree + refs)
    ├── click.ts        chrome_click (selector or ref)
    ├── screenshot.ts   chrome_screenshot (image path + analysis path, gated)
    ├── scroll.ts       chrome_scroll (selector or ref)
    ├── type.ts         chrome_type (Input.insertText, focus by selector/ref)
    ├── press-key.ts    chrome_press_key (Input.dispatchKeyEvent)
    ├── ref-target.ts   shared selector/ref argument resolution
    ├── net.ts          chrome_net_list / chrome_net_body (Network events + getResponseBody)
    ├── console.ts      chrome_console_read (Runtime/Log events)
    ├── close.ts        chrome_close (Target.closeTarget / dispose)
    └── connect.ts      chrome_connect (reuse-vs-launch choice)
```

- **One bundle, provider-shaped seam.** `ChromeRuntime` is `ctx.chrome`; its interface allows a future split into capability seam + provider + consumer (mirroring `ctx.web`).
- **Attach-or-launch connect.** Before spawning, the configured debugger port is probed (`/json/version`): an instance already listening is reused — attach-only, never killed by dispose or `chrome_close` — otherwise a managed Chrome launches. `chrome_connect` lets the model pick the strategy explicitly (`auto`/`reuse`/`launch`).
- **Flattened CDP sessions.** One browser-level WebSocket drives a page target via `Target.attachToTarget({ flatten: true })`.
- **Connected-browser state.** After `closeTab()`, the browser connection stays alive; the next tool call auto-creates a fresh page target — no Chrome restart needed.
- **Ephemeral page refs.** `chrome_page_snapshot` keeps a `ref → selector` map inside the runtime; navigation clears it, and ref-based tools fail loudly on stale ids.
- **Lazy, fiber-scoped lifecycle.** Chrome starts on first use; torn down (socket closed, child killed) with the owning plugin fiber. HMR-safe.
- **Caller-signal honored.** Every operation forwards `exec.signal`; cancellation stops the wait, not Chrome.

## Requirements

- DeepSeek Harness `^0.2.0-rc.2` (attachment admission limits and message-source extensibility this plugin builds on)
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
