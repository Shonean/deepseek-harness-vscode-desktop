/// <reference lib="dom" />
/**
 * The renderer half of the desktop carrier: an IIFE bundled to
 * `dist/renderer-transport.js` and injected ahead of the SPA. It waits for the
 * `MessagePort` the preload forwards from the main process (see
 * src/preload/index.ts), installs `window.__DSH_TRANSPORT__`, and bridges every
 * fetch the SPA issues over the same head/chunk/end frame contract the VSCode
 * webview transport uses. The bundle is fully browser-safe: no Node imports,
 * no `require`, the apiproxy client half bundles in.
 * @module carrier/renderer-transport
 */
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { CarrierOutbound } from './protocol.ts'

/** Marker the preload sends to identify the port-forward message. */
const PORT_MESSAGE = 'dsh.renderer.port'

/** Promise handed to the fetch bridge: resolved once the port arrives. */
let resolvePort: ((port: MessagePort) => void) | undefined
const portReady = new Promise<MessagePort>((resolve) => {
  resolvePort = resolve
})

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return
  const data = event.data as { marker?: string } | undefined
  if (data === undefined || data.marker !== PORT_MESSAGE) return
  const port = event.ports[0]
  if (port === undefined || resolvePort === undefined) return
  port.start()
  port.onmessage = (message: MessageEvent) => { dispatchFrame(message.data as CarrierOutbound) }
  resolvePort(port)
  resolvePort = undefined
})

/** Pending or streaming request on the renderer side. */
interface PendingFetch {
  resolveHead: (head: { status: number; headers: Record<string, string> }) => void
  reject: (error: Error) => void
  enqueue: (chunk: Uint8Array) => void
  close: () => void
  fail: (error: string) => void
}

/** Pending fetches by tunnel id; the port message handler resolves them. */
const pending = new Map<string, PendingFetch>()
/** Monotonic tunnel id counter (ids never leave this page↔host pair). */
let nextId = 0

/**
 * Bridge one fetch over the MessagePort: send the request frame, await the
 * head, and expose the body as a real streaming `Response` so the base
 * client's SSE reader and unary JSON path work unchanged.
 * @param input - the request URL; only its path plus query reaches the host.
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
    void portReady.then((port) => {
      port.postMessage({
        type: 'dsh.fetch',
        id,
        path: input.pathname + input.search,
        method: init?.method ?? 'GET',
        headers,
        ...body === undefined ? {} : { body },
      })
    })
  })
  const signal = init?.signal ?? null
  if (signal !== null) {
    if (signal.aborted) {
      void portReady.then((port) => { port.postMessage({ type: 'dsh.fetch.abort', id }) })
      pending.delete(id)
      return Promise.reject(new Error('Aborted'))
    }
    signal.addEventListener('abort', () => {
      void portReady.then((port) => { port.postMessage({ type: 'dsh.fetch.abort', id }) })
    }, { once: true })
  }
  return promise
}

/**
 * Dispatch one host frame to its pending request. Unknown ids are dropped:
 * an abort or a renderer reload can orphan a frame, and neither case is an
 * error the SPA could act on.
 * @param frame - the host frame.
 */
function dispatchFrame(frame: CarrierOutbound): void {
  const entry = pending.get(frame.id)
  if (entry === undefined) return
  if (frame.type === 'dsh.fetch.head') {
    entry.resolveHead({ status: frame.status, headers: frame.headers })
    return
  }
  if (frame.type === 'dsh.fetch.chunk') {
    entry.enqueue(Uint8Array.from(atob(frame.chunk), character => character.charCodeAt(0)))
    return
  }
  pending.delete(frame.id)
  if (frame.error === undefined) entry.close()
  else entry.fail(frame.error)
}

declare global {
  interface Window {
    __DSH_TRANSPORT__?: {
      createApiClient(): AbstractApiClient
      fetch(input: URL, init: RequestInit): Promise<Response>
    }
  }
}

window.__DSH_TRANSPORT__ = {
  createApiClient: () => new DesktopApiClient(),
  fetch: (input, init) => bridgeFetch(input, init),
}

/** Client whose transport is the MessagePort carrier; protocol invariants stay in the base class. */
class DesktopApiClient extends AbstractApiClient {
  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return bridgeFetch(input, init)
  }
}
