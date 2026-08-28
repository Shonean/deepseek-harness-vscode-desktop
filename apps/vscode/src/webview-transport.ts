/// <reference lib="dom" />
/**
 * The webview-side transport: an injected IIFE that publishes
 * `window.__DSH_TRANSPORT__` so the real web SPA boots unmodified inside the
 * panel. `createApiClient` returns a client whose `doFetch` rides the tunnel
 * postMessage protocol (see apps/vscode/src/tunnel.ts for the host half) and
 * whose two downlink streams (`/api/events.mux`, `/api/events.host`) ride the
 * tunnel's WebSocket relay — the kernel serves those paths WebSocket-only,
 * and a webview cannot open sockets under its CSP; `fetch` exposes the same
 * bridge to the generic Connection RPC channels, and `loadBundle` is absent —
 * bundle URLs are rewritten to webview resource URIs, which the module
 * system's default fetch loads directly.
 * @module webview-transport
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { ApiProxy, HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/src/api/index.ts'
import type { RpcMessage, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/src/api/rpc.ts'

/** Messages the host tunnel sends back (mirror of tunnel.ts's TunnelOutbound). */
interface TunnelOutbound {
  type: 'dsh.fetch.head' | 'dsh.fetch.chunk' | 'dsh.fetch.end' | 'dsh.ws.open' | 'dsh.ws.frame' | 'dsh.ws.end'
  id: string
  status?: number
  headers?: Record<string, string>
  chunk?: string
  data?: string
  error?: string
}

/** The vscode webview API surface this script uses. */
interface WebviewApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

/** One pending or streaming tunnel request on the webview side. */
interface PendingFetch {
  resolveHead: (head: { status: number; headers: Record<string, string> }) => void
  reject: (error: Error) => void
  enqueue: (chunk: Uint8Array) => void
  close: () => void
  fail: (error: string) => void
}

/** One open downlink stream: the generator's queue taps. */
interface PendingDownlink {
  /** The host socket opened; the stream-established signal. */
  opened: () => void
  /** One text frame arrived. */
  enqueue: (data: string) => void
  /** The host socket closed (or errored) — terminal. */
  close: () => void
}

/** The transport global the connection plugin reads at boot. */
interface TransportGlobal {
  __DSH_TRANSPORT__?: {
    createApiClient(): AbstractApiClient
    fetch(input: URL, init: RequestInit): Promise<Response>
  }
  __DSH_WEBVIEW_REPORT__?: (payload: unknown) => void
}

declare global {
  interface Window {
    __DSH_TRANSPORT__?: TransportGlobal['__DSH_TRANSPORT__']
    __DSH_WEBVIEW_REPORT__?: TransportGlobal['__DSH_WEBVIEW_REPORT__']
  }
}

declare function acquireVsCodeApi(): WebviewApi

/** The vscode API is only injectable once per page; captured at script load. */
const vscode: WebviewApi = acquireVsCodeApi()

/** Pending fetches by tunnel id; the window message handler resolves them. */
const pending = new Map<string, PendingFetch>()
/** Open downlinks by tunnel id; their generators consume the relayed frames. */
const downlinks = new Map<string, PendingDownlink>()
/** Monotonic tunnel id counter (ids never leave this page↔host pair). */
let nextId = 0

/**
 * Bridge one fetch over the tunnel: send the request frame, await the head,
 * and expose the body as a real streaming Response so the base client's SSE
 * reader and unary JSON path work unchanged.
 * @param input - the request URL; only its path plus query reach the host.
 * @param init - fetch init (method, headers, body, signal).
 * @returns the response with a streaming body.
 */
function bridgeFetch(input: URL, init?: RequestInit): Promise<Response> {
  const id = `t${String(++nextId)}`
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
  const body = typeof init?.body === 'string' ? init.body : undefined
  const promise = new Promise<Response>((resolveResponse, rejectResponse) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
      },
    })
    pending.set(id, {
      resolveHead: (head) => {
        resolveResponse(new Response(stream, { status: head.status, headers: head.headers }))
      },
      reject: rejectResponse,
      enqueue: (chunk) => { controller?.enqueue(chunk) },
      close: () => { controller?.close() },
      fail: (error) => { controller?.error(new Error(error)) },
    })
    vscode.postMessage({
      type: 'dsh.fetch',
      id,
      path: input.pathname + input.search,
      method: init?.method ?? 'GET',
      headers,
      ...body === undefined ? {} : { body },
    })
  })
  const signal = init?.signal ?? null
  if (signal !== null) {
    if (signal.aborted) {
      vscode.postMessage({ type: 'dsh.fetch.abort', id })
      pending.delete(id)
      return Promise.reject(new Error('Aborted'))
    }
    signal.addEventListener('abort', () => {
      vscode.postMessage({ type: 'dsh.fetch.abort', id })
    }, { once: true })
  }
  return promise
}

/**
 * Dispatch one host frame to its pending request or downlink. Unknown ids are
 * dropped: an abort or a panel reload can orphan a frame, and neither case is
 * an error the SPA could act on.
 * @param frame - the host frame.
 */
