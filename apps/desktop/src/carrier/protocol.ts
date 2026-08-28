/**
 * The MessagePort carrier's wire protocol, shared by the main-process host
 * half and the renderer client half. It is byte-for-byte the same frame
 * contract the VSCode extension's postMessage tunnel uses
 * (apps/vscode/src/tunnel.ts): request and abort frames renderer→main,
 * head/chunk/end frames main→renderer. Keeping the two carriers symmetric is
 * deliberate — the D2 extraction of the host-half adapter into a shared
 * package consumes exactly this union.
 * @module carrier/protocol
 */

/** Inbound request from the renderer: one bridged fetch. */
export interface CarrierFetchRequest {
  type: 'dsh.fetch'
  /** Caller-correlation id, minted by the renderer. */
  id: string
  /** URL path plus query, starting at `/`. */
  path: string
  method: string
  headers: Record<string, string>
  /** Request body as UTF-8 text; absent for body-less requests. */
  body?: string
}

/** Inbound abort for one in-flight request. */
export interface CarrierFetchAbort {
  type: 'dsh.fetch.abort'
  id: string
}

/** Everything the host half consumes from the renderer. */
export type CarrierInbound = CarrierFetchRequest | CarrierFetchAbort

/** Outbound head frame: status plus response headers. */
export interface CarrierHeadFrame {
  type: 'dsh.fetch.head'
  id: string
  status: number
  headers: Record<string, string>
}

/** Outbound body frame: one base64 slice of the response stream. */
export interface CarrierChunkFrame {
  type: 'dsh.fetch.chunk'
  id: string
  /** Base64-encoded bytes, sized by the host half's chunk constant. */
  chunk: string
}

/** Terminal frame: success or an error message. */
export interface CarrierEndFrame {
  type: 'dsh.fetch.end'
  id: string
  /** Present when the request or its stream failed. */
  error?: string
}

/** Every frame the host half emits to the renderer. */
export type CarrierOutbound = CarrierHeadFrame | CarrierChunkFrame | CarrierEndFrame

/** Narrow the wire type at one port boundary. */
export function isCarrierInbound(value: unknown): value is CarrierInbound {
  return typeof value === 'object' && value !== null
    && 'type' in value
    && ((value as { type: string }).type === 'dsh.fetch'
      || (value as { type: string }).type === 'dsh.fetch.abort')
}

/** Narrow an outbound frame; used only by tests and dev assertions. */
export function isCarrierOutbound(value: unknown): value is CarrierOutbound {
  return typeof value === 'object' && value !== null
    && 'type' in value
    && ((value as { type: string }).type === 'dsh.fetch.head'
      || (value as { type: string }).type === 'dsh.fetch.chunk'
      || (value as { type: string }).type === 'dsh.fetch.end')
}
