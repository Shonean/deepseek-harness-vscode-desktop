/**
 * Turn-end notification for the desktop shell. The main process opens its own
 * SSE stream to the kernel's `events.mux` endpoint (the same downlink the SPA
 * consumes — the base API client reads it as SSE-over-fetch, so the carrier
 * bridges it into the renderer while the main process can read it directly on
 * loopback). The stream is watched for `session/event` frames whose event
 * `type` is `turn/end`; each match triggers the notification callback.
 *
 * The parsing helpers are pure so the wire contract is unit-testable; the
 * notifier itself takes an injected fetch so tests can feed synthetic SSE.
 * @module native/notifications
 */

/** Extract the `data:` payload of one SSE event block, or `undefined`. */
export function sseDataPayload(block: string): unknown {
  const data = block.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
  if (data.length === 0) return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

/**
 * Decide whether one parsed mux frame is a `turn/end` event and, if so, which
 * session it belongs to. Lenient by design: the notifier only needs the
 * session id; a malformed or unexpected frame simply yields `undefined` and is
 * skipped.
 * @param frame - a parsed ServerRequest frame (any shape).
 * @returns the session id, or `undefined` when the frame is not a turn end.
 */
export function turnEndSessionId(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const payload = (frame as { payload?: unknown }).payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const p = payload as { type?: unknown; sessionId?: unknown; event?: unknown }
  if (p.type !== 'session/event') return undefined
  const event = p.event as { type?: unknown } | undefined
  if (event == null || typeof event !== 'object' || event.type !== 'turn/end') return undefined
  return typeof p.sessionId === 'string' ? p.sessionId : undefined
}

/** Stream reader the notifier consumes; production passes global fetch. */
export type NotifierFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Watch the kernel's mux SSE stream and call `notify` on every `turn/end`.
 * Reads until the stream closes or `signal` aborts. Errors are silent: a lost
 * stream must never take the shell down — the SPA's own gap detection owns
 * event recovery; the notifier is best-effort chrome.
 * @param baseUrl - kernel loopback base URL, no trailing slash.
 * @param notify - invoked with the session id of each completed turn.
 * @param signal - abort to stop watching.
 * @param doFetch - injected transport (defaults to global fetch).
 */
export async function watchTurnEnd(
  baseUrl: string,
  notify: (sessionId: string) => void,
  signal: AbortSignal,
  doFetch: NotifierFetch = (url, init) => fetch(url, init),
): Promise<void> {
  let response: Response
  try {
    response = await doFetch(`${baseUrl}/api/events.mux`, { signal })
  } catch {
    return
  }
  if (!response.ok || response.body === null) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const sessionId = turnEndSessionId(sseDataPayload(block))
        if (sessionId !== undefined) notify(sessionId)
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch {
    // stream error or abort — best-effort, swallow.
  } finally {
    reader.cancel().catch(() => undefined)
  }
}
