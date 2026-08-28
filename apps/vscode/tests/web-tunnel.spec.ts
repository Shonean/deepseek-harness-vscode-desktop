import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { attachWebTunnel, type TunnelInbound } from '../src/tunnel.ts'

/**
 * Host-half tunnel contract: request relay, streaming bodies, terminal
 * frames, aborts, and disposal. The webview side is a scripted double that
 * records postMessage frames and feeds inbound messages.
 */
describe('web panel tunnel host half', () => {
  let server: Server | undefined
  let baseUrl = ''
  const hanging = new Set<ServerResponse>()

  afterEach(async (): Promise<void> => {
    for (const res of hanging) {
      try { res.destroy() } catch { /* response may already be gone */ }
    }
    hanging.clear()
    await new Promise<void>((resolve) => {
      if (server !== undefined) server.close(() => { resolve() })
      else resolve()
      const timer = setTimeout(() => { resolve() }, 500)
      timer.unref?.()
    })
    server = undefined
  })

  /** Start one loopback server with the given per-request handler. */
  async function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<string> {
    server = createServer(handler)
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return `http://127.0.0.1:${String(address.port)}`
  }

  /** A scripted webview: captures outbound frames, replays inbound ones. */
  function fakeWebview() {
    const outbound: unknown[] = []
    let listener: ((message: unknown) => void) | undefined
    return {
      outbound,
      inbound(message: TunnelInbound): void { listener?.(message) },
      webview: {
        postMessage: (message: unknown) => { outbound.push(message); return Promise.resolve(true) },
        onDidReceiveMessage: (l: (message: unknown) => void) => {
          listener = l
          return { dispose: () => { listener = undefined } }
        },
      },
    }
  }

  it('relays a unary request: method, headers, body, and the JSON response', async () => {
    let seen: { method: string; url: string; body: string } | undefined
    baseUrl = await listen((req, res) => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8') })
      req.on('end', () => {
        seen = { method: req.method ?? '', url: req.url ?? '', body: data }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    const fake = fakeWebview()
    const tunnel = attachWebTunnel(fake.webview, baseUrl)
    fake.inbound({
      type: 'dsh.fetch',
      id: 'u1',
      path: '/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"payload":{}}',
    })
    await vi_waitFor(() => fake.outbound.some(frame =>
      (frame as { type?: string; id?: string }).type === 'dsh.fetch.end'))
    expect(seen).toMatchObject({ method: 'POST', url: '/api/session.list', body: '{"payload":{}}' })
    const head = fake.outbound[0] as { type: string; id: string; status: number }
    expect(head).toMatchObject({ type: 'dsh.fetch.head', id: 'u1', status: 200 })
    const end = fake.outbound.at(-1) as { type: string; error?: string }
    expect(end).toMatchObject({ type: 'dsh.fetch.end', id: 'u1' })
    expect(end.error).toBeUndefined()
    tunnel.dispose()
  })

  it('streams an SSE body as ordered chunks before the terminal frame', async () => {
    baseUrl = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      setTimeout(() => { res.write('data: two\n\n'); res.end() }, 20)
    })
    const fake = fakeWebview()
    const tunnel = attachWebTunnel(fake.webview, baseUrl)
    fake.inbound({ type: 'dsh.fetch', id: 's1', path: '/api/events.mux', method: 'GET', headers: {} })
    await vi_waitFor(() => fake.outbound.some(frame =>
      (frame as { type?: string; id?: string }).type === 'dsh.fetch.end' && (frame as { id?: string }).id === 's1'))
    const chunks = fake.outbound
      .filter(frame => (frame as { type?: string }).type === 'dsh.fetch.chunk')
      .map(frame => Buffer.from((frame as { chunk: string }).chunk, 'base64').toString('utf8'))
      .join('')
    expect(chunks).toContain('data: one')
    expect(chunks).toContain('data: two')
    tunnel.dispose()
  })

  it('aborts an in-flight request when the webview asks', async () => {
    let serverAborted = false
    baseUrl = await listen((req, res) => {
      hanging.add(res)
      req.on('aborted', () => { serverAborted = true })
      res.on('close', () => { hanging.delete(res) })
      // Never responds; the abort tears the socket down.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
    })
    const fake = fakeWebview()
    const tunnel = attachWebTunnel(fake.webview, baseUrl)
    fake.inbound({ type: 'dsh.fetch', id: 'a1', path: '/api/events.host', method: 'GET', headers: {} })
    // Give the host one tick to issue fetch, then abort before any response body.
    await new Promise(resolve => setTimeout(resolve, 30))
    fake.inbound({ type: 'dsh.fetch.abort', id: 'a1' })
    await vi_waitFor(() => {
      const last = fake.outbound.at(-1) as { type?: string; id?: string; error?: string } | undefined
      return last?.type === 'dsh.fetch.end' && last.id === 'a1'
    })
    const end = fake.outbound.at(-1) as { type: string; id: string; error?: string }
    expect(end.error).toContain('abort')
    await vi_waitFor(() => serverAborted)
    tunnel.dispose()
  })

  it('reports transport failures on the terminal frame', async () => {
    baseUrl = await listen(() => { /* keep the server up, then stop it below */ })
    const fake = fakeWebview()
    const tunnel = attachWebTunnel(fake.webview, baseUrl)
    await new Promise<void>((resolve) => { server!.close(() => { resolve() }) })
    fake.inbound({ type: 'dsh.fetch', id: 'e1', path: '/api/session.list', method: 'GET', headers: {} })
    await vi_waitFor(() => {
      const last = fake.outbound.at(-1) as { type?: string; error?: string } | undefined
      return last?.type === 'dsh.fetch.end' && last.error !== undefined
    })
    tunnel.dispose()
  })

  describe('downlink WebSocket relay', () => {
    /** A scripted host socket: records the URL, exposes manual event triggers. */
    function fakeSocketFactory() {
      const sockets: Array<{
        url: string
        fire: (type: 'open' | 'message' | 'close' | 'error', data?: unknown) => void
        closed: () => boolean
      }> = []
      return {
        sockets,
        createSocket: (url: string) => {
          const handlers = new Map<string, Array<(event: { data?: unknown }) => void>>()
          const socket = {
            url,
            addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => {
              const list = handlers.get(type) ?? []
              list.push(listener)
              handlers.set(type, list)
            },
            close: () => { socket.fire('close') },
            fire: (type: 'open' | 'message' | 'close' | 'error', data?: unknown) => {
              for (const listener of handlers.get(type) ?? []) listener({ data })
            },
          }
          sockets.push(socket)
          return socket as never
        },
      }
    }

    it('opens one host socket per dsh.ws.open and relays its text frames', async () => {
      baseUrl = await listen(() => { /* no HTTP traffic expected */ })
      const fake = fakeWebview()
      const factory = fakeSocketFactory()
      const tunnel = attachWebTunnel(fake.webview, baseUrl, { createSocket: factory.createSocket })
      fake.inbound({ type: 'dsh.ws.open', id: 'w1', path: '/api/events.mux' })
      await vi_waitFor(() => factory.sockets.length === 1)
      expect(factory.sockets[0]!.url).toBe(`ws://127.0.0.1:${new URL(baseUrl).port}/api/events.mux`)
      factory.sockets[0]!.fire('open')
      await vi_waitFor(() => (fake.outbound[0] as { type?: string })?.type === 'dsh.ws.open')
      expect(fake.outbound[0]).toMatchObject({ type: 'dsh.ws.open', id: 'w1' })
      factory.sockets[0]!.fire('message', '{"a":1}')
      await vi_waitFor(() => (fake.outbound[1] as { type?: string })?.type === 'dsh.ws.frame')
      expect(fake.outbound[1]).toMatchObject({ type: 'dsh.ws.frame', id: 'w1', data: '{"a":1}' })
      factory.sockets[0]!.fire('close')
      await vi_waitFor(() => (fake.outbound.at(-1) as { type?: string })?.type === 'dsh.ws.end')
      expect(fake.outbound.at(-1)).toMatchObject({ type: 'dsh.ws.end', id: 'w1' })
      expect((fake.outbound.at(-1) as { error?: string }).error).toBeUndefined()
      tunnel.dispose()
    })

    it('closes the host socket on dsh.ws.close and on disposal', async () => {
      baseUrl = await listen(() => { /* no HTTP traffic expected */ })
      const fake = fakeWebview()
      const factory = fakeSocketFactory()
      const tunnel = attachWebTunnel(fake.webview, baseUrl, { createSocket: factory.createSocket })
      fake.inbound({ type: 'dsh.ws.open', id: 'w1', path: '/api/events.host' })
      await vi_waitFor(() => factory.sockets.length === 1)
      fake.inbound({ type: 'dsh.ws.close', id: 'w1' })
      await vi_waitFor(() => (fake.outbound.at(-1) as { type?: string })?.type === 'dsh.ws.end')
      tunnel.dispose()
    })

    it('terminates with an error frame when the socket errors', async () => {
      baseUrl = await listen(() => { /* no HTTP traffic expected */ })
      const fake = fakeWebview()
      const factory = fakeSocketFactory()
      const tunnel = attachWebTunnel(fake.webview, baseUrl, { createSocket: factory.createSocket })
      fake.inbound({ type: 'dsh.ws.open', id: 'w1', path: '/api/events.mux' })
      await vi_waitFor(() => factory.sockets.length === 1)
      factory.sockets[0]!.fire('error')
      await vi_waitFor(() => {
        const last = fake.outbound.at(-1) as { type?: string; error?: string } | undefined
        return last?.type === 'dsh.ws.end' && last.error !== undefined
      })
      tunnel.dispose()
    })
  })
})

/** Poll until the predicate holds or the timeout elapses. */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
