import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { ApiPreset, RuntimeLaunch, RuntimeResolver, RuntimeState, ToolCallView } from './types.ts'

/**
 * Owns one dsh runtime subprocess and routes its JSON-RPC notifications to
 * named chat sessions. The process starts lazily on first prompt; switching
 * the active API preset restarts it so the new `{provider, model}` applies.
 */
export class HarnessController {
  private harness: DeepSeekHarness | undefined
  private state: RuntimeState = 'stopped'
  private stateDetail: string | undefined
  private readonly emitter = new EventEmitter()
  private readonly sessions = new Map<string, SessionRecord>()
  private activePreset: ApiPreset | undefined
  private subscription: { close(): void } | undefined
  private pumpStarted = false

  constructor(
    private readonly cwd: string,
    private readonly resolver: RuntimeResolver,
    private readonly maxTokens: number | undefined,
    private readonly harnessFactory: (launch: RuntimeLaunch, preset: ApiPreset, maxTokens: number | undefined) => DeepSeekHarness,
  ) {}

  /** Subscribe to controller state transitions. */
  onState(listener: (state: RuntimeState, detail?: string) => void): { dispose(): void } {
    this.emitter.on('state', listener)
    return { dispose: () => this.emitter.off('state', listener) }
  }

  /** Subscribe to every wire notification after it has been routed. */
  onNotification(listener: (notification: HarnessNotification) => void): { dispose(): void } {
    this.emitter.on('notification', listener)
    return { dispose: () => this.emitter.off('notification', listener) }
  }

  /** Subscribe to session-list or title changes. */
  onSessions(listener: (sessions: { id: string; title: string }[]) => void): { dispose(): void } {
    this.emitter.on('sessions', listener)
    return { dispose: () => this.emitter.off('sessions', listener) }
  }

  /** Subscribe to per-session running-state transitions. */
  onStatus(listener: (event: { sessionId: string; running: boolean }) => void): { dispose(): void } {
    this.emitter.on('status', listener)
    return { dispose: () => this.emitter.off('status', listener) }
  }

  /** Current lifecycle state of the owned subprocess. */
  get runtimeState(): RuntimeState {
    return this.state
  }

  /** Ids of every session opened in this controller, in creation order. */
  get sessionIds(): readonly string[] {
    return [...this.sessions.keys()]
  }

  /** The session id most recently interacted with. */
  latestSessionId(): string | undefined {
    let latest: string | undefined
    for (const id of this.sessions.keys()) latest = id
    return latest
  }

  /**
   * Switch the active preset. When the provider or model changes the running
   * subprocess is torn down and re-created on the next prompt so the JSON-RPC
   * `initialize` handshake carries the new route.
   * @returns `true` when a restart is pending.
   */
  async setActivePreset(preset: ApiPreset | undefined): Promise<boolean> {
    const previous = this.activePreset
    this.activePreset = preset
    if (previous === undefined || preset === undefined
      || previous.model !== preset.model || previous.baseURL !== preset.baseURL
      || previous.apiKey !== preset.apiKey) {
      await this.stopProcess()
      return true
    }
    return false
  }

  /** Create a new named session and return its id (no wire traffic until the first prompt). */
  createSession(): string {
    const id = `vscode-${randomUUID().replaceAll('-', '')}`
    this.sessions.set(id, { title: 'New chat', running: false })
    this.emitter.emit('sessions', this.sessionSummaries())
    return id
  }

  /** @returns whether a session exists by id. */
  hasSession(id: string): boolean {
    return this.sessions.has(id)
  }

  /** Display title for a session. */
  titleOf(id: string): string {
    return this.sessions.get(id)?.title ?? id
  }

  /** Whether the session currently has a turn in flight. */
  isRunning(id: string): boolean {
    return this.sessions.get(id)?.running ?? false
  }

  /**
   * Send one prompt and settle when the agent next goes idle. Streaming
   * notifications are emitted as they arrive. Rejects when no preset is
   * selected, the transport fails, or the turn is stopped.
   */
  async prompt(id: string, text: string, onEvent: SessionEventSink): Promise<void> {
    const record = this.sessions.get(id)
    if (record === undefined) throw new Error(`unknown session: ${id}`)
    if (this.activePreset === undefined) throw new Error('select an API preset before sending a message')
    if (record.running) throw new Error(`session already running: ${id}`)

    record.running = true
    this.emitter.emit('status', { sessionId: id, running: true })
    try {
      const harness = await this.ensureStarted()
      const session = harness.session(id)
      let toolCallCount = 0
      const result = await session.run([{ type: 'text', text }], {
        onNotification: (notification) => {
          this.routeNotification(id, notification, onEvent, () => {
            toolCallCount += 1
            if (toolCallCount === 1) record.title = text.slice(0, 60)
          })
        },
      })
      if (result.finalResponse.trim().length > 0 && toolCallCount === 0) {
        record.title = text.slice(0, 60)
      }
      this.emitter.emit('sessions', this.sessionSummaries())
    } finally {
      record.running = false
      this.emitter.emit('status', { sessionId: id, running: false })
    }
  }

