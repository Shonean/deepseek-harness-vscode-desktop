/**
 * Embedded-carrier detection. A native host embeds this document and installs
 * `window.__DSH_TRANSPORT__` before the shell boots (the VSCode panel does;
 * the client-web boot half consumes the same marker as transport hooks), so
 * past shell boot its presence is a stable fact meaning "the native host owns
 * the app chrome". The layout reads it once at store creation to select the
 * embedded frame mode, where the session/navigation column belongs to the
 * host UI instead of the document.
 */

/** The structural slice of `globalThis` the carrier marker lives on. */
interface TransportCarrierGlobal {
  /** Installed by the embedding host's preload; absent under plain browsers. */
  __DSH_TRANSPORT__?: unknown
}

/**
 * Whether this document runs under an embedded carrier. Pure environment
 * read — evaluate once at composition time, never inside render ticks.
 * @returns true when a carrier marker is installed.
 */
export function hasTransportCarrier(): boolean {
  return (globalThis as TransportCarrierGlobal).__DSH_TRANSPORT__ !== undefined
}
