/**
 * Pure index-rewriting helpers for the Electron renderer: the built web SPA
 * ships root-relative asset URLs (`/assets/index-…js`) which resolve
 * correctly once the document itself is served from the same custom-scheme
 * origin. The main process therefore only needs to prepend a strict CSP meta
 * tag and the renderer-transport IIFE directly after `<head>`, so the SPA sees
 * `window.__DSH_TRANSPORT__` before its own modules boot. Pure functions keep
 * the document contract testable without Electron.
 * @module renderer/index
 */

/**
 * Rewrite root-relative `src`/`href` URLs in the built index against a
 * different origin. Retained for parity with the VSCode webview host and for
 * any future `file://` or packaged-resource load; the custom-scheme load path
 * does not need it because the document is already served from the origin the
 * assets reference.
 * @param html - the built index document.
 * @param rewrite - maps a root-relative path to a loadable URL.
 * @returns the rewritten document.
 */
export function rewriteIndexUrls(html: string, rewrite: (path: string) => string): string {
  return html.replace(/(src|href)="\/([^"]*)"/g, (_match, attribute: string, path: string) => {
    return `${attribute}="${rewrite('/' + path)}"`
  })
}

/**
 * Build the final renderer document: a strict CSP meta tag, then the transport
 * IIFE, then the SPA index. The transport script must precede every SPA script
 * — the connection plugin reads `window.__DSH_TRANSPORT__` during boot — so it
 * is injected directly after `<head>`.
 * @param html - the index document (root-relative URLs already correct).
 * @param csp - the Content-Security-Policy header value.
 * @param transportSrc - loadable URL of the bundled renderer-transport IIFE.
 * @param extraHeadScript - optional inline script to run before the transport
 *   and SPA (e.g. seeding the persisted session selection).
 * @returns the renderer document.
 */
export function buildRendererHtml(
  html: string,
  csp: string,
  transportSrc: string,
  extraHeadScript = '',
): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
  const transport = `<script src="${transportSrc}"></script>`
  const prefix = extraHeadScript.length > 0
    ? `${head}\n${extraHeadScript}\n${transport}`
    : `${head}\n${transport}`
  return html.includes('<head>')
    ? html.replace('<head>', `<head>\n${prefix}`)
    : `${prefix}\n${html}`
}

/**
 * The renderer's Content-Security-Policy. Every script, style, image, and font
 * resolves under the same privileged custom-scheme origin the main process
 * registers; API traffic rides the MessagePort carrier, not fetch, so
 * `connect-src 'none'` keeps the page from ever reaching a network. Inline
 * scripts stay allowed because the built index carries nonce-less inline boot
 * globals (`__DSH_BOOT__`, theme) the static frontend emits without nonce
 * support, mirroring the VSCode panel CSP.
 * @param schemeOrigin - the custom-scheme origin (e.g. `dsh-assets://root`).
 * @returns the policy value.
 */
export function rendererCsp(schemeOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src ${schemeOrigin} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${schemeOrigin} 'unsafe-inline'`,
    `img-src ${schemeOrigin} data: blob:`,
    `font-src ${schemeOrigin} data:`,
    `manifest-src ${schemeOrigin}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; ')
}

/** localStorage key the SPA reads to restore its current session on boot. */
export const SESSION_SELECTION_KEY = 'dsh.sessions.current'

/**
 * Build an inline script that seeds the SPA's persisted session selection so
 * it opens one session on boot. The SPA stores the selection as a JSON string
 * inside localStorage, so the seed double-encodes it.
 * @param sessionId - target session id.
 * @returns the inline `<script>` text.
 */
export function sessionSeedScript(sessionId: string): string {
  return `<script>localStorage.setItem(${JSON.stringify(SESSION_SELECTION_KEY)}, `
    + `${JSON.stringify(JSON.stringify({ sessionId }))});</script>`
}
