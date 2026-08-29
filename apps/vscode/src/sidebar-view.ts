import { randomUUID } from 'node:crypto'
import type {
  ExtensionContext,
  Webview,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  CancellationToken,
} from 'vscode'
import { logError } from './log.ts'
import type { KernelBroker, KernelSession } from './kernel-broker.ts'

/** Panel UI language; `auto` follows VSCode's display language. */
export type UiLocale = 'auto' | 'en' | 'zh-cn'
/** Concrete locale after `auto` resolution. */
export type ResolvedLocale = 'en' | 'zh-cn'

/** Resolve the `uiLocale` setting against VSCode's display language. */
export function resolveUiLocale(setting: UiLocale, vscodeLanguage: string): ResolvedLocale {
  if (setting === 'en' || setting === 'zh-cn') return setting
  return /^zh\b|^zh-/i.test(vscodeLanguage) ? 'zh-cn' : 'en'
}

type StringKey = 'newSession' | 'openChat' | 'running' | 'empty'

const STRINGS: Record<ResolvedLocale, Record<StringKey, string>> = {
  en: {
    newSession: 'New session',
    openChat: 'Open chat',
    running: 'running',
    empty: 'No sessions yet',
  },
  'zh-cn': {
    newSession: '新建会话',
    openChat: '打开聊天',
    running: '运行中',
    empty: '暂无会话',
  },
}

/** Inbound message from the sidebar webview. */
export type SidebarInbound =
  | { type: 'ready' }
  | { type: 'newSession' }
  | { type: 'open'; sessionId: string }
  | { type: 'openChat' }
  | { type: 'webviewError'; surface: string; message: string; stack?: string }

/** Outbound frame to the sidebar webview. */
export type SidebarOutbound =
  | { type: 'ready'; locale: ResolvedLocale; activeSessionId?: string; sessions: KernelSession[] }
  | { type: 'sessions'; activeSessionId?: string; sessions: KernelSession[] }

/**
 * The slim activity-bar sidebar: a new-session button and the session list.
 * Selecting a row opens the full SPA in an editor panel seeded to that
 * session; it carries no chat surface of its own. Self-contained HTML keeps
 * the sidebar loadable before the kernel is ready.
 */
export class SidebarViewProvider implements WebviewViewProvider {
  static readonly viewType = 'dsh.sidebar'
  private view: WebviewView | undefined

  constructor(
    private readonly context: ExtensionContext,
    private readonly broker: KernelBroker,
    private locale: ResolvedLocale = 'en',
    private readonly onOpenSession: (sessionId: string | undefined) => void | Promise<void>,
  ) {}

  /** Switch the sidebar language and reload it when visible. */
  setLocale(locale: ResolvedLocale): void {
    if (locale === this.locale) return
    this.locale = locale
    if (this.view !== undefined) this.view.webview.html = buildSidebarHtml(this.view.webview, this.locale)
  }

  /** Push the current session snapshot to the webview when it exists. */
  refresh(): void {
    void this.view?.webview.postMessage(this.sessionsFrame())
  }

  resolveWebviewView(webviewView: WebviewView, _context: WebviewViewResolveContext, _token: CancellationToken): void {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] }
    webviewView.webview.html = buildSidebarHtml(webviewView.webview, this.locale)
    webviewView.webview.onDidReceiveMessage((message: SidebarInbound) => {
      void this.handleMessage(message)
    })
    const subscription = this.broker.subscribe({
      onSessions: () => { this.refresh() },
    })
    webviewView.onDidDispose(() => { subscription.dispose() })
  }

  private sessionsFrame(): SidebarOutbound {
    const active = this.broker.getActiveSession()
    const sessions: KernelSession[] = [...this.broker.listSessions()]
    return active === undefined
      ? { type: 'sessions', sessions }
      : { type: 'sessions', sessions, activeSessionId: active }
  }

  private async handleMessage(message: SidebarInbound): Promise<void> {
    switch (message.type) {
      case 'ready': {
        const active = this.broker.getActiveSession()
        const sessions: KernelSession[] = [...this.broker.listSessions()]
        const base = { type: 'ready', locale: this.locale, sessions }
        await this.view?.webview.postMessage(
          active === undefined ? base : { ...base, activeSessionId: active },
        )
        return
      }
      case 'newSession':
        try {
          await this.broker.start()
          const id = await this.broker.createSession()
          await this.onOpenSession(id)
        } catch (error) {
          // Kernel or create failure leaves the list untouched; the panel
          // surfaces its own startup error when opened.
          console.error('[dsh-vscode] new session failed:', error)
        }
        return
      case 'open':
        await this.onOpenSession(message.sessionId)
        return
      case 'openChat':
        await this.onOpenSession(undefined)
        return
      case 'webviewError':
        logError(`sidebar webview error (${message.surface})`, message.stack !== undefined ? new Error(`${message.message}\n${message.stack}`) : message.message)
        return
    }
  }
}

