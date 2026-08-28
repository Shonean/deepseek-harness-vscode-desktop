import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The built webview transport, loaded in a sandbox with a scripted vscode API:
 * the full client-side tunnel contract — request frames out, head/chunk/end
 * frames in, streaming Response bodies the base API client can consume. Runs
 * against the built `dist/webview-transport.js` so the shipped artifact is
 * what gets exercised; skipped on an unbuilt tree.
 */
const here = dirname(fileURLToPath(import.meta.url))
const bundle = resolve(here, '../dist/webview-transport.js')

describe.skipIf(!existsSync(bundle))('webview transport bundle', () => {
  /**
   * Load the IIFE in a vm context with a scripted vscode API and capture the
   * transport hooks it publishes.
   */
  function loadTransport() {
    const outbound: unknown[] = []
    let inboundListener: ((event: { data: unknown }) => void) | undefined
    const windowListeners = new Map<string, Array<(event: unknown) => void>>()
    const sandbox: Record<string, unknown> = {
      window: {
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          const list = windowListeners.get(type) ?? []
          list.push(listener)
          windowListeners.set(type, list)
        },
        __DSH_TRANSPORT__: undefined as unknown,
      },
      acquireVsCodeApi: () => ({
        postMessage: (message: unknown) => { outbound.push(message) },
        getState: () => undefined,
        setState: () => undefined,
      }),
      Headers,
      Request,
      Response,
      URL,
      URLSearchParams,
      ReadableStream,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
      crypto: globalThis.crypto,
      AbortController,
      AbortSignal,
      console,
      setTimeout,
      clearTimeout,
    }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    vm.runInContext(readFileSync(bundle, 'utf8'), sandbox, { filename: 'webview-transport.js' })
    const windowApi = sandbox.window as { __DSH_TRANSPORT__?: unknown }
    const transport = windowApi.__DSH_TRANSPORT__ as {
      createApiClient(): {
        sessions: { list(payload: unknown): Promise<unknown> }
        events: {
          mux(
            payload: unknown,
            signal: AbortSignal,
            onOpen?: () => void,
          ): AsyncIterable<{ rpcId: string; payload: unknown }>
          host(
            payload: unknown,
            signal: AbortSignal,
            onOpen?: () => void,
          ): AsyncIterable<{ rpcId: string; payload: unknown }>
        }
      }
      fetch(input: URL, init?: RequestInit): Promise<Response>
    }
    expect(transport).toBeDefined()
    return {
      transport,
      outbound,
      deliver: (frame: unknown): void => {
        const event = { data: frame }
        for (const listener of windowListeners.get('message') ?? []) {
          listener(event)
        }
        inboundListener?.(event)
      },
    }
  }

  it('publishes both transport hooks at load', () => {
    const { transport } = loadTransport()
    expect(typeof transport.createApiClient).toBe('function')
    expect(typeof transport.fetch).toBe('function')
  })

  it('carries a unary API call end to end through the tunnel protocol', async () => {
    const { transport, outbound, deliver } = loadTransport()
    const client = transport.createApiClient()
    const pending = client.sessions.list({ workspaceId: 'w1' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const request = outbound[0] as { type: string; id: string; path: string; method: string; body: string }
    expect(request).toMatchObject({ type: 'dsh.fetch', path: '/api/session.list', method: 'POST' })
    const body = JSON.parse(request.body) as { type: string; method: string; rpcId: string }
    expect(body).toMatchObject({ type: 'client-request', method: 'session.list' })
    const response = {
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { items: [] } },
    }
    deliver({ type: 'dsh.fetch.head', id: request.id, status: 200, headers: { 'content-type': 'application/json' } })
    deliver({ type: 'dsh.fetch.chunk', id: request.id, chunk: Buffer.from(JSON.stringify(response)).toString('base64') })
    deliver({ type: 'dsh.fetch.end', id: request.id })
    const result = await pending as { result: { ok: boolean } }
    expect(result.result.ok).toBe(true)
  })

  it('exposes a streaming fetch the SSE reader can consume', async () => {
    const { transport, outbound, deliver } = loadTransport()
    const controller = new AbortController()
    const pending = transport.fetch(new URL('http://dsh.internal/api/events.mux'), { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 0))
    const request = outbound[0] as { id: string; path: string }
    expect(request.path).toBe('/api/events.mux')
    deliver({ type: 'dsh.fetch.head', id: request.id, status: 200, headers: { 'content-type': 'text/event-stream' } })
    const response = await pending
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    deliver({ type: 'dsh.fetch.chunk', id: request.id, chunk: Buffer.from('data: hello\n\n').toString('base64') })
    const readChunk = reader.read.bind(reader)
    const { value } = await readChunk()
    expect(value).toBeDefined()
    expect(Buffer.from(value as Uint8Array).toString('utf8')).toBe('data: hello\n\n')
    deliver({ type: 'dsh.fetch.end', id: request.id })
    await reader.cancel()
  })

  it('rides the downlink relay for the mux stream: open, envelopes, terminal', async () => {
    const { transport, outbound, deliver } = loadTransport()
    const controller = new AbortController()
    let opened = 0
    const stream = transport.createApiClient().events.mux({}, controller.signal, () => { opened += 1 })
    // The generator body runs on first pull: start the pump before the
    // dsh.ws.open frame goes out, mirroring the connection controller.
    const next = (async () => {
      for await (const envelope of stream) return envelope
      return undefined
    })()
    await new Promise(resolve => setTimeout(resolve, 0))
    const request = outbound[0] as { type: string; id: string; path: string }
    expect(request).toMatchObject({ type: 'dsh.ws.open', path: '/api/events.mux' })
    deliver({ type: 'dsh.ws.open', id: request.id })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(opened).toBe(1)
    const frame = { type: 'server-request', rpcId: 'r1', payload: { type: 'frame', seq: 1 } }
    deliver({ type: 'dsh.ws.frame', id: request.id, data: JSON.stringify(frame) })
    const envelope = await next
    expect(envelope).toMatchObject({ rpcId: 'r1', payload: { type: 'frame', seq: 1 } })
    deliver({ type: 'dsh.ws.end', id: request.id })
    controller.abort()
  })

  it('drops malformed downlink frames without killing the stream, and closes on abort', async () => {
    const { transport, outbound, deliver } = loadTransport()
    const controller = new AbortController()
    const stream = transport.createApiClient().events.host({}, controller.signal)
    const collected: unknown[] = []
    const pump = (async () => {
      for await (const envelope of stream) collected.push(envelope)
    })()
    await new Promise(resolve => setTimeout(resolve, 0))
    const request = outbound[0] as { id: string; path: string }
    expect(request.path).toBe('/api/events.host')
    deliver({ type: 'dsh.ws.frame', id: request.id, data: 'not json' })
    deliver({ type: 'dsh.ws.frame', id: request.id, data: '{"noPayload":true}' })
    deliver({ type: 'dsh.ws.frame', id: request.id, data: JSON.stringify({ type: 'server-request', rpcId: 'r2', payload: { type: 'frame', seq: 2 } }) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(collected).toHaveLength(1)
    expect(collected[0]).toMatchObject({ rpcId: 'r2' })
    controller.abort()
    await pump
    const close = outbound.find(frame => (frame as { type?: string }).type === 'dsh.ws.close') as { id: string } | undefined
    expect(close?.id).toBe(request.id)
  })
})
