# Chrome tool failure modes and recovery

`dsh-chrome` drives a real Chrome over CDP, so it inherits every way a browser
process, a WebSocket, a web page, and a model route can fail. Each entry below
maps a failure to its cause and states what the plugin **already does about
it in code** versus what remains a deployment/environment action. Items marked
**[fixed]** need no operator intervention; **[diagnosed]** ones cannot be
solved from inside the plugin, but the error carries the real cause (not a
bare timeout) so the fix is one step away.

## 1. Environment / launch failures

| Error | Cause | Plugin behavior | Operator action when it still fails |
|---|---|---|---|
| `CHROME_NOT_FOUND` | No Chrome/Chromium found. | **[fixed]** Discovery scans config → `DSH_CHROME_EXECUTABLE_PATH` → well-known paths (incl. per-user Windows `LOCALAPPDATA`) → full `PATH` scan honoring the platform separator and Windows `.exe` suffixes. | Install Chrome/Chromium or set `executablePath`. |
| `CHROME_LAUNCH_FAILED` … `last output: …` | Chrome dies at startup: profile locked, sandbox/`/dev/shm` failure in containers, bad flag, missing libs. | **[fixed]** The child's combined stdout/stderr tail rides the error (Node may emit `exit` before stdio flushes, so the rejection drains briefly first). Known signatures get an explicit hint: `SingletonLock` → "another Chrome is using this userDataDir"; sandbox/namespace errors → suggest `--no-sandbox`, `--disable-dev-shm-usage`. | Follow the printed hint (separate `userDataDir`, container flags, remove the bad flag). |
| `CHROME_LAUNCH_FAILED` (spawn throw) | Executable exists but is not spawnable (wrong arch, no exec bit). | **[diagnosed]** The spawn error text names the executable. | Install a matching Chrome build. |

## 2. Endpoint / connection failures

| Error | Cause | Plugin behavior | Operator action |
|---|---|---|---|
| `CHROME_ENDPOINT_UNREACHABLE` | Slow endpoint open; wrong `host`/`port`; port owned by another process. | **[fixed]** Launch polls `/json/version` with a budget derived from `operationTimeoutMs`; a busy/occupied port surfaces via the child-exit path with output. | Align `host`/`port`; free the port. |
| HTTP 403 from `/json/version` | Chrome ≥111 rejects DevTools requests whose `Host` header is not an IP (proxying `localhost`). | **[fixed]** `localhost` is rewritten to `127.0.0.1` in every debug endpoint — the launched endpoint, `cdpUrl` HTTP discovery, and `ws://` URLs alike. | — |
| No `webSocketDebuggerUrl` | Target Chrome has no debugging port, or the URL points at a page endpoint. | **[diagnosed]** Distinct error names the endpoint. | Launch Chrome with `--remote-debugging-port`, or point `cdpUrl` at the browser-level `ws://…/devtools/browser/<id>`. |
| `CDP socket closed` / connect failed | Browser crashed, remote Chrome restarted, too many clients. | **[fixed]** A dead socket is detected lazily and the next tool call reconnects (launch mode respawns Chrome). Refs from `chrome_page_snapshot` are dropped on reconnection by design. | Retry; take a fresh `chrome_page_snapshot` before acting by ref. |

## 3. Page / protocol failures during tool calls

| Where | Symptom | Plugin behavior | Operator/model action |
|---|---|---|---|
| `chrome_navigate` | `net::ERR_…` | **[diagnosed]** Chrome's own error text is surfaced with a reminder that DNS/TLS resolve from the Chrome host, which can differ from the harness host. | Fix URL/scheme; verify from the Chrome host. |
| `chrome_navigate` | `CHROME_TIMEOUT` | **[fixed]** The timeout names the `waitUntil` mode and explains that `networkidle*` never settles on long-polling/streaming pages; it points at `load`/`domcontentloaded` or raising `operationTimeoutMs`. | Re-navigate with the suggested mode. |
| `chrome_click` | `clicked: false` | **[fixed]** The miss report tells the model to take a `chrome_page_snapshot` and retry by ref (selectors miss shadow roots/typos). | Retry by ref. |
| `chrome_click` | Clicked but nothing happened | **[fixed]** Before dispatching, the click script runs `elementFromPoint` at the target center; if a foreign element (cookie banner, fixed header) intercepts, the result carries `coveredBy` with its description and the render tells the model to dismiss it. Overlay-interception is no longer silent. | Dismiss the overlay, then retry. |
| `chrome_type` | `no element matched …` | **[fixed]** The error names both the ref and its resolved selector and suggests a fresh `chrome_page_snapshot`. | Retry by fresh ref. |
| `chrome_snapshot` / `chrome_page_snapshot` | Empty output | **[fixed]** Both results carry `document.readyState`; empty text renders an explanation distinguishing "still loading" (retry) from "non-HTML document / content in an iframe" (use `chrome_page_snapshot` / `chrome_evaluate`). | Follow the rendered note. |
| `chrome_evaluate` | `result: null` for real values | **[fixed]** When `returnByValue` yields undefined (DOM nodes, functions), the render appends a hint teaching the `JSON.stringify(...)` idiom instead of letting the model believe the page returned null. | Wrap the expression. |
| `chrome_evaluate` | `exceptionDetails` | **[by design]** Page-script exceptions are data, not errors — the text and stack come back in a successful tool result. | Fix the expression. |
| Any tool | `CHROME_ABORTED` | **[by design]** Caller cancellation (user stop, upstream timeout). | Re-issue when appropriate. |
| Any tool | `CHROME_TIMEOUT` mid-call | **[diagnosed]** Cooperative backstop with the configured budget. | Narrow the operation (e.g. `fullPage: false`) or raise `operationTimeoutMs`. |

