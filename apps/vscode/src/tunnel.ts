/**
 * The panel tunnel's host half: relays webview fetch requests to the web
 * kernel's loopback port and streams response bodies back as postMessage
 * chunks. The two downlink event streams (`/api/events.mux` and
 * `/api/events.host`) are WebSocket-only on the kernel, and a webview cannot
 * open sockets (its CSP forbids connect-src), so the tunnel also owns one
 * host-side WebSocket per downlink and relays its text frames back to the
 * webview. The webview never speaks to the network itself — no CORS, no
 * direct kernel reachability — and the extension host stays the single
 * privileged surface between the SPA and the kernel.
 *
 * Wire protocol (webview → host):
 * - `{ type: 'dsh.fetch', id, path, method, headers, body? }` — one request;
 *   `path` is the URL path plus query (`/api/...`).
 * - `{ type: 'dsh.fetch.abort', id }` — abort an in-flight request.
 * - `{ type: 'dsh.ws.open', id, path }` — open one downlink stream.
 * - `{ type: 'dsh.ws.close', id }` — close a downlink stream.
 * Host → webview, in order per id:
 * - `{ type: 'dsh.fetch.head', id, status, headers }`
 * - `{ type: 'dsh.fetch.chunk', id, chunk }` — base64 body bytes, zero or more
 * - `{ type: 'dsh.fetch.end', id, error? }` — terminal frame
 * - `{ type: 'dsh.ws.open', id }` — the host socket is open
 * - `{ type: 'dsh.ws.frame', id, data }` — one text frame
 * - `{ type: 'dsh.ws.end', id, error? }` — terminal frame
 * @module tunnel
 */

/** Inbound tunnel request from the webview. */
export interface TunnelFetchMessage {
  type: 'dsh.fetch'
  /** Caller-correlation id, minted by the webview. */
  id: string
  /** URL path plus query, starting at `/`. */
  path: string
  method: string
  headers: Record<string, string>
  /** Request body as UTF-8 text; absent for body-less requests. */
  body?: string
}

/** Inbound abort for one in-flight request. */
export interface TunnelAbortMessage {
  type: 'dsh.fetch.abort'
  id: string
}

/** Inbound downlink open: one WebSocket to `/api/events.mux` or `/api/events.host`. */
export interface TunnelDownlinkOpenMessage {
  type: 'dsh.ws.open'
  id: string
  /** URL path starting at `/`, e.g. `/api/events.mux`. */
  path: string
}

/** Inbound close for one downlink stream. */
export interface TunnelDownlinkCloseMessage {
  type: 'dsh.ws.close'
  id: string
}

/** Union of messages the tunnel consumes from the webview. */
export type TunnelInbound =
  | TunnelFetchMessage
  | TunnelAbortMessage
  | TunnelDownlinkOpenMessage
  | TunnelDownlinkCloseMessage

/** Outbound frames, mirrored in the injected transport script. */
export type TunnelOutbound =
  | { type: 'dsh.fetch.head'; id: string; status: number; headers: Record<string, string> }
  | { type: 'dsh.fetch.chunk'; id: string; chunk: string }
  | { type: 'dsh.fetch.end'; id: string; error?: string }
  | { type: 'dsh.ws.open'; id: string }
  | { type: 'dsh.ws.frame'; id: string; data: string }
  | { type: 'dsh.ws.end'; id: string; error?: string }

import { log, logError } from './log.ts'

/** The slice of WebviewView/Webview the tunnel needs. */
export interface TunnelWebview {
  postMessage(message: unknown): Thenable<boolean>
  onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void }
}

/** Fetch shape the tunnel relays into (global fetch or an injected fake). */
export type TunnelFetch = (url: string, init: RequestInit) => Promise<Response>

/** Host WebSocket shape: the slice the tunnel drives (Node's global WebSocket). */
export interface TunnelSocket {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void
  close(): void
}

/** Chunk size for streaming bodies back over postMessage (64 KiB of bytes). */
const CHUNK_BYTES = 64 * 1024

/** Options for {@link attachWebTunnel}; injectable for tests. */
export interface TunnelOptions {
  /** Transport for relayed fetches (production: global fetch). */
  doFetch?: TunnelFetch
  /** Downlink socket factory (production: the Node built-in WebSocket). */
  createSocket?: (url: string) => TunnelSocket
}

