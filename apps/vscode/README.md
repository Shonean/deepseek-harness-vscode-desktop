# DSH for VS Code

[![Unofficial](https://img.shields.io/badge/DeepSeek%20Harness-unofficial%20community%20build-f6b5c8)](https://github.com/deepseek-ai/deepseek-harness)
[![Upstream](https://img.shields.io/badge/upstream-deepseek--ai%2Fdeepseek--harness-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English | [中文](README.zh.md)

**DSH for VS Code** runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — the plugin-based, fully local AI coding agent — inside VS Code: a slim session sidebar in the activity bar and the full DSH web chat surface in an editor panel.

> This is an **unofficial community build**, maintained by [@Shonean](https://github.com/Shonean). It is not published, endorsed, or supported by DeepSeek. "DeepSeek Harness" is a trademark of DeepSeek; this extension only bundles and configures the upstream open-source project.

## What it does

- The activity-bar sidebar lists your DSH sessions and offers the only **New session** button; selecting a session opens the complete DSH web SPA in an editor tab.
- The extension spawns the local `dsh web` kernel as a child process on `127.0.0.1` with an ephemeral port. The webview itself never touches the network — the extension host relays every request to loopback over a postMessage tunnel, so there is no CORS surface and the kernel stays single-origin.
- The embedded SPA hides its own sidebar column (it detects the `window.__DSH_TRANSPORT__` carrier marker), so VS Code always shows exactly one session list and one new-session entry.
- The panel follows VS Code's active color theme, including live theme switches.
- A floating settings gear (top-right of the panel) opens DSH's settings modal and API-key onboarding, which are otherwise unreachable without the SPA's own sidebar.

## Requirements

- Node.js `^22.19 || >=24` on your PATH (the kernel runs on the system Node, not VS Code's built-in one).
- LLM credentials (e.g. `DEEPSEEK_API_KEY`) and tool CLIs are configured through DSH's own settings panel or environment — open the gear in the panel after the first session starts. No separate DeepSeek Harness install is needed: the VSIX bundles a self-contained kernel runtime (the `dsh` CLI, every web-profile plugin, and the served web frontend), so a clean machine needs no `node_modules` next to the extension.

## Install

1. Download the latest `.vsix` from [Releases](https://github.com/Shonean/deepseek-harness-vscode-desktop/releases).
2. In VS Code: Extensions view → `…` menu → **Install from VSIX…**, or:

   ```sh
   code --install-extension dsh-vscode-0.1.0.vsix
   ```

3. Open the **DSH** activity-bar container and click **New session**. The first start spawns the local kernel (a few seconds); the panel then shows the DSH chat surface.

## Commands

- `DSH: Open DSH Panel` (`dsh.openChat`) — open the full panel.
- `DSH: New DSH Session` (`dsh.newSession`) — create a session and open it in the panel.
- `DSH: Close DSH Panel` (`dsh.closeChat`) — close the panel (the shared kernel keeps running for the sidebar).
- `DSH: Show DSH Logs` (`dsh.showLogs`) — open the extension output channel.

## Settings

- `dsh-vscode.uiLocale` — sidebar and panel UI language: `auto` follows VS Code's display language, `en` English, `zh-cn` 简体中文. Changing it reloads the sidebar.

## Known limitations

- The VSIX bundles the kernel runtime as a hoisted production closure (pnpm deploy), which makes it large (tens of MB compressed, tens of thousands of files) and slow to install from the Extensions view — expect the first install to take a while.
- Signed macOS/Windows builds and marketplace publication are not set up; installs are VSIX-only for now.

## Development

Layout of the extension host code:

- `src/extension.ts` — activation, command registration, broker wiring.
- `src/kernel-broker.ts` — owns the one shared kernel child process and a loopback API client; lists and creates sessions and polls for changes.
- `src/kernel.ts` — spawns `dsh --profile web --no-open --port 0`, parses its loopback URL, and reaps the process tree on disposal.
- `src/tunnel.ts` — host half of the panel tunnel: relays webview fetches to the kernel and streams response bodies back as postMessage frames; owns one host WebSocket per kernel downlink (`/api/events.mux`, `/api/events.host`) and relays its text frames.
- `src/webview-transport.ts` — browser half, bundled to `dist/webview-transport.js`; installs `window.__DSH_TRANSPORT__` so the SPA boots over the tunnel.
- `src/web-panel.ts` — the editor-area `WebviewPanel` hosting the SPA.
- `src/sidebar-view.ts` — the slim sidebar: new-session button and session list.
- `src/webview-index.ts` — pure index rewriting: root-relative asset URLs to webview URIs, CSP, transport/seed injection, and the theme bridge script.

```sh
pnpm --filter @deepseek-ai/dsh-vscode run build      # esbuild: dist/extension.cjs + dist/webview-transport.js
pnpm --filter @deepseek-ai/dsh-vscode run runtime    # materialize runtime/: the pnpm-deploy kernel closure (prod-only, pruned)
pnpm --filter @deepseek-ai/dsh-vscode run pack:vsix  # build + runtime closure + dist/dsh-vscode-<version>.vsix from the publish tarball
```

`pack:vsix` stages the publish tarball (which includes `runtime/node_modules/**` via the `files` field) into the VSIX layout. The closure content is declared once by the dependency-only workspace package `apps/vscode/runtime-deploy` (`dsh-web-runtime-closure`): its dependency list is the web kernel — the `dsh` CLI, the served frontend, every plugin the web profile and shipped presets load by bare name, and the non-optional workspace peers. Adding a distribution plugin means adding one dependency line there. In a source checkout without `runtime/`, the extension falls back to resolving through the workspace `node_modules` beside it ([runtime-resolution.ts](src/runtime-resolution.ts)).

The kernel CLI and the web frontend dist it serves are workspace dependencies; build them first with `pnpm run build` from the repository root.

## License

MIT, same as upstream DeepSeek Harness.
