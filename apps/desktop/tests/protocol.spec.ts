import { describe, expect, it } from 'vitest'
import {
  isCarrierInbound,
  isCarrierOutbound,
  type CarrierFetchRequest,
  type CarrierInbound,
  type CarrierOutbound,
} from '../src/carrier/protocol.ts'

/**
 * Wire-protocol narrowers: the main-process tunnel receives `unknown` from the
 * MessagePort and the renderer transport receives `unknown` from its port
 * message handler. The narrowers reject anything that is not a well-formed
 * carrier frame so the rest of each half can switch on the discriminant
 * without further guards.
 */
describe('carrier protocol narrowers', () => {
  it('accepts a well-formed fetch request frame', () => {
    const frame: CarrierFetchRequest = {
      type: 'dsh.fetch',
      id: 't1',
      path: '/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }
    expect(isCarrierInbound(frame)).toBe(true)
    const narrowed: CarrierInbound = frame
    expect(narrowed.type).toBe('dsh.fetch')
  })

  it('accepts an abort frame', () => {
    expect(isCarrierInbound({ type: 'dsh.fetch.abort', id: 't1' })).toBe(true)
  })

  it('rejects frames with a missing discriminant or an unknown type', () => {
    expect(isCarrierInbound(null)).toBe(false)
    expect(isCarrierInbound(undefined)).toBe(false)
    expect(isCarrierInbound('dsh.fetch')).toBe(false)
    expect(isCarrierInbound(42)).toBe(false)
    expect(isCarrierInbound({})).toBe(false)
    expect(isCarrierInbound({ type: 'other', id: 't1' })).toBe(false)
  })

  it('accepts each outbound frame kind', () => {
    const head: CarrierOutbound = {
      type: 'dsh.fetch.head',
      id: 't1',
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }
    const chunk: CarrierOutbound = { type: 'dsh.fetch.chunk', id: 't1', chunk: 'aGVsbG8=' }
    const end: CarrierOutbound = { type: 'dsh.fetch.end', id: 't1' }
    expect(isCarrierOutbound(head)).toBe(true)
    expect(isCarrierOutbound(chunk)).toBe(true)
    expect(isCarrierOutbound(end)).toBe(true)
  })

  it('rejects non-frame outbound values', () => {
    expect(isCarrierOutbound(null)).toBe(false)
    expect(isCarrierOutbound({ type: 'dsh.fetch' })).toBe(false)
    expect(isCarrierOutbound({})).toBe(false)
  })
})
