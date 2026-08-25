import type { WebviewView, WebviewViewProvider, Webview, ExtensionContext, CancellationToken, WebviewViewResolveContext } from 'vscode'
import { randomUUID } from 'node:crypto'
import type { ApiPreset, HostMessage, SessionSummary, WebviewMessage } from './types.ts'

/** Callback the panel uses to drive the controller and VSCode commands. */
export interface ChatDelegate {
  listPresets(): { presets: ApiPreset[]; activeId: string | undefined }
  listSessions(): SessionSummary[]
  onDidChangeSessions(listener: () => void): { dispose(): void }
  onDidChangePresets(listener: () => void): { dispose(): void }
  send(sessionId: string, text: string): void | Promise<void>
  stop(sessionId: string): void | Promise<void>
  openFile(path: string): void | Promise<void>
  selectPreset(id: string): void | Promise<void>
  addPreset(preset: ApiPreset): void | Promise<void>
  deletePreset(id: string): void | Promise<void>
  newSession(): string | Promise<string>
  selectSession(id: string): void | Promise<void>
}

/**
 * Renders the chat sidebar as a single self-contained webview (no external
 * network resources) and bridges host messages to its DOM script.
 */
export class ChatViewProvider implements WebviewViewProvider {
  static readonly viewType = 'dsh.chatView'
  private view: WebviewView | undefined
  private currentSessionId: string | undefined

  constructor(
    private readonly context: ExtensionContext,
    private readonly delegate: ChatDelegate,
  ) {}

  /** The session id currently shown in the panel. */
  get activeSessionId(): string | undefined {
    return this.currentSessionId
  }

  /** Set the session shown in the panel and push it to the webview. */
  async setActiveSession(id: string): Promise<void> {
    this.currentSessionId = id
    await this.post({ type: 'sessions', sessions: this.delegate.listSessions() })
  }

  /** Push a host message to the webview when it exists. */
  async post(message: WebviewMessage): Promise<void> {
    await this.view?.webview.postMessage(message)
  }

