import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionContext } from 'vscode'
import { commands, window, workspace, ViewColumn, Uri } from 'vscode'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ChatViewProvider } from './chat-view.ts'
import { HarnessController } from './harness-controller.ts'
import { ApiPresetStore } from './preset-store.ts'
import { NodeRuntimeResolver } from './runtime-resolver.ts'
import type { ApiPreset, RuntimeLaunch, SessionSummary } from './types.ts'

const DSH_FOLDER = '.dsh-vscode'
const ARK_PROVIDER = 'openai'

export function activate(context: ExtensionContext): void {
  const cwd = workspaceCwd()
  const maxTokens = maxTokensSetting()
  const store = new ApiPresetStore()

  const controller = new HarnessController(
    cwd,
    new NodeRuntimeResolver(
      context.extensionPath,
      workspace.getConfiguration('dsh-vscode').get('runtimeCommand', ''),
      workspace.getConfiguration('dsh-vscode').get<string[]>('runtimeArgs', []),
    ),
    maxTokens,
    (launch, preset, tokens) => createHarness(launch, preset, tokens, cwd),
  )
  if (store.active !== undefined) {
    void controller.setActivePreset(store.active)
  }

  const provider: ChatViewProvider = new ChatViewProvider(context, {
    listPresets: () => ({ presets: [...store.list()], activeId: store.active?.id }),
    listSessions: () => summaries(controller),
    onDidChangeSessions: listener => controller.onSessions(listener),
    onDidChangePresets: listener => store.onDidChange(listener),
    send: (id, text) => sendPrompt(store, controller, provider, id, text),
    stop: id => controller.stop(id),
    openFile: path => openFile(path),
    selectPreset: id => selectPreset(store, controller, id),
    addPreset: (preset) => { store.add(preset) },
    deletePreset: (id) => { store.remove(id) },
    newSession: async () => {
      const id = controller.createSession()
      await provider.setActiveSession(id)
      return id
    },
    selectSession: id => provider.setActiveSession(id),
  })

  context.subscriptions.push(
    window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    controller.onState((state, detail) => {
      void provider.post(detail === undefined
        ? { type: 'runtimeState', state }
        : { type: 'runtimeState', state, detail })
      setRunningContext(state === 'running')
    }),
    controller.onStatus((event) => {
      void provider.post(event.running
        ? { type: 'status', sessionId: event.sessionId, running: true }
        : { type: 'status', sessionId: event.sessionId, running: false })
    }),
    workspace.onDidSaveTextDocument((document) => {
      if (document.uri.fsPath === store.file) {
        store.reload()
        if (store.active !== undefined) void controller.setActivePreset(store.active)
      }
    }),
    commands.registerCommand('dsh.newSession', async () => {
      const id = controller.createSession()
      await provider.setActiveSession(id)
    }),
    commands.registerCommand('dsh.stop', async () => {
      const id = provider.activeSessionId
      if (id !== undefined) await controller.stop(id)
    }),
    commands.registerCommand('dsh.selectPreset', async () => {
      const picked = await pickPreset(store)
      if (picked !== undefined) await selectPreset(store, controller, picked)
    }),
    commands.registerCommand('dsh.addPreset', async () => {
      const preset = await promptPreset()
      if (preset !== undefined) store.add(preset)
    }),
  )
}

async function selectPreset(store: ApiPresetStore, controller: HarnessController, id: string): Promise<void> {
  store.setActive(id)
  await controller.setActivePreset(store.active)
}

async function pickPreset(store: ApiPresetStore): Promise<string | undefined> {
  const items = store.list().map(preset => ({
    label: preset.name,
    description: preset.model,
    detail: preset.baseURL,
    id: preset.id,
  }))
  const picked = await window.showQuickPick(items, { placeHolder: 'Select API preset' })
  return picked?.id
}

