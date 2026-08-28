/**
 * Pure helpers for the renderer custom-scheme asset protocol: the custom
 * scheme and origin constants, MIME lookup, and the path resolver that maps a
 * request pathname to either this app's bundled renderer-transport IIFE or a
 * static file under the frontend dist. Kept free of Electron imports so the
 * path-traversal contract is unit-testable without forking a shell.
 * @module renderer/protocol
 */
import { extname, join, relative } from 'node:path'

/** Custom scheme that serves the bundled frontend and the transport IIFE. */
export const ASSET_SCHEME = 'dsh-assets'
/** Host component under the scheme; every path is relative to one root. */
export const ASSET_HOST = 'root'
/** Origin the renderer CSP whitelists. */
export const ASSET_ORIGIN = `${ASSET_SCHEME}://${ASSET_HOST}`
/** Document URL the BrowserWindow loads. */
export const INDEX_URL = `${ASSET_ORIGIN}/`
/** Reserved path serving the bundled renderer-transport IIFE. */
export const TRANSPORT_PATH = '/renderer-transport.js'

/** MIME type table for the small set of static files the frontend dist ships. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/**
 * Look up the MIME type for a static asset by file extension.
 * @param file - absolute or relative path; only its extension is consulted.
 * @returns the MIME type, or `application/octet-stream` when unknown.
 */
export function mimeTypeFor(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Map a custom-scheme request pathname to a filesystem path under the
 * frontend dist root, or to the renderer-transport IIFE in this app's build
 * directory. Returns `undefined` for any path that escapes its root. The
 * check rejects `..` segments explicitly rather than relying on
 * `posix.normalize`, which collapses a root-relative `/../x` into `/x` and
 * would silently accept traversal attempts.
 * @param pathname - decoded URL pathname (starts with `/`).
 * @param distRoot - absolute path of the built frontend dist.
 * @param appBuildDir - absolute path of this app's `dist` build output.
 * @returns the absolute file path to serve, or `undefined` on traversal.
 */
export function resolveAssetPathname(
  pathname: string,
  distRoot: string,
  appBuildDir: string,
): string | undefined {
  if (pathname === TRANSPORT_PATH) return join(appBuildDir, 'renderer-transport.js')
  const stripped = pathname.replace(/^\/+/, '')
  if (stripped === '') return undefined
  const segments = stripped.split('/')
  if (segments.some(segment => segment === '..' || segment === '.')) return undefined
  const candidate = join(distRoot, ...segments)
  const rel = relative(distRoot, candidate)
  if (rel === '' || rel.startsWith('..')) return undefined
  return candidate
}

/**
 * Determine whether an incoming custom-scheme URL targets the renderer
 * document (so the main process can return the injected HTML instead of a
 * static file).
 * @param url - the full request URL.
 * @returns true when the URL's host matches and its pathname is `/` or `/index.html`.
 */
export function isIndexUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.host !== ASSET_HOST) return false
  const pathname = decodeURIComponent(parsed.pathname)
  return pathname === '/' || pathname === '/index.html'
}
