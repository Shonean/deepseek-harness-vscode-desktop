import { describe, expect, it } from 'vitest'
import {
  buildRendererHtml,
  rendererCsp,
  rewriteIndexUrls,
  SESSION_SELECTION_KEY,
  sessionSeedScript,
} from '../src/renderer/index.ts'

/**
 * Renderer document contract: CSP + transport injection ordering, root-relative
 * URL rewriting, and the session-seed script. These pin what the document must
 * satisfy for the SPA to boot inside the desktop shell.
 */
describe('desktop renderer document', () => {
  const rendered = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>DSH Desktop</title>
<script>window.__DSH_BOOT__ = {"modules":[]};</script>
<script type="module" src="/assets/index-abc123.js"></script>
<link rel="stylesheet" href="/assets/index-abc123.css">
</head>
<body><div id="root"></div></body>
</html>`

  it('rewrites only root-relative src and href values to the given base', () => {
    const rewritten = rewriteIndexUrls(rendered, path => `dsh-assets://root${path}`)
    expect(rewritten).toContain('src="dsh-assets://root/assets/index-abc123.js"')
    expect(rewritten).toContain('href="dsh-assets://root/assets/index-abc123.css"')
    expect(rewritten).not.toContain('src="/assets/')
    expect(rewritten).toContain('lang="en"')
    expect(rewritten).toContain('charset="UTF-8"')
  })

  it('injects the CSP and the transport script directly after <head>', () => {
    const html = buildRendererHtml(
      rendered,
      "default-src 'none'",
      'dsh-assets://root/renderer-transport.js',
    )
    const headIndex = html.indexOf('<head>')
    expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(headIndex)
    expect(html.indexOf('renderer-transport.js')).toBeGreaterThan(headIndex)
    expect(html.indexOf('renderer-transport.js')).toBeLessThan(html.indexOf('assets/index-abc123.js'))
  })

  it('keeps the kernel-rendered boot manifest intact', () => {
    const html = buildRendererHtml(rendered, "default-src 'none'", 'dsh-assets://root/t.js')
    expect(html).toContain('__DSH_BOOT__')
    expect(html).toContain('<div id="root"></div>')
  })

  it('builds a CSP that allows local resources, disallows connect and frames', () => {
    const csp = rendererCsp('dsh-assets://root')
    expect(csp).toContain("script-src dsh-assets://root 'unsafe-inline'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("object-src 'none'")
  })

  it('injects the optional seed script before the transport and SPA scripts', () => {
    const seed = sessionSeedScript('sess_123')
    const html = buildRendererHtml(rendered, "default-src 'none'", 'dsh-assets://root/t.js', seed)
    const seedIndex = html.indexOf(SESSION_SELECTION_KEY)
    expect(seedIndex).toBeGreaterThan(html.indexOf('<head>'))
    expect(seedIndex).toBeLessThan(html.indexOf('t.js'))
    expect(html.indexOf('t.js')).toBeLessThan(html.indexOf('assets/index-abc123.js'))
  })

  it('double-encodes the session id the way the SPA storage expects', () => {
    const script = sessionSeedScript('sess_abc')
    expect(script).toContain(SESSION_SELECTION_KEY)
    expect(script).toContain(JSON.stringify(JSON.stringify({ sessionId: 'sess_abc' })))
  })

  it('prepends the prefix when the index has no <head>', () => {
    const headless = '<html><body>ok</body></html>'
    const html = buildRendererHtml(headless, 'default-src none', 't.js')
    expect(html.startsWith('<meta http-equiv=')).toBe(true)
    expect(html).toContain('t.js')
    expect(html.endsWith(headless)).toBe(true)
  })
})
