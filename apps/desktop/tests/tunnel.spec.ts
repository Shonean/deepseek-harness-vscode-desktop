import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { attachMessagePortTunnel, type TunnelPort } from '../src/carrier/tunnel.ts'
import type { CarrierInbound, CarrierOutbound } from '../src/carrier/protocol.ts'

/**
 * Host-half tunnel contract: request relay, streaming bodies, terminal
 * frames, aborts, and disposal. The renderer side is a scripted double that
 * captures outbound frames and replays inbound ones; the kernel side is a
 * real loopback HTTP server so fetch streaming paths are exercised.
 */
describe('desktop MessagePort tunnel host half', () => {
  let server: Server | undefined
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
  async function listen(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<string> {
    server = createServer(handler)
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return `http://127.0.0.1:${String(address.port)}`
  }

  /** A scripted MessagePort: captures outbound frames, replays inbound ones. */
  function fakePort(): { port: TunnelPort; outbound: CarrierOutbound[]; inbound(message: CarrierInbound): void } {
    const outbound: CarrierOutbound[] = []
    let listener: ((event: { data: unknown }) => void) | undefined
    const port: TunnelPort = {
      on: (_event, l) => { listener = l; return port },
      off: () => { listener = undefined; return port },
      start: () => {},
      close: () => { listener = undefined },
      postMessage: (message: unknown) => { outbound.push(message as CarrierOutbound) },
    }
    return {
      port,
      outbound,
      inbound: (message: CarrierInbound) => { listener?.({ data: message }) },
    }
  }

  it('relays a unary request: method, headers, body, and the JSON response', async () => {
    let seen: { method: string; url: string; body: string } | undefined
    const baseUrl = await listen((req, res) => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8') })
      req.on('end', () => {
        seen = { method: req.method ?? '', url: req.url ?? '', body: data }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    const fake = fakePort()
    const tunnel = attachMessagePortTunnel(fake.port, baseUrl)
    fake.inbound({
      type: 'dsh.fetch',
      id: 'u1',
      path: '/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"payload":{}}',
    })
    await waitFor(() => fake.outbound.some(frame => frame.type === 'dsh.fetch.end' && frame.id === 'u1'))
    expect(seen).toMatchObject({ method: 'POST', url: '/api/session.list', body: '{"payload":{}}' })
    const head = fake.outbound[0]
    expect(head).toMatchObject({ type: 'dsh.fetch.head', id: 'u1', status: 200 })
    const end = fake.outbound.at(-1)
    expect(end).toMatchObject({ type: 'dsh.fetch.end', id: 'u1' })
    tunnel.dispose()
  })

  it('streams an SSE body as ordered chunks before the terminal frame', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      setTimeout(() => { res.write('data: two\n\n'); res.end() }, 20)
    })
    const fake = fakePort()
    const tunnel = attachMessagePortTunnel(fake.port, baseUrl)
    fake.inbound({ type: 'dsh.fetch', id: 's1', path: '/api/events.mux', method: 'GET', headers: {} })
    await waitFor(() => fake.outbound.some(frame =>
      frame.type === 'dsh.fetch.end' && frame.id === 's1'))
    const chunks = fake.outbound
      .filter((frame): frame is Extract<CarrierOutbound, { type: 'dsh.fetch.chunk' }> =>
        frame.type === 'dsh.fetch.chunk')
      .map(frame => Buffer.from(frame.chunk, 'base64').toString('utf8'))
      .join('')
    expect(chunks).toContain('data: one')
    expect(chunks).toContain('data: two')
    tunnel.dispose()
  })

  it('ignores frames that do not match the carrier protocol', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok')
    })
    const fake = fakePort()
    const tunnel = attachMessagePortTunnel(fake.port, baseUrl)
    fake.inbound({ type: 'unrelated', ignored: true } as unknown as CarrierInbound)
    // Give the port a tick; no outbound frames should have appeared.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fake.outbound).toHaveLength(0)
    tunnel.dispose()
  })

  it('aborts an in-flight request when the renderer asks', async () => {
    let serverAborted = false
    const baseUrl = await listen((req, res) => {
      hanging.add(res)
      req.on('aborted', () => { serverAborted = true })
      res.on('close', () => { hanging.delete(res) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
    })
    const fake = fakePort()
    const tunnel = attachMessagePortTunnel(fake.port, baseUrl)
    fake.inbound({ type: 'dsh.fetch', id: 'a1', path: '/api/events.host', method: 'GET', headers: {} })
    await new Promise(resolve => setTimeout(resolve, 30))
    fake.inbound({ type: 'dsh.fetch.abort', id: 'a1' })
    await waitFor(() => {
      const last = fake.outbound.at(-1)
      return last?.type === 'dsh.fetch.end' && last.id === 'a1'
    })
    const end = fake.outbound.at(-1) as Extract<CarrierOutbound, { type: 'dsh.fetch.end' }>
    expect(end.error).toContain('abort')
    await waitFor(() => serverAborted)
    tunnel.dispose()
  })

  it('closes the port on dispose and aborts every in-flight request', async () => {
    const baseUrl = await listen((_req, res) => {
      hanging.add(res)
      res.on('close', () => { hanging.delete(res) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
    })
    const fake = fakePort()
    let closed = false
    const originalClose = fake.port.close.bind(fake.port)
    fake.port.close = () => { closed = true; originalClose() }
    const tunnel = attachMessagePortTunnel(fake.port, baseUrl)
    fake.inbound({ type: 'dsh.fetch', id: 'd1', path: '/x', method: 'GET', headers: {} })
    await new Promise(resolve => setTimeout(resolve, 20))
    tunnel.dispose()
    expect(closed).toBe(true)
  })
})

/** Poll until the predicate holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
