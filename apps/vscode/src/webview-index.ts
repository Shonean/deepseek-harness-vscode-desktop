/**
 * Pure index-rewriting helpers for the web panel: the kernel serves the
 * rendered SPA index (boot manifest, module graph scripts, theme bootstrap all
 * included); the panel turns its root-relative URLs into webview resource
 * URIs, injects the transport script ahead of everything else, and adds the
 * webview CSP. Pure functions so the rewriting contract is testable without a
 * webview.
 * @module webview-index
 */

/**
 * The VSCode color-theme kinds the bridge maps to a dark/light resolution.
 * VSCode exposes the active kind on the extension host as
 * `window.activeColorTheme.kind`; high-contrast dark and light follow their
 * base palette (the SPA has only a light/dark base palette).
 */
export type VscodeThemeKind = 'light' | 'dark' | 'hc-light' | 'hc-dark'

/**
 * Resolve one VSCode theme kind to whether the SPA's dark base palette is
 * active. Pure so the mapping is testable without the vscode API.
 * @param kind - VSCode active color-theme kind.
 * @returns true for the dark and high-contrast-dark kinds.
 */
export function vscodeThemeKindIsDark(kind: VscodeThemeKind): boolean {
  return kind === 'dark' || kind === 'hc-dark'
}

/**
 * The message the host posts to the panel when the active VSCode theme
 * changes; the bridge script listens for it and re-reports the color-scheme
 * media query.
 */
export interface ThemeBridgeMessage {
  type: 'dsh.vscodeTheme'
  /** VSCode active color-theme kind after the change. */
  kind: VscodeThemeKind
}

/**
 * Build the inline theme-bridge script injected at the top of `<head>`. It
 * runs before the SPA's boot theme script and the transport bundle. The SPA
 * resolves its `system` preference exclusively through
 * `matchMedia('(prefers-color-scheme: dark)')` — both at first paint and via
 * the live `change` event in the theme service — so the bridge overrides
 * `matchMedia` for color-scheme queries to report the VSCode theme kind,
 * fanning out a synthetic `change` event on every host theme message. This
 * drives the SPA's own live theme switch (no panel reload). Non-color-scheme
 * queries and `addEventListener`/`removeEventListener` bookkeeping delegate
 * to the native implementation so unrelated media queries are unaffected.
 *
 * The initial kind is embedded by the host so first paint matches VSCode
 * before any host message can arrive.
 * @param initialKind - VSCode active color-theme kind at panel render time.
 * @returns the inline `<script>` markup to inject into the panel head.
 */
export function themeBridgeScript(initialKind: VscodeThemeKind): string {
  return `<script>(() => {
  const DARK_QUERY = '(prefers-color-scheme: dark)'
  let dark = ${JSON.stringify(vscodeThemeKindIsDark(initialKind))}
  const nativeMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : undefined
  const listeners = new Set()
  const list = {
    matches: dark,
    media: DARK_QUERY,
    onchange: null,
    addEventListener(_type, callback) { if (typeof callback === 'function') listeners.add(callback) },
    removeEventListener(_type, callback) { listeners.delete(callback) },
    addListener(callback) { this.addEventListener('change', callback) },
    removeListener(callback) { this.removeEventListener('change', callback) },
    dispatchEvent() { return true },
  }
  window.matchMedia = (query) => {
    if (query === DARK_QUERY || query === '(prefers-color-scheme: light)') {
      return query === DARK_QUERY
        ? list
        : { ...list, matches: !dark, media: query }
    }
    if (nativeMatchMedia !== undefined) return nativeMatchMedia(query)
    return { matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } }
  }
  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.type !== 'dsh.vscodeTheme') return
    const next = data.kind === 'dark' || data.kind === 'hc-dark'
    if (next === dark) return
    dark = next
    list.matches = dark
    const synthetic = new MediaQueryListEvent('change', { matches: dark, media: DARK_QUERY })
    listeners.forEach((callback) => { try { callback(synthetic) } catch { /* listener errors must not break fan-out */ } })
    if (typeof list.onchange === 'function') list.onchange(synthetic)
  })
})();</script>`
}

/**
 * Rewrite root-relative `src`/`href` URLs in the rendered index to absolute
 * HTTPS webview resource URLs. Only root-relative values are rewritten:
 * absolute external URLs (none ship today) and data URIs pass through.
 * @param html - the rendered index document.
 * @param rewrite - maps a root-relative path to a loadable URL.
 * @returns the rewritten document.
 */
export function rewriteIndexUrls(html: string, rewrite: (path: string) => string): string {
  return html.replace(/(src|href)="\/([^"]*)"/g, (_match, attribute: string, path: string) => {
    return `${attribute}="${rewrite('/' + path)}"`
  })
}