async function promptPreset(): Promise<Omit<ApiPreset, 'id'> | undefined> {
  const name = await window.showInputBox({ prompt: 'Preset name', placeHolder: 'doubao' })
  if (name === undefined) return undefined
  const apiKey = await window.showInputBox({ prompt: 'API key (ARK_API_KEY)', password: true })
  if (apiKey === undefined) return undefined
  const baseURL = await window.showInputBox({ prompt: 'Base URL (ARK_BASE_URL)', placeHolder: 'https://ark.cn-beijing.volces.com/api/coding/v3' })
  if (baseURL === undefined) return undefined
  const model = await window.showInputBox({ prompt: 'Model (ARK_MODEL_PRO)', placeHolder: 'doubao-seed-evolving' })
  if (model === undefined) return undefined
  return { name, apiKey, baseURL, model }
}

async function sendPrompt(
  store: ApiPresetStore,
  controller: HarnessController,
  provider: ChatViewProvider,
  id: string,
  text: string,
): Promise<void> {
  if (store.active === undefined) {
    await provider.post({ type: 'error', sessionId: id, message: 'No API preset configured. Add one first.' })
    return
  }
  try {
    await controller.prompt(id, text, {
      onAssistantText: chunk => void provider.post({ type: 'assistantText', sessionId: id, text: chunk }),
      onAssistantMessage: () => void provider.post({ type: 'event', sessionId: id, event: { type: 'assistant/message' } }),
      onToolCall: call => void provider.post({ type: 'toolCall', sessionId: id, call }),
      onToolResult: (callId, error) => void provider.post({ type: 'toolResult', sessionId: id, callId, ...error ? { error } : {} }),
      onSubagent: (childId, finished, status) => void provider.post({
        type: 'subagent',
        parentSessionId: id,
        childSessionId: childId,
        finished,
        ...status ? { status } : {},
      }),
    })
  } catch (error) {
    await provider.post({
      type: 'error',
      sessionId: id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function createHarness(launch: RuntimeLaunch, preset: ApiPreset, maxTokens: number | undefined, cwd: string): DeepSeekHarness {
  const env: NodeJS.ProcessEnv = { ...launch.env }
  if (preset.apiKey.length > 0) env.ARK_API_KEY = preset.apiKey
  if (preset.baseURL.length > 0) env.ARK_BASE_URL = preset.baseURL
  if (preset.model.length > 0) env.ARK_MODEL_PRO = preset.model
  env.OPENAI_API_KEY = preset.apiKey
  env.OPENAI_BASE_URL = preset.baseURL
  env.DSH_CWD = cwd
  env.DSH_SESSION_ROOT = join(tmpdir(), DSH_FOLDER, 'sessions')
  return new DeepSeekHarness({
    launch: { command: launch.command, args: launch.args, cwd: launch.cwd, env },
    cwd,
    provider: ARK_PROVIDER,
    model: preset.model,
    ...maxTokens === undefined ? {} : { maxTokens },
  })
}

function summaries(controller: HarnessController): SessionSummary[] {
  return controller.sessionIds.map(id => ({ id, title: controller.titleOf(id) }))
}

function workspaceCwd(): string {
  const folder = workspace.workspaceFolders?.[0]
  return folder ? resolve(folder.uri.fsPath) : process.cwd()
}

function maxTokensSetting(): number | undefined {
  const value = workspace.getConfiguration('dsh-vscode').get<number | null>('maxTokens', null)
  return value === null || value <= 0 ? undefined : value
}

async function openFile(path: string): Promise<void> {
  const resolved = resolve(path)
  try {
    const document = await workspace.openTextDocument(Uri.file(resolved))
    await window.showTextDocument(document, ViewColumn.One)
  } catch {
    void window.showWarningMessage(`Cannot open ${path}`)
  }
}

function setRunningContext(running: boolean): void {
  void commands.executeCommand('setContext', 'dsh.running', running)
}

export function deactivate(): void {
  // The HarnessController is disposed through its subscriptions; the process
  // is reaped when the extension host tears down the client.
}
