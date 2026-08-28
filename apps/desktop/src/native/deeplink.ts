/**
 * Pure `dsh://` deep-link parsing for the desktop shell. The shell registers
 * itself as the OS handler for the `dsh` scheme; when the OS re-invokes the
 * app with a `dsh://` URL (or a second instance delivers one), this module
 * decides what the shell should do: focus with no target, or focus and open a
 * referenced session.
 *
 * Supported forms:
 * - `dsh://session/<id>` — focus the window and open session `<id>`.
 * - `dsh://` / `dsh://focus` — focus the window only.
 * @module native/deeplink
 */

/** What a deep link asks the shell to do. */
export interface DeepLinkTarget {
  /** Session id to open, when the link references one. */
  sessionId?: string
}

/**
 * Parse a `dsh://` URL into a target. Anything that is not a `dsh:` URL, or
 * that names an unknown host, yields `undefined` and should be ignored; a
 * valid but target-less link yields `{}`.
 * @param url - the raw URL string the OS delivered.
 * @returns the target, or `undefined` when the link is not actionable.
 */
export function parseDeepLink(url: string): DeepLinkTarget | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'dsh:') return undefined
  if (parsed.host === 'session') {
    const id = parsed.pathname.replace(/^\/+/, '')
    if (id.length > 0) return { sessionId: id }
    return {}
  }
  if (parsed.host === 'focus' || parsed.host === '') return {}
  return undefined
}
