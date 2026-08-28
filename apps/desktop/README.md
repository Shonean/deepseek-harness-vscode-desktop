# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

DeepSeek Harness desktop shell on Electron: a Node main process owns the native
window, a `utilityProcess` child hosts the local `dsh --profile web` kernel,
and the built web SPA renders from a custom-scheme origin with
`contextIsolation` on. The renderer never reaches the network — its API
traffic rides a typed `MessagePort` carrier into the main process, which
relays it to the kernel child's loopback URL. The design is recorded in the
[desktop-shell Agent Note](../../.agents/notes/proposed/architecture/2026-08-25-dsh-desktop-electron-shell.md).

This package is the D2 milestone: the app shell, kernel supervision with
automatic restart, the typed carrier, and the native chrome — application
menu, tray, `dsh://` deep links, and turn-end notifications. It is coherent
and tested but is not packaged, signed, or auto-updated (D3).

## Layout

- `src/main.ts` — Electron main: privileged `dsh-assets://` protocol, kernel
  supervision, `MessageChannelMain` carrier wiring, `BrowserWindow` lifecycle.
- `src/kernel/host.ts` — kernel supervisor: spawns
  `dsh --profile web --no-open --port 0`, parses its loopback URL, reports it
  over the forked parent port, and reaps the process tree on disconnect.
- `src/kernel/entry.ts` — the script the main process forks through
  `utilityProcess.fork`; thin wrapper that hands `process.parentPort` to the
  supervisor class.
- `src/carrier/protocol.ts` — shared frame types (`dsh.fetch`,
  `dsh.fetch.abort`, `dsh.fetch.head/chunk/end`) and narrowers, byte-for-byte
  symmetric with the VSCode postMessage tunnel.
- `src/carrier/tunnel.ts` — host half: relays one `MessagePortMain` to the
  kernel loopback URL with per-request `AbortController`s and 64 KiB streaming
  chunks.
- `src/carrier/renderer-transport.ts` — renderer half, bundled by esbuild to a
  browser IIFE; installs `window.__DSH_TRANSPORT__`
  (`createApiClient` + `fetch`) so the SPA boots unmodified.
- `src/preload/index.ts` — contextIsolation preload: forwards the one carrier
  `MessagePort` from the main process to the page's main world.
- `src/renderer/index.ts` — pure document builder: CSP, transport injection,
  optional session seed.
- `src/renderer/protocol.ts` — pure custom-scheme helpers: origin, MIME lookup,
  path traversal guard.
- `src/native/menu.ts` — pure application-menu template (standard role menus).
- `src/native/deeplink.ts` — pure `dsh://` deep-link parsing
  (`dsh://session/<id>` opens a session; bare links focus the window).
- `src/native/notifications.ts` — pure SSE frame matching plus
  `watchTurnEnd`, which opens the kernel's `events.mux` stream on loopback and
  fires on every `turn/end` event.
- `scripts/build.mjs` — esbuild: `dist/main.js`, `dist/preload.mjs`,
  `dist/kernel-entry.js` (ESM/node), and `dist/renderer-transport.js`
  (IIFE/browser).

## Building and running

```sh
corepack pnpm install                         # fetches the Electron binary too
corepack pnpm --filter @deepseek-ai/dsh-desktop build
corepack pnpm --filter @deepseek-ai/dsh-desktop start
```

The kernel is the standard `dsh web` stack. The CLI and the web frontend dist
are workspace dependencies and must be built first (`corepack pnpm run build`
from the repository root); LLM credentials and tool CLIs are configured
through the harness's own settings and environment, not the shell.

## How the kernel is started

The approved spec calls for a `utilityProcess` child that hosts the in-process
Cordis composition. D1 cannot run that shape directly: the `dsh` package
exposes a CLI bin, not a public programmatic boot entry, and the web server
row is what publishes the readiness line the carrier needs. The D1 host
therefore uses `utilityProcess.fork` to run `src/kernel/entry.ts`, and that
supervisor spawns `dsh --profile web --no-open --port 0` as its own Node
grandchild, parsing the `dsh web: http://127.0.0.1:<port>` line and reporting
the base URL back to the main process over the forked parent port. The main
process then relays SPA fetches to that URL over the carrier.

