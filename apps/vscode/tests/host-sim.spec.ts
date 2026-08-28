import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Module from 'node:module'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = process.env.DSH_HOST_SIM_EXT !== undefined
  ? resolve(process.env.DSH_HOST_SIM_EXT, 'dist/extension.cjs')
  : resolve(here, '../dist/extension.cjs')
const extensionPath = dirname(bundle)

type CommandHandler = (...args: unknown[]) => unknown

/**
 * Host-simulation integration test: load the real built bundle the way the
 * extension host does (CJS require with a stubbed `vscode` module), activate
 * it, and run the real command handlers — including a genuine kernel child
 * process spawn and a real tunnel round-trip. This is the no-GUI stand-in for
 * clicking `dsh.newSession`/`dsh.openChat`, and it surfaces the same log lines
 * the output channel carries in a real window.
 */
describe.skipIf(!existsSync(bundle))('extension host simulation', () => {
  it('activates, boots the web kernel, creates a session, and relays a tunnel fetch', { timeout: 120_000 }, async () => {
    const logLines: string[] = []
    const commands = new Map<string, CommandHandler>()
    const errors: string[] = []
    const registeredViews: string[] = []

    const channel = {
      appendLine: (line: string) => { logLines.push(line) },
      show: () => undefined,
      dispose: () => undefined,
    }
    const disposable = { dispose: () => undefined }
    const webviewMessages: unknown[] = []
    const webviewListeners: Array<(message: unknown) => void> = []
    const panelHtmls: string[] = []
    const webview: Record<string, unknown> = {
      asWebviewUri: (uri: unknown) => uri,
      cspSource: 'stub:',
      postMessage: (message: unknown) => { webviewMessages.push(message); return Promise.resolve(true) },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { webviewListeners.push(listener); return disposable },
      set html(value: string) { panelHtmls.push(value) },
    }
    const deliverToWebviewListeners = (message: unknown): void => {
      for (const listener of webviewListeners) listener(message)
    }
    const webviewPanel: Record<string, unknown> = {
      webview,
      reveal: () => undefined,
      dispose: () => undefined,
      onDidDispose: () => disposable,
    }
    const vscodeStub = {
      commands: { registerCommand: (id: string, handler: CommandHandler) => { commands.set(id, handler); return disposable } },
      env: { language: 'en' },
      window: {
        createOutputChannel: () => channel,
        registerWebviewViewProvider: (_viewType: string, _provider: unknown) => { registeredViews.push(_viewType); return disposable },
        withProgress: (_options: unknown, task: () => Promise<void>) => task(),
        createWebviewPanel: () => webviewPanel,
        registerWebviewPanelSerializer: () => disposable,
        onDidChangeActiveColorTheme: () => disposable,
        activeColorTheme: { kind: 2 },
        showErrorMessage: (message: string) => { errors.push(message) },
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: mkdtempSync(`${tmpdir().replaceAll('\\', '/')}/dsh-hostsim-`) } }],
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        onDidChangeConfiguration: () => disposable,
      },
      Uri: { file: (path: string) => ({ fsPath: path, toString: () => path }) },
      ViewColumn: { One: 1 },
      ProgressLocation: { Notification: 15 },
      ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    }

    type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown
    const target = Module as unknown as { _load: LoadFn }
    const original = target._load
    target._load = function patched(request, parent, isMain) {
      if (request === 'vscode') return vscodeStub
      return original.call(this, request, parent, isMain)
    }
    let extension: { activate?: (context: unknown) => unknown; deactivate?: () => unknown }
    try {
      const req = createRequire(import.meta.url)
      extension = req(bundle) as typeof extension
    } finally {
      target._load = original
    }

    expect(typeof extension.activate).toBe('function')
    const subscriptions: Array<{ dispose(): unknown }> = []
    extension.activate!({
      extensionPath,
      subscriptions,
      globalStorageUri: { fsPath: mkdtempSync(`${tmpdir().replaceAll('\\', '/')}/dsh-hostsim-storage-`) },
    })

    expect(registeredViews).toContain('dsh.sidebar')
    expect(commands.has('dsh.newSession')).toBe(true)
    expect(commands.has('dsh.showLogs')).toBe(true)

    const sessionId = await commands.get('dsh.newSession')!() as string
    expect(sessionId).toMatch(/^session-/)

    expect(logLines.some(line => line.includes('kernel: listening at http://127.0.0.1:'))).toBe(true)
    expect(logLines.some(line => line.includes('broker: kernel ready at http://127.0.0.1:'))).toBe(true)
    expect(errors).toEqual([])

    // The rendered panel must carry the preload registrations inline (no raw
    // script-src references survive) and must not keep raw manifest URLs for
    // the runtime-imported bundles, which are materialized instead.
    expect(panelHtmls.length).toBeGreaterThan(0)
    expect(panelHtmls.some(html => !html.includes('="/plugins/') && !html.includes('"/plugins/') && html.includes('__ModuleLoader__'))).toBe(true)
    expect(panelHtmls.some(html => html.includes('window.__ModuleLoader__.load({') && html.includes('"@deepseek-ai/dsh-client-modules"'))).toBe(true)
    expect(logLines.some(line => /panel: materialized \d+ kernel plugin route/.test(line))).toBe(true)

    deliverToWebviewListeners({
      type: 'dsh.fetch',
      id: 'probe-1',
      path: '/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session.list', payload: {} }),
    })
    const endFrame = await vi.waitFor(() => {
      const frame = webviewMessages.find(m => (m as { type?: string; id?: string }).type === 'dsh.fetch.end' && (m as { id?: string }).id === 'probe-1')
      expect(frame).toBeDefined()
      return frame as { type: string; error?: string }
    }, { timeout: 15_000 })
    expect(endFrame.error).toBeUndefined()
    const head = webviewMessages.find(m => (m as { type?: string; id?: string }).type === 'dsh.fetch.head' && (m as { id?: string }).id === 'probe-1') as { status?: number } | undefined
    expect(head?.status).toBe(200)

    for (const entry of subscriptions.reverse()) await entry.dispose()
    await vi.waitFor(() => {
      expect(logLines.some(line => line.includes('kernel: exited'))).toBe(true)
    }, { timeout: 15_000 })
  })
})