/**
 * Replace `<script src="/plugins/...">` tags with inline scripts carrying the
 * kernel-served body. The module system's preload registrations must execute
 * in document order ahead of the boot bundle, and serving them through the
 * file-based rewrite is not reliable, so the bodies travel inside the
 * document. The replacement runs as a function so `$` sequences in the body
 * never receive String.replace's substitution meaning, and `</script>` inside
 * the body is escaped to keep the element intact.
 * @param html - the rendered index document.
 * @param fetchText - fetches one root-relative path; the caller owns reaching
 *   the kernel.
 * @returns the document with preload scripts inlined.
 */
export async function inlinePluginScripts(html: string, fetchText: (path: string) => Promise<string>): Promise<string> {
  const matches = [...html.matchAll(/<script src="(\/plugins\/[^"]+)"><\/script>/g)]
  let inlined = html
  for (const match of matches) {
    const path = match[1] ?? ''
    const body = await fetchText(path)
    const safe = body.replaceAll('</script>', '<\\/script>')
    inlined = inlined.replace(match[0], () => `<script>${safe}</script>`)
  }
  return inlined
}

/**
 * Collect every kernel plugin-route reference in the rendered index — script
 * `src` attributes and the boot manifest's bundle-URL strings alike.
 * @param html - the rendered index document.
 * @returns unique root-relative `/plugins/...` paths in first-seen order.
 */