The grandchild runs on the **system Node.js** (`node ^22.19 || >=24`): the
harness stack does not run on Electron's bundled Node (20 in Electron 33), so
the kernel host resolves the system node — npm's own node when launched
through pnpm, `NODE` otherwise, then a PATH probe — instead of
`ELECTRON_RUN_AS_NODE`.

The kernel still runs as a child of the Electron shell (not a hidden renderer,
not `child_process` from the main process), and its crash tears down only the
supervisor, never the window. The D2 shell respawns the kernel on an
unexpected exit, rewires the carrier to the new generation, and reloads the
window so the SPA reconnects. A deferred refinement is to replace the
grandchild CLI with an in-process boot of the web composition minus
`dsh-host-webserver`, and to extract the host-half adapter
(`attachMessagePortTunnel` + the VSCode `attachWebTunnel`) into a shared
package per the spec.

## How the MessagePort carrier is wired

1. `main.ts` creates one `MessageChannelMain` after the kernel reports its
   base URL and attaches `attachMessagePortTunnel(channel.port1, baseUrl)`.
2. Once the renderer document finishes loading, the main process hands
   `channel.port2` to the renderer via `webContents.postMessage('dsh-port',
   null, [port2])`.
3. The preload (`contextIsolation: true`, `nodeIntegration: false`) listens
   for `ipcRenderer.on('dsh-port')` and re-posts the port to the page's main
   world with the marker `dsh.renderer.port`, transferring it.
4. The bundled `renderer-transport.js` IIFE (injected first in `<head>`)
   receives the port, installs `window.__DSH_TRANSPORT__`, and bridges every
   SPA fetch over the same head/chunk/end frame protocol the VSCode webview
   transport uses. `createApiClient` returns an `AbstractApiClient` subclass;
   `fetch` rides the same bridge for the generic Connection RPC channels.
5. The renderer loads from `dsh-assets://root/`, a privileged custom scheme
   that serves the frontend dist and the transport IIFE. The document CSP
   whitelists only that origin and sets `connect-src 'none'`, so the page
   cannot reach any network even though the main process can.

## D2 scope

- One `BrowserWindow` at 1280×800 with a minimum size.
- One kernel child, lazily started with the window; closing the window
  disposes the tunnel and kills the kernel tree.
- Kernel supervision with automatic restart: an unexpected kernel exit
  respawns it, rewires the carrier, and reloads the window so the SPA
  reconnects.
- The full web SPA rendered from local assets over the typed carrier.
- Native chrome: application menu, tray toggle/quit, `dsh://` deep links that
  focus the app and open a referenced session, and a turn-end system
  notification driven by the kernel's `events.mux` SSE stream.
- Unit tests for the pure surfaces: protocol narrowers, document builder,
  path resolver, kernel argv/URL parser, the host-half tunnel relay, the menu
  template, deep-link parsing, and the turn-end SSE matcher.

## Roadmap

- **D3 — packaging**: electron-builder Windows artifact (unsigned then
  signed), auto-update scaffolding, macOS signing/notarization through CI.
- **Deferred**: replace the grandchild CLI with an in-process kernel boot
  (needs a programmatic `dsh` boot entry) and extract the shared host-half
  carrier package, per the desktop-shell spec.

## Known Limitations and Deferred Work

- The kernel runs as a `utilityProcess` that supervises the `dsh` CLI bin,
  not as an in-process Cordis tree; the no-loopback-listener shape is a
  deferred refinement that needs a programmatic `dsh` boot entry.
- Native file dialogs are not yet wired to the SPA's `host.openPath` /
  directory-picker seams; that rides a host-tool bridge and is deferred.
- `electron` must be installed (`corepack pnpm install`) before
  `corepack pnpm start`. Its postinstall downloads the matching runtime
  binary over the network, which this checkout cannot do in a sandboxed
  environment; type-checking and tests do not require the binary.
- No packaging, signing, notarization, or auto-update — all D3.
