import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { ExtensionContext } from 'vscode'
import { commands, env, window, workspace } from 'vscode'
import type { OutputChannel } from 'vscode'
import { bindLog, log, logError, showLog } from './log.ts'
import { KernelBroker } from './kernel-broker.ts'
import { resolveUiLocale, SidebarViewProvider, type UiLocale } from './sidebar-view.ts'
import { closeWebChatPanel, openWebChatPanel, registerChatPanelSerializer } from './web-panel.ts'

function panelLocale(): UiLocale {
  return workspace.getConfiguration('dsh-vscode').get<UiLocale>('uiLocale', 'auto')
}

export function activate(context: ExtensionContext): void {
  const channel: OutputChannel = window.createOutputChannel('DeepSeek Harness')
  bindLog(channel)
  context.subscriptions.push(channel)

  const cwd = workspaceCwd()
  const broker = new KernelBroker(context, cwd)
  const locale = resolveUiLocale(panelLocale(), env.language)
  log(`extension activated (locale=${locale}, cwd=${cwd}, extensionPath=${context.extensionPath})`)

  const openPanel = (sessionId: string | undefined): Promise<void> => {
    return openWebChatPanel(context, broker, sessionId)
  }

  const sidebar = new SidebarViewProvider(context, broker, locale, async (sessionId) => {
    await openPanel(sessionId)
  })

  context.subscriptions.push(
    window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebar),
    { dispose: () => { void broker.dispose() } },
    commands.registerCommand('dsh.showLogs', () => { showLog() }),
    commands.registerCommand('dsh.openChat', () => {
      log('command: dsh.openChat')
      return openPanel(undefined)
    }),
    commands.registerCommand('dsh.closeChat', () => { closeWebChatPanel() }),
    commands.registerCommand('dsh.newSession', async () => {
      log('command: dsh.newSession')
      try {
        await broker.start()
        const id = await broker.createSession()
        log(`command: dsh.newSession created ${id}`)
        await openPanel(id)
        return id
      } catch (error) {
        logError('command: dsh.newSession failed', error)
        throw error
      }
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dsh-vscode.uiLocale')) {
        sidebar.setLocale(resolveUiLocale(panelLocale(), env.language))
      }
    }),
  )
  registerChatPanelSerializer(context)
}

function workspaceCwd(): string {
  const folder = workspace.workspaceFolders?.[0]
  if (folder) return resolve(folder.uri.fsPath)
  // The extension host's process.cwd() is the VSCode install directory; agent
  // sessions must never target it. The home directory is the safe fallback.
  log('no workspace folder open; kernel cwd falls back to the home directory')
  return homedir()
}

export function deactivate(): void {
  // The KernelBroker is disposed through its context subscription.
}
