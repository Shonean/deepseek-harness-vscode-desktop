# @deepseek-ai/dsh-vscode

English | [中文](README.zh.md)

DeepSeek Harness inside VSCode: a slim session sidebar in the activity bar and
the full web chat surface in an editor panel. The extension spawns the local
`dsh web` kernel as a child process bound to `127.0.0.1` on an ephemeral port,
then loads the real web SPA into a webview. The webview never reaches the
network itself — the extension host relays every request to loopback over a
postMessage tunnel, so there is no CORS surface and the kernel stays
single-origin.

The activity-bar sidebar is the only session surface: its new-session button
and session list drive the panel, and the embedded SPA hides its own sidebar
column (ui-layout's carrier mode reacts to the `window.__DSH_TRANSPORT__`
marker this extension installs), so VSCode shows exactly one "New session"
and one session list at all times.

## Layout

- `src/extension.ts` — activation, command registration, broker wiring.
- `src/kernel-broker.ts` — owns the one shared kernel child process and a
  loopback API client; lists and creates sessions and polls for changes.
- `src/kernel.ts` — spawns `dsh --profile web --no-open --port 0`, parses its
  loopback URL, and reaps the process tree on disposal.
- `src/tunnel.ts` — host half of the panel tunnel: relays webview fetches to
  the kernel and streams response bodies back as postMessage frames; owns one
  host WebSocket per kernel downlink (`/api/events.mux`, `/api/events.host`)
  and relays its text frames, so the SPA's live session events reach the
  panel despite the webview's no-network CSP.
- `src/webview-transport.ts` — browser half, bundled to
  `dist/webview-transport.js`; installs `window.__DSH_TRANSPORT__` so the SPA
  boots over the tunnel.
- `src/web-panel.ts` — the editor-area `WebviewPanel` hosting the SPA, seeded
  to a target session through the SPA's persisted selection.
- `src/sidebar-view.ts` — the slim sidebar: new-session button and session
  list; selecting a row opens the full panel for that session.
- `src/webview-index.ts` — pure index rewriting: root-relative asset URLs to
  webview URIs, CSP, transport/seed injection, and the theme bridge script.

## Building

```sh
pnpm --filter @deepseek-ai/dsh-vscode run build
```

esbuild emits two bundles: `dist/extension.cjs` (CJS, `vscode` externalized)
and `dist/webview-transport.js` (browser IIFE). The kernel CLI and the web
frontend dist it serves are workspace dependencies and must be built first
(`pnpm run build` from the repository root).

## Packing a VSIX

```sh
pnpm --filter @deepseek-ai/dsh-vscode run pack:vsix
```

Writes `dist/dsh-vscode-<version>.vsix` derived from the publish tarball
(`pnpm pack`): the VSIX carries exactly what the published npm package
carries. Re-packing the same version replaces the previous output.

## Settings

- `dsh-vscode.uiLocale` — sidebar and panel UI language: `auto` follows
  VSCode's display language, `en` English, `zh-cn` 简体中文. Changing it
  reloads the sidebar.

## Theme

The panel follows VSCode's active color theme. The SPA resolves its `system`
preference through `matchMedia('(prefers-color-scheme: dark)')`, so the
extension injects a bridge script that answers color-scheme queries from the
VSCode theme kind instead, and pushes live updates through a
`dsh.vscodeTheme` message whenever the active theme changes.

## Commands

- `DeepSeek Harness: Open DeepSeek Harness` (`dsh.openChat`) — open the full
  panel.
- `DeepSeek Harness: New DeepSeek Harness Session` (`dsh.newSession`) — create
  a session and open it in the panel.
- `DeepSeek Harness: Close DeepSeek Harness` (`dsh.closeChat`) — close the
  panel (the shared kernel keeps running for the sidebar).

## Requirements

The kernel is the standard `dsh web` stack; LLM credentials and tool CLIs are
configured through the harness's own settings and environment, not the
extension.
