# Agent Note: Tunnel relays the kernel's WebSocket downlinks to the webview

Status: implemented

English | [中文](2026-08-27-vscode-tunnel-ws-downlink-relay.zh.md)

## Problem

The panel embedded the SPA over a fetch-only postMessage tunnel, but the
kernel serves its two live event streams (`/api/events.mux`,
`/api/events.host`) WebSocket-only: a plain GET answers 426, and the
connection plugin's strict handshake requires the socket to open. The
base `AbstractApiClient` falls back to SSE for these streams, so inside the
panel every connection generation failed on the 426, the controller looped
in reconnect backoff, `onConnected` never fired, and the chat surface stayed
empty — "new session" clicks created sessions (visible only as blank rows in
the sidebar) with no content ever rendering.

## Decision

The tunnel gained a one-way WebSocket relay, staying within the existing
transport seam (`__DSH_TRANSPORT__.createApiClient`, whose client overrides
`openMux`/`openHost`):

- `apps/vscode/src/webview-transport.ts` — `TunnelApiClient` overrides the
  two stream openers with `bridgeDownlink`: it posts `dsh.ws.open`, queues
  relayed `dsh.ws.frame` text into a pull-mode async generator, parses the
  kernel's `server-request` envelopes (dropping malformed frames like the
  browser `WebApiClient`), taps `onEnvelope`, and terminates on
  `dsh.ws.end`/abort.
- `apps/vscode/src/tunnel.ts` — the host half answers `dsh.ws.open` with one
  Node built-in `WebSocket` (no new dependency) and relays open/text/close
  as `dsh.ws.open`/`dsh.ws.frame`/`dsh.ws.end` postMessages; `dsh.ws.close`
  and disposal close the sockets.

The CSP stays `default-src 'none'`; the webview still never touches the
network, and the shared `@deepseek-ai/dsh-client-connection` package is
untouched — the browser shape keeps native WebSockets.

## Alternatives considered

Relaxing the panel CSP with a `connect-src` for loopback was rejected: it
would let the webview open raw sockets to the kernel, breaking the
single-privileged-boundary design and the no-network contract the tunnel
exists to keep. Making the kernel serve SSE fallbacks for the two paths was
also rejected: the 426 is a deliberate upgrade fence, and a fetch-reachable
event stream would widen the trust surface for every deployment, not just
the panel.

## Consequences

- The connection controller's strict handshake completes inside the panel:
  both streams open over the tunnel, and session events render live.
- The transport bundle ships the extra ~1 KB of generator code; the host half
  uses Node's built-in WebSocket (available on the supported Node range).
- Any future carrier that cannot open WebSockets reuses the same seam:
  override `openMux`/`openHost` on its client and provide the frames.