  resolveWebviewView(webviewView: WebviewView, _context: WebviewViewResolveContext, _token: CancellationToken): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    }
    webviewView.webview.html = this.html(webviewView.webview)
    webviewView.webview.onDidReceiveMessage((message: HostMessage) => {
      void this.handleMessage(message)
    })
    this.delegate.onDidChangeSessions(() => {
      void this.post({ type: 'sessions', sessions: this.delegate.listSessions() })
    })
    this.delegate.onDidChangePresets(() => {
      const { presets, activeId } = this.delegate.listPresets()
      void this.post({ type: 'presets', presets, activePresetId: activeId })
    })
  }

  private async handleMessage(message: HostMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        const { presets, activeId } = this.delegate.listPresets()
        if (this.currentSessionId === undefined) {
          this.currentSessionId = await this.delegate.newSession()
        }
        await this.post({
          type: 'ready',
          activePresetId: activeId,
          presets,
          sessions: this.delegate.listSessions(),
        })
        return
      }
      case 'send': {
        this.currentSessionId = message.sessionId
        await this.delegate.send(message.sessionId, message.text)
        return
      }
      case 'newSession': {
        this.currentSessionId = await this.delegate.newSession()
        return
      }
      case 'selectSession': {
        this.currentSessionId = message.sessionId
        await this.delegate.selectSession(message.sessionId)
        return
      }
      case 'stop':
        await this.delegate.stop(message.sessionId)
        return
      case 'openFile':
        await this.delegate.openFile(message.path)
        return
      case 'selectPreset':
        await this.delegate.selectPreset(message.id)
        return
      case 'addPreset':
        await this.delegate.addPreset({ ...message.preset, id: message.preset.id || randomUUID() })
        return
      case 'deletePreset':
        await this.delegate.deletePreset(message.id)
        return
    }
  }

  private html(webview: Webview): string {
    const nonce = randomUUID().replaceAll('-', '')
    const csp = [
      'default-src \'none\'',
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
    ].join('; ')
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>DeepSeek Harness</title>
<style>${CHAT_CSS}</style>
</head>
<body>
  <div id="session-bar" class="session-bar"></div>
  <div id="messages" class="messages"></div>
  <div class="composer">
    <textarea id="input" rows="2" placeholder="Send a message… (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="composer-row">
      <select id="preset" title="API preset"></select>
      <button id="add-preset" title="Add API preset">+</button>
      <button id="send" class="primary">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">${CHAT_SCRIPT}</script>
</body>
</html>`
  }
}

const CHAT_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
.session-bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.session-bar select { flex: 1; min-width: 0; }
.messages { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.msg { padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; }
.msg.user { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-panel-border); }
.msg.assistant { background: transparent; }
.msg.tool { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.msg.tool summary { cursor: pointer; }
.msg.tool .body { margin-top: 4px; white-space: pre-wrap; }
.msg.error { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
.msg.subagent { color: var(--vscode-descriptionForeground); font-style: italic; }
.composer { border-top: 1px solid var(--vscode-panel-border); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.composer textarea {
  width: 100%; resize: vertical; min-height: 40px; max-height: 160px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px;
  font-family: inherit; font-size: inherit;
}
.composer-row { display: flex; gap: 6px; align-items: center; }
.composer-row select { flex: 1; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 3px; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:disabled { opacity: 0.5; cursor: default; }
a.file-link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
`

const CHAT_SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const presetEl = document.getElementById('preset');
  const sessionBar = document.getElementById('session-bar');
  let currentSessionId = undefined;
  let sessions = [];
  let presets = [];
  let activePresetId = undefined;
  let running = false;
  const assistantNodes = new Map();
  const toolNodes = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollToEnd() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function appendUserMessage(text) {
    messagesEl.appendChild(el('div', 'msg user', text));
    scrollToEnd();
  }

  function assistantNode(sessionId) {
    let node = assistantNodes.get(sessionId);
    if (!node) {
      node = el('div', 'msg assistant');
      messagesEl.appendChild(node);
      assistantNodes.set(sessionId, node);
    }
    return node;
  }

  function renderSessions() {
    sessionBar.innerHTML = '';
    const select = document.createElement('select');
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.title;
      if (s.id === currentSessionId) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => vscode.postMessage({ type: 'selectSession', sessionId: select.value }));
    sessionBar.appendChild(select);
    const add = el('button', undefined, '+');
    add.title = 'New session';
    add.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    sessionBar.appendChild(add);
  }

  function renderPresets() {
    presetEl.innerHTML = '';
    if (presets.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No preset configured';
      presetEl.appendChild(opt);
      return;
    }
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + ' — ' + p.model;
      if (p.id === activePresetId) opt.selected = true;
      presetEl.appendChild(opt);
    }
  }

  function linkifyPaths(text) {
    const node = document.createElement('span');
    const re = /(?:[A-Za-z]:[\\\\/])?[\\w./\\\\-]+/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      node.appendChild(document.createTextNode(text.slice(last, m.index)));
      const link = el('a', 'file-link', m[0]);
      link.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: m[0] }));
      node.appendChild(link);
      last = m.index + m[0].length;
    }
    node.appendChild(document.createTextNode(text.slice(last)));
    return node;
  }

  function setRunning(value) {
    running = value;
    sendBtn.textContent = value ? 'Stop' : 'Send';
    sendBtn.className = value ? '' : 'primary';
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || !currentSessionId) return;
    if (running) { vscode.postMessage({ type: 'stop', sessionId: currentSessionId }); return; }
    appendUserMessage(text);
    assistantNodes.delete(currentSessionId);
    inputEl.value = '';
    setRunning(true);
    vscode.postMessage({ type: 'send', sessionId: currentSessionId, text });
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  presetEl.addEventListener('change', () => vscode.postMessage({ type: 'selectPreset', id: presetEl.value }));
  document.getElementById('add-preset').addEventListener('click', () => {
    const name = prompt('Preset name'); if (name === null) return;
    const apiKey = prompt('API key (ARK_API_KEY)'); if (apiKey === null) return;
    const baseURL = prompt('Base URL (ARK_BASE_URL)'); if (baseURL === null) return;
    const model = prompt('Model (ARK_MODEL_PRO)'); if (model === null) return;
    vscode.postMessage({ type: 'addPreset', preset: { id: '', name, apiKey, baseURL, model } });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'ready':
        presets = msg.presets; activePresetId = msg.activePresetId; sessions = msg.sessions;
        currentSessionId = sessions.length ? sessions[sessions.length - 1].id : undefined;
        renderPresets(); renderSessions(); break;
      case 'presets':
        presets = msg.presets; activePresetId = msg.activePresetId; renderPresets(); break;
      case 'sessions':
        sessions = msg.sessions;
        if (!currentSessionId && sessions.length) currentSessionId = sessions[sessions.length - 1].id;
        renderSessions(); break;
      case 'assistantText':
        assistantNode(msg.sessionId).appendChild(document.createTextNode(msg.text));
        scrollToEnd(); break;
      case 'assistantMessage':
        assistantNode(msg.sessionId).appendChild(document.createTextNode('\\n'));
        break;
      case 'toolCall': {
        const details = el('details', 'msg tool');
        const summary = el('summary', undefined, '\\u25B8 ' + msg.call.name);
        details.appendChild(summary);
        const body = el('div', 'body');
        try { body.textContent = JSON.stringify(JSON.parse(msg.call.arguments), null, 2); }
        catch { body.textContent = msg.call.arguments; }
        details.appendChild(body);
        messagesEl.appendChild(details);
        toolNodes.set(msg.call.callId, details);
        scrollToEnd(); break;
      }
      case 'toolResult': {
        const node = toolNodes.get(msg.callId);
        if (node) node.querySelector('summary').textContent = '\\u25BE ' + (node.querySelector('summary').textContent.replace(/^[\\u25B8\\u25BE]\\s*/, '')) + (msg.error ? ' \\u2716' : ' \\u2713');
        break;
      }
      case 'subagent': {
        messagesEl.appendChild(el('div', 'msg subagent',
          (msg.finished ? 'Subagent finished: ' : 'Subagent started: ') + msg.childSessionId + (msg.status ? ' (' + msg.status + ')' : '')));
        scrollToEnd(); break;
      }
      case 'status':
        if (msg.sessionId === currentSessionId) setRunning(msg.running);
        break;
      case 'error': {
        const node = el('div', 'msg error');
        node.appendChild(linkifyPaths(msg.message));
        messagesEl.appendChild(node); scrollToEnd();
        setRunning(false); break;
      }
      case 'runtimeState':
        if (msg.state === 'error') {
          messagesEl.appendChild(el('div', 'msg error', 'Runtime error: ' + (msg.detail || msg.state)));
        } break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
`
