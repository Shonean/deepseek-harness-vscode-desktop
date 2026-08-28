import { describe, expect, it } from 'vitest'
import { parseDeepLink } from '../src/native/deeplink.ts'
import { buildAppMenuTemplate } from '../src/native/menu.ts'
import { sseDataPayload, turnEndSessionId, watchTurnEnd } from '../src/native/notifications.ts'

describe('application menu template', () => {
  it('leads with the app menu on darwin', () => {
    const template = buildAppMenuTemplate('darwin')
    expect(template[0]).toMatchObject({ role: 'appMenu' })
  })

  it('leads with the file menu elsewhere', () => {
    for (const platform of ['win32', 'linux', 'freebsd'] as const) {
      const template = buildAppMenuTemplate(platform)
      expect(template[0]).toMatchObject({ role: 'fileMenu' })
    }
  })

  it('always carries edit, view, window, and help menus', () => {
    const template = buildAppMenuTemplate('win32')
    const roles = template.map(item => item.role)
    expect(roles).toEqual(expect.arrayContaining(['editMenu', 'viewMenu', 'windowMenu', 'help']))
  })
})

describe('deep link parsing', () => {
  it('parses dsh://session/<id> into a session target', () => {
    expect(parseDeepLink('dsh://session/abc-123')).toEqual({ sessionId: 'abc-123' })
  })

  it('parses target-less links as focus-only', () => {
    expect(parseDeepLink('dsh://')).toEqual({})
    expect(parseDeepLink('dsh://focus')).toEqual({})
  })

  it('rejects non-dsh schemes', () => {
    expect(parseDeepLink('https://example.com')).toBeUndefined()
  })

  it('rejects malformed URLs', () => {
    expect(parseDeepLink('not a url')).toBeUndefined()
  })

  it('rejects unknown dsh hosts', () => {
    expect(parseDeepLink('dsh://unknown/path')).toBeUndefined()
  })
})

describe('turn-end SSE matching', () => {
  it('extracts the data payload of one SSE block', () => {
    const block = 'data: {"rpcId":1,"payload":{"type":"session/event"}}'
    expect(sseDataPayload(block)).toMatchObject({ rpcId: 1 })
  })

  it('returns undefined for blocks without data lines', () => {
    expect(sseDataPayload(': keepalive\n\n')).toBeUndefined()
  })

  it('returns undefined for non-JSON data', () => {
    expect(sseDataPayload('data: not json')).toBeUndefined()
  })

  it('matches a turn/end event and returns its session id', () => {
    const frame = {
      rpcId: 7,
      payload: { type: 'session/event', sessionId: 'sess-1', event: { type: 'turn/end' } },
    }
    expect(turnEndSessionId(frame)).toBe('sess-1')
  })

  it('ignores other session events', () => {
    const frame = {
      rpcId: 7,
      payload: { type: 'session/event', sessionId: 'sess-1', event: { type: 'assistant/message' } },
    }
    expect(turnEndSessionId(frame)).toBeUndefined()
  })

  it('ignores non session/event frames', () => {
    expect(turnEndSessionId({ rpcId: 1, payload: { type: 'session/subscribed', sessionId: 's' } })).toBeUndefined()
    expect(turnEndSessionId('garbage')).toBeUndefined()
    expect(turnEndSessionId(undefined)).toBeUndefined()
  })
})

describe('watchTurnEnd', () => {
  /** A minimal Response-like body that replays one text chunk, then ends. */
  function oneShotBody(text: string): unknown {
    return {
      ok: true,
      body: {
        getReader() {
          let replayed = false
          return {
            read: async () => {
              if (replayed) return { done: true, value: undefined }
              replayed = true
              return { done: false, value: new TextEncoder().encode(text) }
            },
            cancel: async () => {},
          }
        },
      },
    }
  }

  it('notifies once per turn/end event across SSE blocks', async () => {
    const body = 'data: {"rpcId":1,"payload":{"type":"session/event","sessionId":"a","event":{"type":"user/message"}}}\n\n'
      + 'data: {"rpcId":2,"payload":{"type":"session/event","sessionId":"b","event":{"type":"turn/end"}}}\n\n'
    const notified: string[] = []
    const controller = new AbortController()
    await watchTurnEnd('http://kernel', (sessionId) => { notified.push(sessionId) }, controller.signal, () => Promise.resolve(oneShotBody(body) as Response))
    expect(notified).toEqual(['b'])
  })

  it('stays silent when the stream is not ok', async () => {
    const notified: string[] = []
    const controller = new AbortController()
    await watchTurnEnd('http://kernel', (sessionId) => { notified.push(sessionId) }, controller.signal, () => Promise.resolve({ ok: false, body: null } as unknown as Response))
    expect(notified).toEqual([])
  })
})
