/**
 * The host half of the desktop carrier: runs in the Electron main process and
 * relays renderer fetch requests to the kernel child's loopback base URL,
 * streaming response bodies back as head/chunk/end frames over a
 * `MessagePortMain`. The renderer never speaks to the network itself; the main
 * process is the single privileged surface between the SPA and the kernel,
 * exactly as the VSCode extension's `attachWebTunnel` is for its webview.
 * @module carrier/tunnel
 */
import { Buffer } from 'node:buffer'
import type { CarrierFetchRequest, CarrierInbound, CarrierOutbound } from './protocol.ts'
import { isCarrierInbound } from './protocol.ts'

/** The slice of `MessagePortMain` the tunnel consumes; narrow so tests can script it. */
export interface TunnelPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  off(event: 'message', listener: (event: { data: unknown }) => void): unknown
  start(): void
  close(): void
  postMessage(message: unknown): void
}

/** Fetch shape the tunnel relays into (global fetch or an injected fake). */
export type TunnelFetch = (url: string, init: RequestInit) => Promise<Response>

/** Chunk size for streaming response bodies back over MessagePort (64 KiB). */
const CHUNK_BYTES = 64 * 1024

/**
 * Attach the tunnel to one renderer-side port. Every inbound `dsh.fetch` runs
 * against `baseUrl` with a per-request `AbortController`; `dispose()` closes
 * the port and aborts every request still in flight.
 * @param port - the renderer end of the main↔renderer `MessageChannelMain`.
 * @param baseUrl - kernel loopback base URL, no trailing slash.
 * @param doFetch - transport; production passes global fetch, tests inject.
 * @returns the tunnel's disposer.
 */
export function attachMessagePortTunnel(
  port: TunnelPort,
  baseUrl: string,
  doFetch: TunnelFetch = (url, init) => fetch(url, init),
): { dispose(): void } {
  const inFlight = new Map<string, AbortController>()
  let disposed = false

  const send = (frame: CarrierOutbound): void => {
    if (disposed) return
    port.postMessage(frame)
  }

  const run = async (message: CarrierFetchRequest): Promise<void> => {
    const controller = new AbortController()
    inFlight.set(message.id, controller)
    try {
      const response = await doFetch(baseUrl + message.path, {
        method: message.method,
        headers: message.headers,
        ...message.body === undefined ? {} : { body: message.body },
        signal: controller.signal,
      })
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
        send({
          type: 'dsh.fetch.end',
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    } catch (error) {
      send({
        type: 'dsh.fetch.end',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      inFlight.delete(message.id)
    }
  }

  const onMessage = (event: { data: unknown }): void => {
    if (!isCarrierInbound(event.data)) return
    const message: CarrierInbound = event.data
    if (message.type === 'dsh.fetch') {
      void run(message)
      return
    }
    inFlight.get(message.id)?.abort()
  }

  port.on('message', onMessage)
  port.start()

  return {
    dispose(): void {
      disposed = true
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
      port.off('message', onMessage)
      port.close()
    },
  }
}
