import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  buildPanelHtml, inlinePluginScripts, panelCsp, pluginCachePath, pluginScriptPaths,
  rewriteIndexUrls, rewritePluginUrls, themeBridgeScript, vscodeThemeKindIsDark,
  type VscodeThemeKind,
} from '../src/webview-index.ts'

/**
 * Panel index rewriting: root-relative URL rewriting, transport-script
 * ordering, and the CSP. These pin what the panel document must satisfy for
 * the SPA to boot inside the webview.
 */
describe('web panel index rewriting', () => {
  const rendered = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>DeepSeek Harness</title>
<script>window.__DSH_BOOT__ = {"modules":[]};</script>
<script type="module" src="/assets/index-abc123.js"></script>
<link rel="stylesheet" href="/assets/index-abc123.css">
</head>
<body><div id="root"></div></body>
</html>`

  it('rewrites only root-relative src and href values to the given base', () => {
    const rewritten = rewriteIndexUrls(rendered, path => `https://media.test${path}`)
    expect(rewritten).toContain('src="https://media.test/assets/index-abc123.js"')
    expect(rewritten).toContain('href="https://media.test/assets/index-abc123.css"')
    expect(rewritten).not.toContain('src="/assets/')
    // Non-URL attributes and absolute URLs pass through untouched.
    expect(rewritten).toContain('lang="en"')
    expect(rewritten).toContain('charset="UTF-8"')
  })

  it('inlines preload scripts with function-form replacement: dollar signs literal, closing tags escaped', async () => {
    const html = '<html><head><script>window.__ModuleLoader__ = { mode: \'queue\' };</script>' +
      '<script src="/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=a"></script></head><body></body></html>'
    const body = 'window.__ModuleLoader__.load({ id: "m", tag: "$& tricks </script> here" });'
    const inlined = await inlinePluginScripts(html, async () => body)
    // The function-form replacer must not let String.replace expand `$&` into
    // the matched script tag.
    expect(inlined).toContain('tag: "$& tricks <\\/script> here"')
    expect(inlined).not.toContain('src="/plugins/')
    expect(inlined).toContain('window.__ModuleLoader__ = { mode: \'queue\' };')
  })

  it('strips the cache-busting query for the materialized cache path', () => {
    expect(pluginCachePath('/plugins/@deepseek-ai/dsh-a/client.js?rev=abc')).toBe('/plugins/@deepseek-ai/dsh-a/client.js')
    expect(pluginCachePath('/plugins/@deepseek-ai/dsh-a/client.js')).toBe('/plugins/@deepseek-ai/dsh-a/client.js')
  })

  it('collects kernel plugin routes from script tags and the boot manifest', () => {
    const html = '<html><head><script>window.__DSH_BOOT__ = {"bundles":{' +
      '"@deepseek-ai/dsh-ui-goal":"/plugins/@deepseek-ai/dsh-ui-goal/client.js?rev=aa"},' +
      '"preloads":["/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=bb"]}};</script>' +
      '<script src="/plugins/@deepseek-ai/dsh-client-runtime/client.js?rev=cc"></script>' +
      '<script type="module" src="/assets/index-abc123.js"></script></head><body></body></html>'
    expect(pluginScriptPaths(html)).toEqual([
      '/plugins/@deepseek-ai/dsh-ui-goal/client.js?rev=aa',
      '/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=bb',
      '/plugins/@deepseek-ai/dsh-client-runtime/client.js?rev=cc',
    ])
  })

  it('rewrites every plugin-route reference and keeps dollar signs literal', () => {
    const html = '<script src="/plugins/@deepseek-ai/dsh-a/client.js?rev=1"></script>' +
      '<script>window.__DSH_BOOT__ = {"b":"/plugins/@deepseek-ai/dsh-typert-registry/client.js?rev=$&x"}</script>'
    const rewritten = rewritePluginUrls(html, path => `https://media.test/cache${path}`)
    expect(rewritten).toContain('src="https://media.test/cache/plugins/@deepseek-ai/dsh-a/client.js?rev=1"')
    // The function-form replacer must not let String.replace treat `$&` as the
    // matched substring.
    expect(rewritten).toContain('"https://media.test/cache/plugins/@deepseek-ai/dsh-typert-registry/client.js?rev=$&x"')
    expect(rewritten).not.toContain('"/plugins/')
  })

  it('injects the CSP and the transport script directly after <head>', () => {
    const rewritten = rewriteIndexUrls(rendered, path => `https://media.test${path}`)
    const html = buildPanelHtml(rewritten, 'default-src \'none\'', 'https://media.test/dist/webview-transport.js')
    const headIndex = html.indexOf('<head>')
    expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(headIndex)
    expect(html.indexOf('webview-transport.js')).toBeGreaterThan(headIndex)
    // The transport must load before any SPA bundle: first script tag wins.
    expect(html.indexOf('webview-transport.js')).toBeLessThan(html.indexOf('assets/index-abc123.js'))
  })

  it('keeps the kernel-rendered boot manifest intact', () => {
    const html = buildPanelHtml(rendered, 'default-src \'none\'', 'https://media.test/t.js')
    expect(html).toContain('__DSH_BOOT__')
    expect(html).toContain('<div id="root"></div>')
  })

  it('builds a CSP that allows local resources and inline boot globals only', () => {
    const csp = panelCsp('https://abc.vscode-cdn.net')
    expect(csp).toContain("script-src https://abc.vscode-cdn.net 'unsafe-inline'")
    expect(csp).toContain('connect-src https://abc.vscode-cdn.net')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-src 'none'")
  })

  it('injects the optional seed script before the transport and SPA scripts', () => {
    const rewritten = rewriteIndexUrls(rendered, path => `https://media.test${path}`)
    const seed = "<script>localStorage.setItem('dsh.sessions.current', '{}')</script>"
    const html = buildPanelHtml(rewritten, "default-src 'none'", 'https://media.test/t.js', seed)
    const seedIndex = html.indexOf('dsh.sessions.current')
    expect(seedIndex).toBeGreaterThan(html.indexOf('<head>'))
    expect(seedIndex).toBeLessThan(html.indexOf('t.js'))
    expect(html.indexOf('t.js')).toBeLessThan(html.indexOf('assets/index-abc123.js'))
  })
})