## 4. Model-route failures (screenshot-specific)

`chrome_screenshot` is the only tool whose result depends on model
capabilities, because an image block in a tool result becomes durable session
history the current route must be able to carry.

| Symptom | Plugin behavior | Action |
|---|---|---|
| Text-only route, no `screenshotAnalysis` configured | **[fixed]** Refuses *before capturing* (no wasted CDP call, no orphan attachment) and the error lists the text-first alternatives: `chrome_page_snapshot` (structured tree + refs), `chrome_snapshot`, `chrome_evaluate`. | Use a text tool, or configure `screenshotAnalysis`. |
| Text-only route, `screenshotAnalysis` configured | **[fixed]** Capture is durably saved, then described in text by the configured image-capable model (`prompt` argument steers it per call); the description returns as plain text any route can carry. Misconfigured analysis routes are preflighted before capture. | — |
| Full-page capture exceeds admission limits (DSH ≥0.1.7 refuses images over the per-side or total-pixel caps) | **[fixed]** Before capturing, the page is measured (`Page.getLayoutMetrics`) and the capture is scaled via a CDP clip so the raster fits `imageLimits.maxImageDimension`/`maxImagePixels`; the envelope reports the source size and applied scale. Refusals that still slip through (`IMAGE_DIMENSION_TOO_LARGE` / `IMAGE_TOO_MANY_PIXELS` / `IMAGE_TOO_LARGE`) are translated into actionable errors suggesting `fullPage: false` or a lossy format. | — |
| Store normalization downscaled the saved image | **[fixed]** The result carries `originalDimensions` and the envelope notes "normalized from WxH", so the model knows the stored image differs from the capture. | — |
| Analysis model fails | **[diagnosed]** Error names the configured provider/model. | Fix that route's credentials/model. |
| No attachment service / media type rejected | **[diagnosed]** Refused before capture with the exact reason. | Mount `ctx.attachments`; use an accepted format. |

## 5. Remaining silent pitfalls (by design, documented)

- **Stale page after `chrome_close` tab close** — the browser stays alive and
  the next call auto-creates a fresh `about:blank`; navigate before reading.
- **Refs do not survive navigation/reconnection** — acting on an unknown ref
  fails with "take a fresh snapshot" instead of clicking something stale.
- **Headless rendering differences** — fonts/GPU/window differ from a desktop;
  layout-sensitive checks may need `headless: false`.
- **Cross-origin iframes are unreachable from the top frame** — the Markdown
  converter emits an `<!-- iframe: src -->` marker so the reader knows content
  exists beyond the conversion; `chrome_page_snapshot` covers the top frame.
- **Two plugins racing one Chrome** — same `port`/`userDataDir` collides; the
  launch error now names the real conflict. Give each instance its own.
- **Configured `userDataDir` persists cookies/storage** across runs; the
  default fresh temp profile starts clean every launch.

## 6. Stability features always on

- Every `ChromeError` carries a stable `code` (`CHROME_NOT_FOUND`,
  `CHROME_LAUNCH_FAILED`, `CHROME_ENDPOINT_UNREACHABLE`, `CHROME_CDP_ERROR`,
  `CHROME_TIMEOUT`, `CHROME_ABORTED`) so automation can branch by category.
- Launch races the child's `exit` against endpoint polling — a dead Chrome
  fails fast with its real output instead of a generic timeout.
- Dead sockets reconnect lazily; launch mode respawns Chrome automatically.
- Navigation waits are event-based with network-idle accounting; the caller's
  abort signal is honored at every stage.
- Screenshot gates (route capability, attachment service, media type, analysis
  route) all run before any capture work.