  /** Abandon the in-flight turn by terminating the runtime (the wire has no cancel). */
  async stop(id: string): Promise<void> {
    if (!this.isRunning(id)) return
    await this.stopProcess()
  }

  /** Dispose the runtime and all session tracking. */
  async dispose(): Promise<void> {
    await this.stopProcess()
    this.sessions.clear()
  }

  private async ensureStarted(): Promise<DeepSeekHarness> {
    if (this.harness !== undefined) return this.harness
    const preset = this.activePreset
    if (preset === undefined) throw new Error('no active API preset')
    this.setState('starting')
    try {
      const launch = await this.resolver.resolve(this.cwd)
      const harness = this.harnessFactory(launch, preset, this.maxTokens)
      this.harness = harness
      this.attachSubscription(harness)
      await harness.start()
      this.setState('running')
      return harness
    } catch (error) {
      this.harness = undefined
      this.setState('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private attachSubscription(harness: DeepSeekHarness): void {
    if (this.pumpStarted) return
    this.pumpStarted = true
    void (async () => {
      const subscription = harness.client.subscribe()
      this.subscription = subscription
      try {
        for await (const notification of subscription) {
          this.emitter.emit('notification', notification)
        }
      } catch (error) {
        if (this.harness === harness) {
          this.setState('error', error instanceof Error ? error.message : String(error))
        }
      }
    })()
  }

  private routeNotification(
    rootId: string,
    notification: HarnessNotification,
    sink: SessionEventSink,
    onToolCall: () => void,
  ): void {
    if (notification.method === 'session.event' && notification.params.sessionId === rootId) {
      const envelope = notification.params.event as WireEnvelope | undefined
      if (envelope === undefined) return
      if (envelope.type === 'assistant/chunk') {
        const chunk = envelope.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          sink.onAssistantText(chunk.text)
        }
        return
      }
      if (envelope.type === 'tool/call' && typeof envelope.data?.name === 'string') {
        const view: ToolCallView = {
          callId: idToString(envelope.data.callId),
          name: envelope.data.name,
          arguments: typeof envelope.data.arguments === 'string' ? envelope.data.arguments : '',
        }
        onToolCall()
        sink.onToolCall(view)
        return
      }
      if (envelope.type === 'tool/result') {
        sink.onToolResult(
          idToString(envelope.data?.message?.toolCallId),
          envelope.data?.error as { name: string; code: string } | undefined,
        )
        return
      }
      if (envelope.type === 'assistant/message') {
        sink.onAssistantMessage()
      }
      return
    }
    if (notification.method === 'subagent.started') {
      const params = notification.params as { parentSessionId?: string; childSessionId?: string }
      if (params.parentSessionId === rootId && typeof params.childSessionId === 'string') {
        sink.onSubagent(params.childSessionId, false)
      }
      return
    }
    if (notification.method === 'subagent.finished') {
      const params = notification.params as {
        parentSessionId?: string
        childSessionId?: string
        status?: string
      }
      if (params.parentSessionId === rootId && typeof params.childSessionId === 'string') {
        sink.onSubagent(params.childSessionId, true, params.status)
      }
    }
  }

  private async stopProcess(): Promise<void> {
    const harness = this.harness
    const subscription = this.subscription
    this.harness = undefined
    this.subscription = undefined
    this.pumpStarted = false
    subscription?.close()
    for (const [id, record] of this.sessions) {
      if (record.running) {
        record.running = false
        this.emitter.emit('status', { sessionId: id, running: false })
      }
    }
    if (harness !== undefined) {
      this.setState('stopped')
      await harness.close()
    } else {
      this.setState('stopped')
    }
  }

  private setState(state: RuntimeState, detail?: string): void {
    this.state = state
    this.stateDetail = state === 'error' ? detail : undefined
    this.emitter.emit('state', state, this.stateDetail)
  }

  private sessionSummaries() {
    return [...this.sessions.entries()].map(([id, record]) => ({ id, title: record.title }))
  }
}

export interface SessionEventSink {
  onAssistantText(text: string): void
  onAssistantMessage(): void
  onToolCall(call: ToolCallView): void
  onToolResult(callId: string, error?: { name: string; code: string }): void
  onSubagent(childSessionId: string, finished: boolean, status?: string): void
}

interface SessionRecord {
  title: string
  running: boolean
}

function idToString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : typeof value === 'object' && value !== null && 'id' in value
      ? idToString(value.id)
      : ''
}

interface WireEnvelope {
  type: string
  data?: {
    chunk?: { type: string; text?: string }
    name?: string
    callId?: unknown
    arguments?: unknown
    message?: { toolCallId?: unknown }
    error?: unknown
  }
}