function dispatchFrame(frame: TunnelOutbound): void {
  const entry = pending.get(frame.id)
  if (entry !== undefined) {
    if (frame.type === 'dsh.fetch.head') {
      entry.resolveHead({ status: frame.status ?? 0, headers: frame.headers ?? {} })
      return
    }
    if (frame.type === 'dsh.fetch.chunk') {
      entry.enqueue(Uint8Array.from(atob(frame.chunk ?? ''), character => character.charCodeAt(0)))
      return
    }
    pending.delete(frame.id)
    if (frame.error === undefined) entry.close()
    else entry.fail(frame.error)
    return
  }
  const link = downlinks.get(frame.id)
  if (link === undefined) return
  if (frame.type === 'dsh.ws.open') {
    link.opened()
    return
  }
  if (frame.type === 'dsh.ws.frame') {
    link.enqueue(frame.data ?? '')
    return
  }
  downlinks.delete(frame.id)
  link.close()
}

window.addEventListener('message', (event: MessageEvent) => {
  dispatchFrame(event.data as TunnelOutbound)
})

// Surface webview-side failures in the host log: a white panel otherwise
// leaves no trace outside this page's devtools.
window.addEventListener('error', (event: ErrorEvent) => {
  vscode.postMessage({
    type: 'dsh.webviewError',
    surface: 'panel/error',
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  })
})
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason: unknown = event.reason
  vscode.postMessage({
    type: 'dsh.webviewError',
    surface: 'panel/unhandledrejection',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})

window.__DSH_TRANSPORT__ = {
  createApiClient: () => new TunnelApiClient(),
  fetch: (input, init) => bridgeFetch(input, init),
}

/**
 * One-shot report channel for the panel probe script: the webview API is
 * captured here, and a plain script cannot call acquireVsCodeApi a second
 * time, so diagnostic payloads travel through this function instead.
 */
window.__DSH_WEBVIEW_REPORT__ = (payload: unknown): void => {
  vscode.postMessage(payload)
}

/** Client whose transport is the tunnel; protocol invariants stay in the base class. */
class TunnelApiClient extends AbstractApiClient {
  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return bridgeFetch(input, init)
  }

  /**
   * bridgeFetch consumes only the path plus query, so the base URL is a fixed
   * well-formed authority rather than the webview's resource origin.
   */
  protected override resolveBase(): string {
    return 'http://dsh.internal'
  }

  /** Mux stream over the tunnel's WebSocket relay (the kernel serves it WS-only). */
  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.bridgeDownlink('/api/events.mux', signal, onOpen)
  }

  /** Host stream over the tunnel's WebSocket relay (the kernel serves it WS-only). */
  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.bridgeDownlink('/api/events.host', signal, onOpen)
  }

  /**
   * One downlink stream: ask the host half for a WebSocket, then relay its
   * text frames into a pull-mode queue. Frames are the kernel's JSON
   * ServerRequest envelopes; a frame that fails JSON or misses its envelope
   * fields is reported and skipped (one corrupt frame must not kill the
   * stream, mirroring the browser WebApiClient's drop policy). onOpen fires
   * when the host socket is established — the readiness signal the connection
   * controller's strict handshake waits for.
   */
  private async *bridgeDownlink<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const id = `w${String(++nextId)}`
    const inbox: Array<RpcRequest<F> | { kind: 'end' }> = []
    let wake: (() => void) | undefined
    downlinks.set(id, {
      opened: () => { onOpen?.() },
      enqueue: (data: string) => {
        let envelope: { rpcId?: unknown; payload?: unknown }
        try {
          envelope = JSON.parse(data) as { rpcId?: unknown; payload?: unknown }
        } catch (error) {
          console.error(`[dsh-vscode] dropping malformed downlink frame on ${path}:`, error)
          return
        }
        if (envelope.rpcId === undefined || envelope.payload === undefined) {
          console.error(`[dsh-vscode] dropping malformed downlink envelope on ${path}:`, data.slice(0, 200))
          return
        }
        this.onEnvelope(envelope as RpcMessage)
        inbox.push({ rpcId: envelope.rpcId, payload: envelope.payload } as RpcRequest<F>)
        wake?.()
        wake = undefined
      },
      close: () => {
        inbox.push({ kind: 'end' })
        wake?.()
        wake = undefined
      },
    })
    const abort = (): void => {
      downlinks.delete(id)
      inbox.push({ kind: 'end' })
      wake?.()
      wake = undefined
      vscode.postMessage({ type: 'dsh.ws.close', id })
    }
    signal.addEventListener('abort', abort, { once: true })
    vscode.postMessage({ type: 'dsh.ws.open', id, path })
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as RpcRequest<F> | { kind: 'end' }
          if ('kind' in item) return
          yield item
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      downlinks.delete(id)
      signal.removeEventListener('abort', abort)
      vscode.postMessage({ type: 'dsh.ws.close', id })
    }
  }
}
