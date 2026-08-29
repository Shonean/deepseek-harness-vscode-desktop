/**
 * Embedded-carrier detection for the settings entry. A native host (VSCode
 * panel, desktop shell) installs `window.__DSH_TRANSPORT__` before the shell
 * boots and owns the session/navigation column itself, so the document has no
 * sidebar to host the settings trigger; the entry rides `shell.overlay`
 * instead. Cross-plugin value imports are forbidden for client packages, so
 * this is a local three-line environment read mirroring ui-layout's
 * `hasTransportCarrier` rather than an import of it.
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