describe('vscodeThemeKindIsDark', () => {
  it.each([
    ['light', false],
    ['dark', true],
    ['hc-light', false],
    ['hc-dark', true],
  ] as const)('maps %s to dark=%s', (kind, dark) => {
    expect(vscodeThemeKindIsDark(kind)).toBe(dark)
  })
})

describe('theme bridge script', () => {
  /**
   * A minimal browser sandbox: native matchMedia records queries, the bridge
   * overrides it, and we can later post host messages. Returns the color-scheme
   * MediaQueryList the bridge hands out plus a postTheme helper.
   */
  function loadBridge(initial: VscodeThemeKind) {
    const windowListeners = new Map<string, Array<(event: unknown) => void>>()
    const changeListeners = new Set<(event: unknown) => void>()
    const darkQuery = {
      matches: false,
      media: '(prefers-color-scheme: dark)',
      addEventListener(_type: string, callback: (event: unknown) => void) { changeListeners.add(callback) },
      removeEventListener(_type: string, callback: (event: unknown) => void) { changeListeners.delete(callback) },
      addListener(callback: (event: unknown) => void) { changeListeners.add(callback) },
      removeListener(callback: (event: unknown) => void) { changeListeners.delete(callback) },
      dispatchEvent() { return true },
      onchange: null as ((event: unknown) => void) | null,
    }
    const nativeQueries: string[] = []
    const sandboxWindow = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const list = windowListeners.get(type) ?? []
        list.push(listener)
        windowListeners.set(type, list)
      },
      matchMedia: (query: string) => {
        nativeQueries.push(query)
        return darkQuery
      },
    }
    const sandbox: {
      window: typeof sandboxWindow
      MediaQueryListEvent: unknown
      console: typeof console
      globalThis?: unknown
    } = {
      window: sandboxWindow,
      MediaQueryListEvent: class {
        readonly matches: boolean
        readonly media: string
        constructor(type: string, init: { matches: boolean; media: string }) {
          this.matches = init.matches
          this.media = init.media
          if (type !== 'change') throw new Error(`unexpected event type ${type}`)
        }
      },
      console,
    }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    const scriptBody = themeBridgeScript(initial).replace(/^<script>/, '').replace(/<\/script>$/, '')
    vm.runInContext(scriptBody, sandbox, { filename: 'theme-bridge.js' })
    const bridgedWindow = sandbox.window as {
      matchMedia: (query: string) => {
        matches: boolean
        addEventListener(type: string, callback: (event: unknown) => void): void
      }
    }
    const postTheme = (kind: VscodeThemeKind): void => {
      const listeners = windowListeners.get('message') ?? []
      listeners.forEach((listener) => { listener({ data: { type: 'dsh.vscodeTheme', kind } }) })
    }
    const postRaw = (data: unknown): void => {
      const listeners = windowListeners.get('message') ?? []
      listeners.forEach((listener) => { listener({ data }) })
    }
    return { bridgedWindow, nativeQueries, postTheme, postRaw }
  }

  it('embeds the initial VSCode kind into the color-scheme query', () => {
    const { bridgedWindow } = loadBridge('dark')
    expect(bridgedWindow.matchMedia('(prefers-color-scheme: dark)').matches).toBe(true)
    expect(bridgedWindow.matchMedia('(prefers-color-scheme: light)').matches).toBe(false)
  })

  it('starts light for the light and high-contrast-light kinds', () => {
    for (const kind of ['light', 'hc-light'] as const) {
      const { bridgedWindow } = loadBridge(kind)
      expect(bridgedWindow.matchMedia('(prefers-color-scheme: dark)').matches).toBe(false)
    }
  })

  it('does not delegate color-scheme queries to the native matchMedia', () => {
    const { nativeQueries, bridgedWindow } = loadBridge('light')
    bridgedWindow.matchMedia('(prefers-color-scheme: dark)')
    bridgedWindow.matchMedia('(prefers-color-scheme: light)')
    expect(nativeQueries).not.toContain('(prefers-color-scheme: dark)')
    expect(nativeQueries).not.toContain('(prefers-color-scheme: light)')
  })

  it('delegates non-color-scheme queries to the native matchMedia', () => {
    const { nativeQueries, bridgedWindow } = loadBridge('light')
    bridgedWindow.matchMedia('(min-width: 600px)')
    expect(nativeQueries).toContain('(min-width: 600px)')
  })

  it('flips the reported scheme and dispatches change on a host theme message', () => {
    const { bridgedWindow, postTheme } = loadBridge('light')
    const list = bridgedWindow.matchMedia('(prefers-color-scheme: dark)')
    const received: unknown[] = []
    list.addEventListener('change', (event) => { received.push(event) })
    expect(list.matches).toBe(false)
    postTheme('dark')
    expect(list.matches).toBe(true)
    expect(received).toHaveLength(1)
    expect((received[0] as { matches: boolean }).matches).toBe(true)
  })

  it('does not dispatch when the resolved palette is unchanged', () => {
    const { bridgedWindow, postTheme } = loadBridge('light')
    const list = bridgedWindow.matchMedia('(prefers-color-scheme: dark)')
    const received: unknown[] = []
    list.addEventListener('change', (event) => { received.push(event) })
    postTheme('hc-light')
    expect(received).toHaveLength(0)
    postTheme('dark')
    postTheme('hc-dark')
    expect(received).toHaveLength(1)
  })

  it('ignores unrelated host messages', () => {
    const { bridgedWindow, postRaw } = loadBridge('light')
    const list = bridgedWindow.matchMedia('(prefers-color-scheme: dark)')
    const received: unknown[] = []
    list.addEventListener('change', (event) => { received.push(event) })
    postRaw({ type: 'some-other-message' })
    postRaw(null)
    expect(list.matches).toBe(false)
    expect(received).toHaveLength(0)
  })

  it('is injected by buildPanelHtml before the transport script', () => {
    const index = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>DeepSeek Harness</title>
<script type="module" src="/assets/index-abc123.js"></script>
</head>
<body><div id="root"></div></body>
</html>`
    const rewritten = rewriteIndexUrls(index, (path: string) => `https://media.test${path}`)
    const bridge = themeBridgeScript('dark')
    const html = buildPanelHtml(rewritten, "default-src 'none'", 'https://media.test/t.js', bridge)
    const bridgeIndex = html.indexOf('prefers-color-scheme')
    expect(bridgeIndex).toBeGreaterThan(html.indexOf('<head>'))
    expect(bridgeIndex).toBeLessThan(html.indexOf('t.js'))
    expect(html.indexOf('t.js')).toBeLessThan(html.indexOf('assets/index-abc123.js'))
  })
})