export function pluginScriptPaths(html: string): string[] {
  const paths: string[] = []
  for (const match of html.matchAll(/\/plugins\/[^"'\\\s<>]+/g)) {
    if (!paths.includes(match[0])) paths.push(match[0])
  }
  return paths
}

/**
 * Strip the cache-busting query from a plugin route: the query is not part of
 * the identity of the response and `?` is not a legal filename character on
 * Windows, so the materialized cache keys on the path alone.
 * @param path - a root-relative `/plugins/...` route, query included.
 * @returns the query-free path to materialize and rewrite to.
 */
export function pluginCachePath(path: string): string {
  const query = path.indexOf('?')
  return query === -1 ? path : path.slice(0, query)
}

/**
 * Replace every `/plugins/...` reference with the given loadable URL. The
 * kernel plugin routes are runtime responses with no file under the frontend
 * dist root, so the file-based rewrite cannot serve them; the caller points
 * them at materialized copies. The replacer runs as a function so `$`
 * sequences inside URLs never receive String.replace's substitution meaning.
 * @param html - the rendered index document.
 * @param rewrite - maps a root-relative `/plugins/...` path to a loadable URL.
 * @returns the rewritten document.
 */
export function rewritePluginUrls(html: string, rewrite: (path: string) => string): string {
  return html.replace(/\/plugins\/[^"'\\\s<>]+/g, match => rewrite(match))
}

/**
 * Build the final panel document: CSP, then the transport script, then the
 * rewritten SPA index. The transport script must precede every SPA script —
 * the connection plugin reads `window.__DSH_TRANSPORT__` during boot — so it
 * is injected directly after `<head>`.
 * @param html - the rewritten index document.
 * @param csp - the Content-Security-Policy header value.
 * @param transportSrc - loadable URL of the injected transport bundle.
 * @param extraHeadScript - optional inline script to run before the transport
 *   and SPA (e.g. seeding the persisted session selection).
 * @returns the panel document.
 */
export function buildPanelHtml(html: string, csp: string, transportSrc: string, extraHeadScript = ''): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
  const transport = `<script src="${transportSrc}"></script>`
  const prefix = extraHeadScript.length > 0 ? `${head}\n${extraHeadScript}\n${transport}` : `${head}\n${transport}`
  const injected = html.includes('<head>')
    ? html.replace('<head>', `<head>\n${prefix}`)
    : `${prefix}\n${html}`
  return injected
}

/**
 * Build the diagnostics probe script injected at the end of `<head>`. Script
 * element load failures are capture-phase resource errors that never reach the
 * transport's `error`/`unhandledrejection` reporters, so the probe watches the
 * capture phase and, after load settles, reports every script's load state
 * plus the module loader's queue depth — the evidence that separates "the
 * preload script never loaded" from "it loaded but did not register".
 * @returns the inline `<script>` markup to inject into the panel head.
 */
export function panelProbeScript(): string {
  return `<script>(() => {
  const report = window.__DSH_WEBVIEW_REPORT__;
  if (!report) return;
  const failed = [];
  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target.tagName === 'SCRIPT') failed.push(target.src);
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    const loader = window.__ModuleLoader__;
    report({
      type: 'dsh.webviewProbe',
      phase: 'dcl',
      moduleLoaderType: typeof loader,
      queueAtDomContentLoaded: loader ? loader.pendingQueue.length : -1,
      registeredIds: loader ? loader.pendingQueue.map((r) => r.id) : [],
    });
  });
  const settle = () => {
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    const scripts = [...document.querySelectorAll('script[src]')].map((el) => ({
      src: el.src.length > 130 ? el.src.slice(0, 130) : el.src,
      loaded: resources.indexOf(el.src) !== -1,
    }));
    const loader = window.__ModuleLoader__;
    report({
      type: 'dsh.webviewProbe',
      phase: 'settled',
      moduleLoaderType: typeof loader,
      moduleQueueLength: loader ? loader.pendingQueue.length : -1,
      failedScriptSrcs: failed,
      scripts,
    });
  };
  window.addEventListener('load', () => setTimeout(settle, 1500));
  // Comprehensive diagnostics: one sampler that captures every hypothesis at
  // once — DOM shape, covering overlays, the viewport-center element, CSS
  // sheet load state, captured JS errors, focus, and computed styles. Pure JS:
  // this template executes in the browser as-is, so no TypeScript syntax may
  // appear anywhere inside it.
  const capturedErrors = [];
  window.addEventListener('error', (e) => { capturedErrors.push(String(e.message).slice(0, 120)); }, true);
  window.addEventListener('unhandledrejection', (e) => { capturedErrors.push('rejection: ' + String(e.reason).slice(0, 120)); }, true);
  function fullReport() {
    const root = document.getElementById('root');
    const frames = document.querySelectorAll('[style*="grid-template-columns"]');
    const frame = frames.length > 0 ? frames[0] : undefined;
    const cx = Math.floor(window.innerWidth / 2);
    const cy = Math.floor(window.innerHeight / 2);
    const el = document.elementFromPoint(cx, cy);
    const cover = [];
    for (const node of document.body.querySelectorAll('*')) {
      const r = node.getBoundingClientRect();
      if (r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9) {
        const cs = getComputedStyle(node);
        cover.push(node.tagName + '.' + String(node.className).slice(0, 40)
          + ' z=' + cs.zIndex + ' bg=' + cs.backgroundColor + ' op=' + cs.opacity);
      }
    }
    const sheets = [];
    for (const s of document.styleSheets) {
      sheets.push(s.href === null ? 'inline' : String(s.href).slice(0, 90));
    }
    const rcs = root === null ? null : getComputedStyle(root);
    const rootRect = root === null ? null : root.getBoundingClientRect();
    report({
      type: 'dsh.webviewProbe',
      phase: 'full',
      rootChildren: root === null ? -1 : root.children.length,
      rootText: (document.body.innerText || '').slice(0, 200),
      frameStyle: frame === undefined ? null : frame.getAttribute('style'),
      bg: getComputedStyle(document.body).backgroundColor,
      color: getComputedStyle(document.body).color,
      font: getComputedStyle(document.body).fontFamily,
      bodyH: document.body.clientHeight,
      docH: document.documentElement.clientHeight,
      rootH: root === null ? -1 : root.clientHeight,
      rootRect: rootRect === null ? null : Math.round(rootRect.width) + 'x' + Math.round(rootRect.height) + '@' + Math.round(rootRect.left) + ',' + Math.round(rootRect.top),
      rootStyle: rcs === null ? null : rcs.display + ' vis=' + rcs.visibility + ' op=' + rcs.opacity,
      center: el === null ? 'none' : el.tagName + '.' + String(el.className).slice(0, 60),
      cover: cover.slice(0, 5),
      sheetsCount: document.styleSheets.length,
      sheets: sheets.slice(0, 6),
      errors: capturedErrors.slice(0, 5),
      active: document.activeElement === null ? 'null' : document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 40),
      vis: document.visibilityState,
      viewport: window.innerWidth + 'x' + window.innerHeight,
    });
  }
  setTimeout(fullReport, 8000);
  setTimeout(fullReport, 25000);
  setTimeout(fullReport, 50000);
})();</script>`
}

/**
 * The panel's Content-Security-Policy. Everything loads from the webview
 * resource root; inline scripts stay allowed because the kernel's rendered
 * index carries nonced-less inline boot globals (`__DSH_BOOT__`, theme) the
 * injection renderer emits without nonce support. `unsafe-eval` stays in the
 * script list for the client-side `!!js` config evaluator (vendor/loader's
 * `evaluate`), which compiles code at call time; VSCode's webview baseline
 * stays the floor regardless of this directive.
 * @param cspSource - the webview's content security source.
 * @returns the policy value.
 */
export function panelCsp(cspSource: string): string {
  return [
    "default-src 'none'",
    `script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} data: blob:`,
    `font-src ${cspSource}`,
    `connect-src ${cspSource}`,
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; ')
}