/**
 * Attach the tunnel to one webview. Every inbound `dsh.fetch` runs against
 * `baseUrl` with a per-request AbortController; every inbound `dsh.ws.open`
 * opens one host WebSocket whose text frames are relayed back; `dispose()`
 * stops listening, aborts everything still in flight, and closes the sockets.
 * @param webview - the panel webview to serve.
 * @param baseUrl - kernel loopback base URL, no trailing slash.
 * @param options - transport and socket factories; production uses the
 *   defaults, tests inject fakes.
 * @returns the tunnel's disposer.
 */
export function attachWebTunnel(
  webview: TunnelWebview,
  baseUrl: string,
  options: TunnelOptions = {},
): { dispose(): void } {
  const doFetch: TunnelFetch = options.doFetch ?? ((url, init) => fetch(url, init))
  const createSocket: (url: string) => TunnelSocket = options.createSocket
    ?? (url => new WebSocket(url))
  const inFlight = new Map<string, AbortController>()
  const sockets = new Map<string, TunnelSocket>()
  let disposed = false

  const send = (frame: TunnelOutbound): void => {
    if (disposed) return
    void webview.postMessage(frame)
  }

  const run = async (message: TunnelFetchMessage): Promise<void> => {
    const controller = new AbortController()
    const startedAt = Date.now()
    inFlight.set(message.id, controller)
    try {
      const response = await doFetch(baseUrl + message.path, {
        method: message.method,
        headers: message.headers,
        ...message.body === undefined ? {} : { body: message.body },
        signal: controller.signal,
      })
      log(`tunnel: ${message.method} ${message.path} -> ${response.status} (${String(Date.now() - startedAt)}ms)`)
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      send({ type: 'dsh.fetch.head', id: message.id, status: response.status, headers })
      if (response.body === null) {
        send({ type: 'dsh.fetch.end', id: message.id })
        return
      }
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (controller.signal.aborted) break
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
          for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
            const slice = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length))
            send({ type: 'dsh.fetch.chunk', id: message.id, chunk: Buffer.from(slice).toString('base64') })
          }
        }
        send({ type: 'dsh.fetch.end', id: message.id })
      } catch (error) {
        send({ type: 'dsh.fetch.end', id: message.id, error: error instanceof Error ? error.message : String(error) })
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    } catch (error) {
      logError(`tunnel: ${message.method} ${message.path} failed (${String(Date.now() - startedAt)}ms)`, error)
      send({
        type: 'dsh.fetch.end',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      inFlight.delete(message.id)
    }
  }

  /** Open one host WebSocket for a downlink stream and relay its text frames. */
  const openDownlink = (message: TunnelDownlinkOpenMessage): void => {
    const url = new URL(message.path, baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: TunnelSocket
    try {
      socket = createSocket(url.toString())
    } catch (error) {
      logError(`tunnel: dsh.ws.open ${message.path} socket creation failed`, error)
      send({ type: 'dsh.ws.end', id: message.id, error: error instanceof Error ? error.message : String(error) })
      return
    }
    sockets.set(message.id, socket)
    let ended = false
    const end = (error?: string): void => {
      if (ended) return
      ended = true
      sockets.delete(message.id)
      log(`tunnel: ws ${message.path} closed${error === undefined ? '' : ` (${error})`}`)
      send({ type: 'dsh.ws.end', id: message.id, ...error === undefined ? {} : { error } })
    }
    socket.addEventListener('open', () => {
      log(`tunnel: ws ${message.path} open`)
      send({ type: 'dsh.ws.open', id: message.id })
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      send({ type: 'dsh.ws.frame', id: message.id, data: event.data })
    })
    socket.addEventListener('close', () => { end() })
    socket.addEventListener('error', () => { end('websocket error') })
  }

  const subscription = webview.onDidReceiveMessage((raw: unknown) => {
    const message = raw as TunnelInbound
    if (message.type === 'dsh.fetch') {
      void run(message)
      return
    }
    if (message.type === 'dsh.ws.open') {
      openDownlink(message)
      return
    }
    sockets.get(message.id)?.close()
    inFlight.get(message.id)?.abort()
  })

  return {
    dispose(): void {
      disposed = true
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
      for (const socket of sockets.values()) socket.close()
      sockets.clear()
      subscription.dispose()
    },
  }
}
