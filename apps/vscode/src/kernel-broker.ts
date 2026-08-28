import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { ExtensionContext } from 'vscode'
import { log, logError } from './log.ts'
import { startWebKernel, type WebKernelHandle } from './kernel.ts'

/**
 * A loopback API client for the extension host: every unary call and event
 * stream is plain fetch/SSE against the web kernel's 127.0.0.1 port. The
 * webview clients never reach the network themselves — the sidebar host half
 * uses this to list and create sessions, and the panel tunnel relays the
 * SPA's own client over postMessage.
 */
class LoopbackApiClient extends AbstractApiClient {
  constructor(private readonly baseUrl: string) {
    super()
  }

  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(new URL(input, this.baseUrl), init)
  }

  /**
   * The base class falls back to the `dsh.internal` fake authority when no
   * `location` exists — the Node case. The loopback client must target the
   * kernel port instead.
   */
  protected override resolveBase(): string {
    return this.baseUrl
  }
}

/** One session row as the sidebar renders it. */
export interface KernelSession {
  id: string
  title: string
  running: boolean
  updatedAt: number
}

/** Listener for kernel lifecycle and session-list changes. */
export interface KernelBrokerListener {
  /** The kernel finished starting and the API is reachable. */
  onReady?(): void
  /** The kernel exited unexpectedly; the broker is disposed. */
  onExit?(): void
  /** The session list changed (create/delete/update observed by polling). */
  onSessions?(sessions: readonly KernelSession[], activeId: string | undefined): void
}

/**
 * Owns the single shared web kernel child process. Both the slim sidebar and
 * the full editor panel draw from one broker so there is exactly one kernel,
 * one port, and one source of session truth. The kernel starts lazily on the
 * first consumer and is disposed when the extension deactivates.
 */
export class KernelBroker {
  private handle: WebKernelHandle | undefined
  private api: LoopbackApiClient | undefined
  private starting: Promise<void> | undefined
  private readonly listeners = new Set<KernelBrokerListener>()
  private pollTimer: NodeJS.Timeout | undefined
  private sessions: KernelSession[] = []
  private activeId: string | undefined
  private listFailed = false
  private disposed = false

  constructor(private readonly context: ExtensionContext, private readonly cwd: string) {}

  /** Whether the kernel has finished starting. */
  get ready(): boolean {
    return this.api !== undefined
  }

  /** The running kernel handle, or undefined before {@link start} resolves. */
  get kernel(): WebKernelHandle | undefined {
    return this.handle
  }

  /** The loopback base URL once ready; throws if called before {@link start}. */
  get baseUrl(): string {
    if (this.handle === undefined) throw new Error('kernel not started')
    return this.handle.baseUrl
  }

  /** Subscribe to broker events; returns the disposer. */
  subscribe(listener: KernelBrokerListener): { dispose(): void } {
    this.listeners.add(listener)
    if (this.api !== undefined) {
      listener.onReady?.()
      listener.onSessions?.(this.sessions, this.activeId)
    }
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  /**
   * Start the kernel once. Concurrent callers share the same promise; the
   * readiness signal fires only after the first session pull succeeds.
   */
  start(): Promise<void> {
    if (this.starting !== undefined) return this.starting
    this.starting = (async (): Promise<void> => {
      log('broker: starting web kernel')
      this.handle = await startWebKernel({
        cwd: this.cwd,
        extensionRoot: this.context.extensionPath,
        onUnexpectedExit: () => {
          this.handle = undefined
          this.api = undefined
          this.stopPolling()
          log('broker: kernel exited unexpectedly; broker marked not-ready')
          for (const listener of this.listeners) listener.onExit?.()
        },
      })
      this.api = new LoopbackApiClient(this.handle.baseUrl)
      await this.refreshSessions()
      this.startPolling()
      log(`broker: kernel ready at ${this.handle.baseUrl}`)
      for (const listener of this.listeners) listener.onReady?.()
    })()
    this.starting.catch((error: unknown) => { logError('broker: kernel start failed', error) })
    return this.starting
  }

  /** The most recent session snapshot. */
  listSessions(): readonly KernelSession[] {
    return this.sessions
  }

  /** The session currently shown in the editor panel, if known. */
  getActiveSession(): string | undefined {
    return this.activeId
  }

  /** Record which session the editor panel is showing (set by the panel). */
  setActiveSession(id: string | undefined): void {
    if (this.activeId === id) return
    this.activeId = id
    this.emitSessions()
  }

  /** Create a new session in the kernel's cwd and return its id. */
  async createSession(): Promise<string> {
    if (this.api === undefined) await this.start()
    const api = this.api
    if (api === undefined) throw new Error('kernel did not start')
    const response = await api.sessions.create({ cwd: this.cwd })
    if (!response.result.ok) throw new Error(response.result.error.message)
    const id = response.result.value.sessionId
    await this.refreshSessions()
    return id
  }

  /** Pull the session list from the kernel and broadcast on change. */
  async refreshSessions(): Promise<void> {
    if (this.api === undefined) return
    const response = await this.api.sessions.list({})
    if (!response.result.ok) {
      if (!this.listFailed) {
        this.listFailed = true
        log(`broker: session.list failed: ${response.result.error.message}`)
      }
      return
    }
    this.listFailed = false
    const next = response.result.value.items
      .map(item => ({
        id: item.sessionId,
        title: deriveTitle(item),
        running: item.running,
        updatedAt: item.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (!sessionListsEqual(this.sessions, next)) {
      this.sessions = next
      this.emitSessions()
    }
  }

  /** Stop polling; used while no panel or sidebar is visible. */
  stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined) return
    this.pollTimer = setInterval(() => {
      void this.refreshSessions().catch(() => { /* kernel transiently unreachable; next poll retries */ })
    }, POLL_INTERVAL_MS)
    this.pollTimer.unref()
  }

  private emitSessions(): void {
    for (const listener of this.listeners) listener.onSessions?.(this.sessions, this.activeId)
  }

  /** Kill the kernel. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopPolling()
    this.listeners.clear()
    if (this.handle !== undefined) await this.handle.dispose()
    this.handle = undefined
    this.api = undefined
  }
}

/** Polling cadence for sidebar/panel session-list freshness. */
const POLL_INTERVAL_MS = 2000

/** Best-effort sidebar title from a session summary. */
function deriveTitle(item: {
  blank: boolean
  cwd?: string
  projections?: { values?: Record<string, unknown> }
}): string {
  const title = item.projections?.values?.title
  if (typeof title === 'string' && title.length > 0) return title
  if (item.blank) return 'New session'
  if (item.cwd !== undefined) return item.cwd
  return 'Session'
}

/** Shallow equality over the ordered session snapshot to suppress broadcast noise. */
function sessionListsEqual(a: readonly KernelSession[], b: readonly KernelSession[]): boolean {
  if (a.length !== b.length) return false
  return a.every((row, index) => {
    const other = b[index]
    if (other === undefined) return false
    return row.id === other.id
      && row.title === other.title
      && row.running === other.running
      && row.updatedAt === other.updatedAt
  })
}
