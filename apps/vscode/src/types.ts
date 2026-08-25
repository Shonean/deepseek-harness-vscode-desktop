/** A switchable API route, mirroring one entry in ainovel's api_library.json. */
export interface ApiPreset {
  /** Stable identifier; survives renames of {@link name}. */
  id: string
  /** Display label in the preset dropdown. */
  name: string
  /** Real API key (stored in plaintext in api_library.json, field ARK_API_KEY). */
  apiKey: string
  /** OpenAI-compatible endpoint override (field ARK_BASE_URL). */
  baseURL: string
  /** Model id sent to the endpoint (field ARK_MODEL_PRO). */
  model: string
}

/** Outbound message from the extension host to the webview. */
export type WebviewMessage =
  | { type: 'ready'; activePresetId: string | undefined; presets: ApiPreset[]; sessions: SessionSummary[] }
  | { type: 'presets'; activePresetId: string | undefined; presets: ApiPreset[] }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'event'; sessionId: string; event: unknown }
  | { type: 'status'; sessionId: string; running: boolean }
  | { type: 'assistantText'; sessionId: string; text: string }
  | { type: 'toolCall'; sessionId: string; call: ToolCallView }
  | { type: 'toolResult'; sessionId: string; callId: string; error?: { name: string; code: string } }
  | { type: 'subagent'; parentSessionId: string; childSessionId: string; finished: boolean; status?: string }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'runtimeState'; state: RuntimeState; detail?: string }

/** Inbound message from the webview to the extension host. */
export type HostMessage =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'stop'; sessionId: string }
  | { type: 'openFile'; path: string }
  | { type: 'selectPreset'; id: string }
  | { type: 'addPreset'; preset: ApiPreset }
  | { type: 'deletePreset'; id: string }

export interface SessionSummary {
  id: string
  title: string
}

export interface ToolCallView {
  callId: string
  name: string
  arguments: string
}

export type RuntimeState = 'stopped' | 'starting' | 'running' | 'error'

/** Launch coordinates for the runtime subprocess. */
export interface RuntimeLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Resolves how the runtime binary and its config are located. */
export interface RuntimeResolver {
  resolve(cwd: string): Promise<RuntimeLaunch> | RuntimeLaunch
}
