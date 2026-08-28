import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ASSET_ORIGIN,
  isIndexUrl,
  mimeTypeFor,
  resolveAssetPathname,
} from '../src/renderer/protocol.ts'

/**
 * Custom-scheme asset path resolution: the transport IIFE maps into this app's
 * build directory, every other path maps under the frontend dist root, and
 * traversal attempts are rejected. These rules keep the renderer from reading
 * arbitrary filesystem paths through the protocol handler.
 */
describe('desktop asset protocol path resolution', () => {
  const distRoot = '/tmp/dsh-web/dist'
  const appBuildDir = '/tmp/dsh-desktop/dist'

  it('serves the transport IIFE from the app build directory', () => {
    expect(resolveAssetPathname('/renderer-transport.js', distRoot, appBuildDir))
      .toBe(join(appBuildDir, 'renderer-transport.js'))
  })

  it('maps frontend assets under the dist root', () => {
    expect(resolveAssetPathname('/assets/index-abc.js', distRoot, appBuildDir))
      .toBe(join(distRoot, 'assets/index-abc.js'))
    expect(resolveAssetPathname('/favicon.svg', distRoot, appBuildDir))
      .toBe(join(distRoot, 'favicon.svg'))
  })

  it('rejects path traversal outside the dist root', () => {
    expect(resolveAssetPathname('/../etc/passwd', distRoot, appBuildDir)).toBeUndefined()
    expect(resolveAssetPathname('/assets/../../secrets', distRoot, appBuildDir)).toBeUndefined()
  })

  it('rejects the dist root itself (no directory listing)', () => {
    expect(resolveAssetPathname('/', distRoot, appBuildDir)).toBeUndefined()
  })

  it('exposes the custom-scheme origin used by the renderer CSP', () => {
    expect(ASSET_ORIGIN).toBe('dsh-assets://root')
  })

  it('recognizes the document URLs and rejects other paths', () => {
    expect(isIndexUrl('dsh-assets://root/')).toBe(true)
    expect(isIndexUrl('dsh-assets://root/index.html')).toBe(true)
    expect(isIndexUrl('dsh-assets://root/assets/x.js')).toBe(false)
    expect(isIndexUrl('http://other/')).toBe(false)
  })

  it('maps extensions to MIME types for the dist assets', () => {
    expect(mimeTypeFor('/x/app.js')).toBe('text/javascript; charset=utf-8')
    expect(mimeTypeFor('/x/app.css')).toBe('text/css; charset=utf-8')
    expect(mimeTypeFor('/x/favicon.svg')).toBe('image/svg+xml')
    expect(mimeTypeFor('/x/manifest.webmanifest')).toBe('application/manifest+json; charset=utf-8')
    expect(mimeTypeFor('/x/blob.bin')).toBe('application/octet-stream')
  })
})