/**
 * Render the self-contained sidebar document for one locale. Pure so the
 * localization contract is testable without a webview.
 */
export function buildSidebarHtml(webview: Pick<Webview, 'cspSource'>, locale: ResolvedLocale): string {
  const nonce = randomUUID().replaceAll('-', '')
  const csp = [
    'default-src \'none\'',
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
  ].join('; ')
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>DSH</title>
<style>${SIDEBAR_CSS}</style>
</head>
<body>
  <div class="bar">
    <button id="new-session" class="primary">+ ${STRINGS[locale].newSession}</button>
  </div>
  <div id="list" class="list" role="list"></div>
  <div id="empty" class="empty">${STRINGS[locale].empty}</div>
  <script nonce="${nonce}">window.__DSH_LOCALE__ = ${JSON.stringify(locale)}; window.__DSH_STRINGS__ = ${JSON.stringify(STRINGS)};</script>
  <script nonce="${nonce}">${SIDEBAR_SCRIPT}</script>
</body>
</html>`
}

const SIDEBAR_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
.bar { padding: 8px; }
button.primary {
  width: 100%; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; border-radius: 4px; padding: 6px 10px; cursor: pointer; text-align: left;
  font-family: inherit; font-size: inherit;
}
button.primary:hover { background: var(--vscode-button-hoverBackground); }
.list { flex: 1; overflow-y: auto; padding: 0 4px 8px; display: flex; flex-direction: column; gap: 1px; }
.row {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 4px;
  cursor: pointer; color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
  border: 1px solid transparent;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.row .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .meta { font-size: 0.9em; color: var(--vscode-descriptionForeground); display: flex; gap: 6px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-blue, #3794ff); align-self: center; }
.empty { padding: 8px 12px; color: var(--vscode-descriptionForeground); display: none; }
.empty.show { display: block; }
`

const SIDEBAR_SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  const STRINGS = window.__DSH_STRINGS__[window.__DSH_LOCALE__] || window.__DSH_STRINGS__.en;
  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  document.getElementById('new-session').addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
  });
  let sessions = [];
  let activeSessionId = undefined;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render() {
    listEl.innerHTML = '';
    emptyEl.classList.toggle('show', sessions.length === 0);
    for (const s of sessions) {
      const row = el('div', 'row' + (s.id === activeSessionId ? ' active' : ''));
      const title = el('div', 'title', s.title || STRINGS.openChat);
      row.appendChild(title);
      if (s.running) {
        const meta = el('div', 'meta');
        meta.appendChild(el('span', 'dot'));
        meta.appendChild(document.createTextNode(STRINGS.running));
        row.appendChild(meta);
      }
      row.addEventListener('click', () => vscode.postMessage({ type: 'open', sessionId: s.id }));
      listEl.appendChild(row);
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'ready' || msg.type === 'sessions') {
      sessions = msg.sessions || [];
      activeSessionId = msg.activeSessionId;
      render();
    }
  });

  function reportError(kind, info) {
    try {
      vscode.postMessage({ type: 'webviewError', surface: kind, message: String(info.message || info), stack: info.error && info.error.stack });
    } catch { /* reporting must never break the sidebar */ }
  }
  window.addEventListener('error', (event) => reportError('error', event));
  window.addEventListener('unhandledrejection', (event) => reportError('unhandledrejection', event.reason || {}));

  vscode.postMessage({ type: 'ready' });
})();
`
