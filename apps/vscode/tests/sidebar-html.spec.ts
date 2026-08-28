import { describe, expect, it } from 'vitest'
import { buildSidebarHtml, resolveUiLocale } from '../src/sidebar-view.ts'

/**
 * The slim sidebar renders a self-contained document: a new-session button and
 * the list region, with localized strings injected ahead of its script. These
 * pin the document contract the webview script relies on.
 */
describe('slim sidebar document', () => {
  it('renders the new-session button, list region, and a strict CSP', () => {
    const html = buildSidebarHtml({ cspSource: 'https://abc.vscode-cdn.net' }, 'en')
    expect(html).toContain('id="new-session"')
    expect(html).toContain('id="list"')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('script-src \'nonce-')
  })

  it('injects the resolved locale and matching localized strings', () => {
    const html = buildSidebarHtml({ cspSource: 'x' }, 'zh-cn')
    expect(html).toContain('window.__DSH_LOCALE__ = "zh-cn"')
    // The button label is rendered from the active-locale strings table.
    expect(html).toContain('+ 新建会话')
  })
})

describe('resolveUiLocale', () => {
  it('honors an explicit locale and resolves auto against the VSCode language', () => {
    expect(resolveUiLocale('en', 'zh-cn')).toBe('en')
    expect(resolveUiLocale('zh-cn', 'en')).toBe('zh-cn')
    expect(resolveUiLocale('auto', 'en')).toBe('en')
    expect(resolveUiLocale('auto', 'zh-cn')).toBe('zh-cn')
    expect(resolveUiLocale('auto', 'zh-TW')).toBe('zh-cn')
  })
})
