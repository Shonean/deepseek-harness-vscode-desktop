# Agent Note: VSCode extension hosts the web SPA over a postMessage tunnel

Status: implemented

English | [中文](2026-08-25-vscode-web-spa-tunnel.zh.md)

## Problem

The VSCode extension rendered chat in a hand-rolled webview: its own message
protocol, DOM transcript, preset dropdown, and a stdio JSON-RPC subprocess
(`@deepseek-ai/dsh-sdk-client`) separate from the web product. Every feature
the web SPA gained (workspaces, subagents, attachments, theming) had to be
re-implemented or was absent, and the two surfaces drifted. The goal is one
chat implementation — the real web SPA — inside VSCode, with a slim sidebar
mirroring the Claude Code layout.

## Decision

The extension spawns the same web host the CLI serves —
`dsh --profile web --no-open --port 0`, bound to `127.0.0.1` on an ephemeral
port — as a child process (`kernel.ts`), and loads the SPA's built `dist` into
an editor-area `WebviewPanel`. The webview never reaches the network:

- The host half (`tunnel.ts`) relays `dsh.fetch` / `dsh.fetch.abort`
  postMessages to loopback with `fetch`, streaming response bodies back as
  base64 `dsh.fetch.head/chunk/end` frames.
- The browser half (`webview-transport.ts`, bundled as an IIFE) subclasses
  `AbstractApiClient` and installs `window.__DSH_TRANSPORT__` before the SPA
  boots, so the SPA's connection plugin uses the tunnel instead of HTTP+WS.
- `webview-index.ts` rewrites the kernel-rendered index's root-relative asset
  URLs to webview resource URIs and injects the CSP and transport script.

A single `KernelBroker` owns the one kernel for both surfaces and exposes a
loopback `AbstractApiClient` for the sidebar to list/create sessions. The
activity-bar sidebar (`sidebar-view.ts`) is intentionally narrow: a
new-session button and the session list. Selecting a row opens the full panel
for that session. The SPA has no host-to-SPA navigation seam, so navigation
seeds its persisted selection (`localStorage['dsh.sessions.current']`) and
reloads the document; the SPA restores that session on boot.

The old hand-rolled chat (`chat-view.ts`, `harness-controller.ts`,
`preset-store.ts`, `runtime-resolver.ts`, the bundled `runtime/cordis.yml`,
and their tests) is deleted outright rather than kept as a compatibility
shim. Credentials, model, and tool configuration move to the harness's own
settings; the extension only sets language.

## Consequences

- The VSCode panel is the web SPA, so it inherits future web features without
  a second implementation. The extension's runtime surface shrinks to process
  ownership and a request relay.
- The webview's CSP denies direct network access; all traffic crosses the
  extension host, which is the single privileged boundary. The kernel listens
  only on loopback.
- Session navigation is a reload with a localStorage seed, not in-place
  routing. A future host→SPA navigation seam (a message the client runtime
  turns into `ctx.sessions.open`) would let us drop the reload; until then the
  seed is the supported contract and the SPA's own validation guards stale
  ids.
- Session-list freshness is host polling (2s) of `session.list`, not the SPA's
  event stream; the sidebar does not open the mux/host SSE streams.
- The package's runtime dependencies collapse to `@deepseek-ai/dsh` (the
  kernel CLI) and `@deepseek-ai/dsh-web-frontend` (the static dist); the SDK
  client and the demo composition are no longer dependencies.

## Alternatives considered

- **Keep the hand-rolled chat and add features to parity** — rejected: it
  duplicates the web product and guarantees permanent drift; the web SPA is
  the maintained surface.
- **Serve the SPA over an iframe pointing at the loopback URL** — rejected:
  webview CSP for cross-origin frames, direct network access from the webview,
  and theme/credential isolation all get worse, and it forgoes the
  `__DSH_TRANSPORT__` seam the SPA already defines for alternate transports.
- **Add a postMessage navigation seam to the client in the same change** —
  deferred: localStorage seeding works against the shipped SPA today with no
  client-package change; the reload cost is acceptable for v1 and the seam is
  a clean follow-up.
